"""
BCICIV 2b 数据集专用加载器
处理 GDF 1.99 格式的事件编码 (769=左手, 770=右手)
"""

import os
import re
import warnings
import numpy as np
import mne
from scipy.io import loadmat
from typing import Dict, Tuple


# BCICIV 2b 原始事件编码
BCICIV_EVENTS = {
    'left_hand':  769,   # 左手运动
    'right_hand': 770,   # 右手运动
    'eye_move':   276,   # 眼动
    'eye_blink':  277,   # 眨眼
    'new_run':    32766, # 新session开始
}


def load_gdf_file(
    file_path: str,
    sample_rate: int = 100,
    band: Tuple[float, float] = (4.0, 38.0),
    label_dir: str = None,
    rereference: bool = False,
) -> Tuple[mne.io.Raw, np.ndarray]:
    """
    加载单个 BCICIV 2b .gdf 文件并正确提取事件

    Returns:
        raw: MNE Raw 对象 (仅 EEG 通道)
        events: (n_events, 3) 事件数组, [sample, 0, label]
            label: 1=左手, 2=右手
    """
    print(f"加载: {os.path.basename(file_path)}")

    # 读取 GDF
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Highpass cutoff frequency.*",
            category=RuntimeWarning,
        )
        raw = mne.io.read_raw_gdf(file_path, preload=True, verbose='warning')

    # 重命名 EEG 通道 (EEG:C3 → C3)
    rename_map = {}
    for ch in raw.ch_names:
        if ch.startswith('EEG:'):
            rename_map[ch] = ch[4:]  # 'EEG:C3' → 'C3'
    if rename_map:
        raw.rename_channels(rename_map)

    # 只保留 C3, Cz, C4
    eeg_channels = [ch for ch in ['C3', 'Cz', 'C4'] if ch in raw.ch_names]
    if len(eeg_channels) != 3:
        raise ValueError(f"缺少 C3/Cz/C4 通道，实际通道: {raw.ch_names}")
    raw.pick(eeg_channels)

    # A compact 4-38 Hz passband retains the motor-imagery rhythms while
    # removing slow drift and high-frequency noise before neural decoding.
    raw.filter(band[0], band[1], method='iir', verbose=False)
    # Dataset 2b already contains bipolar derivations. Re-referencing these
    # three channels can suppress the lateralized motor-imagery information.
    if rereference:
        raw.set_eeg_reference('average', projection=False, verbose=False)
    if raw.info['sfreq'] != sample_rate:
        raw.resample(sample_rate, npad='auto', verbose=False)

    # 获取注释 → 转换为原始事件编码
    # MNE 会将注释 description 转成字符串，然后分配 ID
    annotations = raw.annotations
    raw_event_codes = []
    for desc in annotations.description:
        try:
            raw_event_codes.append(int(float(desc)))
        except (ValueError, TypeError):
            raw_event_codes.append(-1)
    raw_event_codes = np.array(raw_event_codes)

    # 筛选左手(769)和右手(770)事件
    onset_samples = (annotations.onset * raw.info['sfreq']).astype(np.int64)

    events_list = []
    for onset, raw_code in zip(onset_samples, raw_event_codes):
        if raw_code == 769:
            events_list.append([onset, 0, 1])   # 左手 → label=1
        elif raw_code == 770:
            events_list.append([onset, 0, 2])   # 右手 → label=2

    # Evaluation sessions hide the class behind event 783. The official
    # post-competition MAT files restore labels 1/2 in trial order.
    if not events_list and np.any(raw_event_codes == 783):
        if label_dir is None:
            raise ValueError(
                "Evaluation GDF requires the official MAT labels directory"
            )
        stem = os.path.splitext(os.path.basename(file_path))[0]
        label_path = os.path.join(label_dir, f"{stem}.mat")
        if not os.path.exists(label_path):
            raise FileNotFoundError(f"Official label file not found: {label_path}")
        labels = np.asarray(loadmat(label_path)["classlabel"]).reshape(-1)
        evaluation_onsets = onset_samples[raw_event_codes == 783]
        if len(labels) != len(evaluation_onsets):
            raise ValueError(
                f"Label/event mismatch for {stem}: {len(labels)} labels vs "
                f"{len(evaluation_onsets)} trials"
            )
        events_list = [
            [int(onset), 0, int(label)]
            for onset, label in zip(evaluation_onsets, labels)
        ]

    events = np.array(events_list, dtype=np.int64)

    print(f"  → 通道: {raw.ch_names} | "
          f"左手={int((events[:,2]==1).sum()) if len(events) else 0} | "
          f"右手={int((events[:,2]==2).sum()) if len(events) else 0}")

    return raw, events


def load_all_bciciv(
    data_dir: str,
    tmin: float = 0.5,
    tmax: float = 4.0,
    return_raw_events: bool = False,
    return_metadata: bool = False,
    sample_rate: int = 100,
    split: str = "train",
    label_dir: str = None,
):
    """
    加载所有 BCICIV 2b 训练文件，提取 EEG epochs

    Args:
        data_dir: GDF 文件目录
        tmin: 事件开始时间（相对事件时刻，秒），默认 0.5s 避开运动伪迹
        tmax: 事件结束时间，默认 2.5s 覆盖运动执行期
        return_raw_events: 若 True，同时返回 (raw_list, events_list)

    Returns:
        X: (n_samples, n_channels=3, n_times) float32
        y: (n_samples,) int64  (0=左手, 1=右手)
        [可选] (raws, events_list) 如果 return_raw_events=True
    """
    from pathlib import Path

    split_patterns = {
        "train": "*T.gdf",
        "evaluation": "*E.gdf",
        "all": "*.gdf",
    }
    if split not in split_patterns:
        raise ValueError("split must be one of: train, evaluation, all")
    gdf_files = sorted(Path(data_dir).glob(split_patterns[split]))
    print(f"[BCICIV Loader] 找到 {len(gdf_files)} 个训练文件")

    all_X, all_y = [], []
    raws, events_list = [], []
    all_subjects, all_sessions = [], []

    for file_path in gdf_files:
        try:
            raw, events = load_gdf_file(
                str(file_path),
                sample_rate=sample_rate,
                label_dir=label_dir,
            )

            if len(events) == 0:
                print(f"  [跳过] {file_path.name}: 无有效事件")
                continue

            # 创建 Epochs（baseline = 事件前 200ms，修正基线）
            epochs = mne.Epochs(
                raw,
                events,
                event_id={'left': 1, 'right': 2},
                tmin=tmin, tmax=tmax,
                baseline=None,
                preload=True,
                verbose=False,
            )

            X_subj = epochs.get_data()       # (n, 3, t)
            y_subj = (epochs.events[:, 2] - 1).astype(np.int64)  # 1→0, 2→1

            all_X.append(X_subj.astype(np.float32))
            all_y.append(y_subj)
            raws.append(raw)
            events_list.append(events)
            subject_id, session_id = _parse_recording_id(file_path.stem)
            all_subjects.extend([subject_id] * len(y_subj))
            all_sessions.extend([session_id] * len(y_subj))

        except Exception as e:
            print(f"  [错误] {file_path.name}: {e}")

    if not all_X:
        raise RuntimeError("没有成功加载任何数据！")

    X = np.vstack(all_X)
    y = np.concatenate(all_y)

    n_left  = int((y == 0).sum())
    n_right = int((y == 1).sum())
    print(f"\n[BCICIV Loader] 总计: {len(y)} epochs | "
          f"左手={n_left} | 右手={n_right} | shape={X.shape}")

    metadata: Dict[str, np.ndarray] = {
        'subjects': np.asarray(all_subjects),
        'sessions': np.asarray(all_sessions),
    }
    if return_raw_events and return_metadata:
        return X, y, raws, events_list, metadata
    if return_raw_events:
        return X, y, raws, events_list
    if return_metadata:
        return X, y, metadata
    return X, y


def load_single_session(
    file_path: str,
    tmin: float = 0.5,
    tmax: float = 4.0,
    sample_rate: int = 100,
) -> Tuple[np.ndarray, np.ndarray]:
    """加载单个 .gdf 文件的 epochs"""
    raw, events = load_gdf_file(file_path, sample_rate=sample_rate)

    if len(events) == 0:
        return np.array([]), np.array([])

    epochs = mne.Epochs(
        raw, events,
        event_id={'left': 1, 'right': 2},
        tmin=tmin, tmax=tmax,
        baseline=None,
        preload=True,
        verbose=False,
    )

    X = epochs.get_data().astype(np.float32)
    y = (epochs.events[:, 2] - 1).astype(np.int64)

    return X, y


def _parse_recording_id(stem: str) -> Tuple[str, str]:
    """Parse B0103T into subject B01 and session B0103."""
    match = re.match(r'^(B\d{2})(\d{2})[TE]$', stem, flags=re.IGNORECASE)
    if not match:
        return stem, stem
    return match.group(1).upper(), f"{match.group(1)}{match.group(2)}".upper()


if __name__ == '__main__':
    # 快速测试
    X, y = load_all_bciciv(r'D:\db\BCICIV_2b_gdf')
    print(f"\n快速测试通过! X={X.shape}, y={y.shape}")
