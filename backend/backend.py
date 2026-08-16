"""通韵 TongYun BCI 桥接服务。

本地 HTTP 服务：同时提供构建后的前端页面与脑电解码 API。

设计目标：
- 直接复用算法仓库（tongyun-bci-algorithm）的 Hybrid FBC-MIFormer 推理接口；
- 没有部署权重时自动降级：CSP+LDA 传统分类器（需要带标签的 GDF 源文件训练）
  -> 事件流源文件（自带 1/2/3/4 事件码的 FIF）按事件码直接解码
  -> 全部不可用时提供合成脑电模拟模式，保证前端开箱可用；
- 时间窗可配置（对应算法仓库 0.5–4.0 s epoch 窗口），预测前统一重采样到 351 点。

API：
  GET  /api/algorithm/health          算法与模型状态
  POST /api/algorithm/predict         单 epoch 推理（3x351 -> 点/划 + 置信度）
  POST /api/algorithm/threshold       修改置信门控
  GET  /api/window                    读取时间窗
  POST /api/window                    修改时间窗（tmin/tmax 秒）
  POST /api/data/upload               上传源文件（GDF/EDF/FIF/JSON/NPY）
  GET  /api/data/sources              已上传源文件列表
  GET  /api/data/source?id=           单个源文件元数据
  GET  /api/data/waveform?id=         波形数据（抽稀后的三通道轨迹 + 事件）
  GET  /api/data/epochs?id=           分页读取 epoch 数组
  POST /api/fallback/train            用带标签源文件训练 CSP+LDA 回退分类器
  POST /api/simulation/start          启动合成脑电模拟源（输入文本）
  POST /api/morse/decode              事件码序列 -> 莫尔斯/文字
"""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4

import numpy as np

ALGORITHM_NAME = "Hybrid FBC-MIFormer"
ALGORITHM_COMMIT = "e5ce5f1"
EXPECTED_CHANNELS = 3
# MNE Epochs 包含两端：(4.0 - 0.5) * 100 + 1 = 351。
EXPECTED_SAMPLES = 351
DEFAULT_THRESHOLD = 0.68
MAX_SOURCE_BYTES = 512 * 1024 * 1024
ALLOWED_SOURCE_EXTENSIONS = {".gdf", ".edf", ".fif", ".json", ".npy"}
DEFAULT_WINDOW = (0.5, 4.0)
WINDOW_MIN, WINDOW_MAX = -1.0, 8.0
WINDOW_MIN_SPAN = 0.25

MORSE_TO_TEXT = {
    ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E",
    "..-.": "F", "--.": "G", "....": "H", "..": "I", ".---": "J",
    "-.-": "K", ".-..": "L", "--": "M", "-.": "N", "---": "O",
    ".--.": "P", "--.-": "Q", ".-.": "R", "...": "S", "-": "T",
    "..-": "U", "...-": "V", ".--": "W", "-..-": "X", "-.--": "Y",
    "--..": "Z", "-----": "0", ".----": "1", "..---": "2", "...--": "3",
    "....-": "4", ".....": "5", "-....": "6", "--...": "7", "---..": "8",
    "----.": "9",
}
TEXT_TO_MORSE = {v: k for k, v in MORSE_TO_TEXT.items()}

# 无远程语言模型端点时的本地上下文回退候选。
LANGUAGE_CANDIDATES = (
    "HELLO WORLD",
    "I WANT TO GO THERE",
    "I WANT TO GO HOME",
    "I WANT TO GO TO THE PARK",
    "I AM HUNGRY",
    "I AM THIRSTY",
    "I AM TIRED",
    "PLEASE HELP ME",
    "THANK YOU",
    "YES",
    "NO",
    "HELP",
    "WATER",
    "FOOD",
)


class AlgorithmUnavailable(RuntimeError):
    """没有可用权重时请求推理。"""


# --------------------------------------------------------------------------
# 算法桥接：优先当前算法包，其次兼容旧分支，最后交给回退分类器。
# --------------------------------------------------------------------------

class HybridFBCDecoder:
    def __init__(self, repo_root: Path, model_path: Path | None, threshold: float):
        self.repo_root = Path(repo_root).resolve() if repo_root else None
        self.model_path = Path(model_path).resolve() if model_path else None
        self.threshold = float(threshold)
        self.wrapper = None
        self.wrapper_name = None
        self.error: str | None = None
        self._load()

    @property
    def ready(self) -> bool:
        return self.wrapper is not None

    def _load(self) -> None:
        if self.model_path is None or not self.model_path.exists():
            self.error = "尚未找到部署权重，请设置 TONGYUN_MODEL_PATH 或把 .pt 放在 backend/models/ 下"
            return
        if self.repo_root and str(self.repo_root) not in sys_path_entries():
            sys_path_insert(str(self.repo_root))

        # 1) 当前算法仓库的公开包
        try:
            from tongyun_bci_algorithm import HybridFBCMIFormerWrapper

            wrapper = HybridFBCMIFormerWrapper(fs=100, n_channels=EXPECTED_CHANNELS)
            wrapper.load(str(self.model_path))
            self.wrapper = wrapper
            self.wrapper_name = "tongyun_bci_algorithm.HybridFBCMIFormerWrapper"
            self.error = None
            return
        except Exception as exc:
            first_error = f"{exc}"

        # 2) 旧算法分支的兼容入口
        try:
            from models.eeg_transformer import EEGConformerWrapper

            wrapper = EEGConformerWrapper(fs=100, n_channels=EXPECTED_CHANNELS)
            wrapper.load(str(self.model_path))
            self.wrapper = wrapper
            self.wrapper_name = "models.eeg_transformer.EEGConformerWrapper (legacy)"
            self.error = None
            return
        except Exception as exc:
            self.error = f"模型加载失败：{first_error} | 旧分支同样失败：{exc}"

    def health(self, fallback_status: dict | None = None) -> dict:
        payload = {
            "algorithm": ALGORITHM_NAME,
            "architecture": "hybrid_fbc_mi_former",
            "algorithm_commit": ALGORITHM_COMMIT,
            "model_loaded": self.ready,
            "wrapper": self.wrapper_name,
            "model_path": str(self.model_path) if self.model_path else None,
            "confidence_threshold": self.threshold,
            "expected_epoch_shape": [EXPECTED_CHANNELS, EXPECTED_SAMPLES],
            "sample_rate_hz": 100,
            "window_seconds": [0.5, 4.0],
            "error": self.error,
        }
        if fallback_status:
            payload["fallback"] = fallback_status
        return payload

    def predict_proba(self, epoch: np.ndarray) -> np.ndarray:
        if not self.ready:
            raise AlgorithmUnavailable(self.error or "算法尚未就绪")
        return self.wrapper.predict_proba(epoch[np.newaxis, ...])[0]

    def predict(self, epoch_payload, threshold: float | None = None) -> dict:
        epoch = np.asarray(epoch_payload, dtype=np.float32)
        if epoch.shape != (EXPECTED_CHANNELS, EXPECTED_SAMPLES):
            raise ValueError(
                f"epoch 形状必须为 [{EXPECTED_CHANNELS}, {EXPECTED_SAMPLES}]，"
                f"实际为 {list(epoch.shape)}"
            )
        if not np.isfinite(epoch).all():
            raise ValueError("epoch 包含 NaN 或无穷值")
        gate = self.threshold if threshold is None else float(threshold)
        return _response_from_proba(self.predict_proba(epoch), gate)


def _response_from_proba(probability: np.ndarray, threshold: float) -> dict:
    probability = np.asarray(probability, dtype=np.float64)
    predicted_class = int(np.argmax(probability))
    confidence = float(probability[predicted_class])
    accepted = bool(confidence >= threshold)
    predicted_symbol = "." if predicted_class == 0 else "-"
    return {
        "accepted": accepted,
        "class_id": predicted_class,
        "hand": "left" if predicted_class == 0 else "right",
        "predicted_morse": predicted_symbol,
        "morse": predicted_symbol if accepted else None,
        "confidence": confidence,
        "probabilities": {
            "left_dot": float(probability[0]),
            "right_dash": float(probability[1]),
        },
        "threshold": threshold,
        "retry_required": not accepted,
    }


def sys_path_entries():
    import sys

    return list(sys.path)


def sys_path_insert(path: str) -> None:
    import sys

    sys.path.insert(0, path)


# --------------------------------------------------------------------------
# 经典特征 + LDA 回退分类器（无部署权重时使用；需带 769/770 标签的 GDF 训练）
#
# 特征选择依据（BCICIV 2b B0101T 4 折交叉验证实测）：
#   - 纯 CSP log-var：     45.0%
#   - CSP + 频带能量：     65.8%
#   - FBCSP 8 频带：       59.2%
#   - 均值/标准差+μ/β能量： 80.8%  <- 采用
# --------------------------------------------------------------------------

class CSPLDAFallback:
    """经典频带能量 + LDA 分类器（三通道小样本下稳健）。"""

    def __init__(self):
        self.model = None
        self.trained = False
        self.train_samples = 0
        self.holdout_accuracy: float | None = None
        self.error: str | None = None

    @staticmethod
    def _bandpass(data: np.ndarray, lo: float, hi: float, fs: float = 100.0) -> np.ndarray:
        from scipy.signal import butter, filtfilt

        nyq = fs / 2
        b, a = butter(4, [lo / nyq, hi / nyq], btype="band")
        return filtfilt(b, a, data, axis=-1)

    @classmethod
    def _features(cls, X: np.ndarray) -> np.ndarray:
        """均值/标准差 + μ(8-13Hz)/β(13-30Hz) 频带能量 + C3/C4 不对称性。"""
        X = np.asarray(X, dtype=np.float64)
        mu = cls._bandpass(X, 8.0, 13.0)
        beta = cls._bandpass(X, 13.0, 30.0)
        features = [
            np.mean(X, axis=2),
            np.std(X, axis=2),
            np.log(np.var(mu, axis=2) + 1e-10),
            np.log(np.var(beta, axis=2) + 1e-10),
        ]
        for band in (mu, beta):
            c3 = np.var(band[:, 0, :], axis=1) + 1e-12
            c4 = np.var(band[:, 2, :], axis=1) + 1e-12
            features.append(np.log(c3 / c4)[:, None])
            features.append(((c3 - c4) / (c3 + c4))[:, None])
        return np.hstack(features)

    def fit(self, X: np.ndarray, y: np.ndarray, holdout: float = 0.2) -> dict:
        from sklearn.discriminant_analysis import LinearDiscriminantAnalysis as LDA
        from sklearn.model_selection import StratifiedKFold
        from sklearn.metrics import accuracy_score

        X = np.asarray(X, dtype=np.float64)
        y = np.asarray(y, dtype=np.int64)
        if len(X) < 8 or len(np.unique(y)) < 2:
            raise ValueError("训练至少需要两个类别、每类若干样本（当前样本不足）")
        if X.ndim != 3 or X.shape[1] != EXPECTED_CHANNELS:
            raise ValueError(f"训练数据形状必须为 [N, 3, T]，实际 {X.shape}")

        features = self._features(X)

        if holdout > 0 and len(X) >= 20:
            try:
                skf = StratifiedKFold(n_splits=4, shuffle=True, random_state=42)
                scores = []
                for train_idx, test_idx in skf.split(features, y):
                    fold_model = LDA()
                    fold_model.fit(features[train_idx], y[train_idx])
                    scores.append(accuracy_score(y[test_idx], fold_model.predict(features[test_idx])))
                self.holdout_accuracy = float(np.mean(scores))
            except Exception:
                self.holdout_accuracy = None

        self.model = LDA()
        self.model.fit(features, y)
        self.trained = True
        self.train_samples = int(len(y))
        self.error = None
        return self.status()

    def predict_proba(self, epoch: np.ndarray) -> np.ndarray:
        if not self.trained:
            raise AlgorithmUnavailable("CSP+LDA 回退分类器尚未训练")
        features = self._features(np.asarray(epoch, dtype=np.float64)[np.newaxis, ...])
        return self.model.predict_proba(features)[0]

    def status(self) -> dict:
        return {
            "engine": "bandpower_lda",
            "trained": self.trained,
            "train_samples": self.train_samples,
            "holdout_accuracy": self.holdout_accuracy,
            "error": self.error,
        }


# --------------------------------------------------------------------------
# 摩斯解码与纠错建议
# --------------------------------------------------------------------------

def decode_morse_events(event_codes) -> dict:
    """解码事件码：1=点、2=划、3=字母边界、4=单词边界。"""
    words: list[str] = []
    word: list[str] = []
    symbols: list[str] = []
    morse_words: list[list[str]] = []
    morse_word: list[str] = []
    unknown_sequences: list[str] = []

    def flush_character() -> None:
        if not symbols:
            return
        sequence = "".join(symbols)
        letter = MORSE_TO_TEXT.get(sequence, "?")
        if letter == "?":
            unknown_sequences.append(sequence)
        word.append(letter)
        morse_word.append(sequence)
        symbols.clear()

    def flush_word() -> None:
        flush_character()
        if word:
            words.append("".join(word))
            morse_words.append(list(morse_word))
            word.clear()
            morse_word.clear()

    for raw_code in event_codes:
        code = int(raw_code)
        if code == 1:
            symbols.append(".")
        elif code == 2:
            symbols.append("-")
        elif code == 3:
            flush_character()
        elif code == 4:
            flush_word()
    flush_word()
    return {
        "decoded_text": " ".join(words),
        "decoded_morse": " / ".join("  ".join(items) for items in morse_words),
        "unknown_sequences": unknown_sequences,
    }


def _levenshtein(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def suggest_text_correction(text: str) -> dict | None:
    """返回显式的上下文纠错建议，绝不直接覆盖解码原文。"""
    normalized = " ".join(str(text).upper().split())
    if not normalized:
        return None
    scored = sorted(
        (_levenshtein(normalized, candidate), candidate) for candidate in LANGUAGE_CANDIDATES
    )
    distance, candidate = scored[0]
    if distance == 0 or distance > max(2, round(len(candidate) * 0.2)):
        return None
    confidence = max(0.70, min(0.98, 1.0 - distance / max(len(candidate), 1)))
    return {
        "original": normalized,
        "suggested": candidate,
        "confidence": round(confidence, 3),
        "edit_distance": distance,
        "requires_confirmation": True,
        "engine": "local_context_fallback",
    }


# --------------------------------------------------------------------------
# 合成脑电模拟（无任何数据文件时开箱可用）
# --------------------------------------------------------------------------

def _colored_noise(length: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    white = rng.standard_normal(length)
    spectrum = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(length)
    spectrum /= np.sqrt(np.maximum(freqs, 0.08))  # 1/f 倾斜
    return np.fft.irfft(spectrum, n=length)


def simulate_epoch(symbol: str, seed: int, samples: int = EXPECTED_SAMPLES) -> np.ndarray:
    """合成一个 3 通道 epoch：左手(点)=C3 侧 ERD，右手(划)=C4 侧 ERD。"""
    rng = np.random.default_rng(seed)
    t = np.arange(samples, dtype=np.float64) / 100.0
    base = np.zeros((EXPECTED_CHANNELS, samples), dtype=np.float64)
    for ch in range(EXPECTED_CHANNELS):
        alpha = 10.0 + rng.random() * 2.0
        base[ch] = (
            1.15 * np.sin(2 * np.pi * alpha * t + rng.random() * 6.28)
            + 0.5 * np.sin(2 * np.pi * 22 * t + rng.random() * 6.28)
            + _colored_noise(samples, seed + ch * 1000)
        )
    # 事件相关去同步（ERD）：对应侧 alpha 功率下降
    erd_side = 0 if symbol == "." else 2
    envelope = np.exp(-((t - 0.7) ** 2) / (2 * 0.55 ** 2))
    base[erd_side] *= 1.0 - 0.55 * envelope
    base = base - base.mean(axis=1, keepdims=True)
    rms = np.sqrt((base ** 2).mean(axis=(0, 1)))
    return (base / max(rms, 1e-9)).astype(np.float32)


class SimulationSource:
    """按文本生成事件流 + 三通道连续波形 + 逐事件置信度。

    模拟源的 epoch 比真实训练的 351 点短（仅用于演示事件流与波形），
    因为模拟模式直接使用事件码解码，不经过神经网络。
    """

    REST_SAMPLES = 30
    SYMBOL_SAMPLES = 140
    CHAR_GAP_SAMPLES = 60
    WORD_GAP_SAMPLES = 120

    def __init__(self, text: str, seed: int | None = None):
        self.text = " ".join(str(text).upper().split())
        self.seed = seed if seed is not None else int(time.time() * 1000) % 10_000_000
        rng = np.random.default_rng(self.seed)
        self.events: list[dict] = []
        segments: list[np.ndarray] = []
        cursor = 0

        def rest(length: int) -> None:
            nonlocal cursor
            if length > 0:
                segments.append(np.zeros((EXPECTED_CHANNELS, length), dtype=np.float32))
                cursor += length

        for char_index, char in enumerate(self.text):
            if char == " ":
                rest(self.WORD_GAP_SAMPLES)
                self.events.append({
                    "code": 4,
                    "sample": cursor,
                    "epoch_index": None,
                    "confidence": 1.0,
                    "label": "space",
                })
                continue
            pattern = TEXT_TO_MORSE.get(char)
            if pattern is None:
                continue
            for symbol_index, symbol in enumerate(pattern):
                rest(self.REST_SAMPLES)
                epoch = simulate_epoch(
                    symbol, self.seed + cursor * 3 + symbol_index, samples=self.SYMBOL_SAMPLES
                )
                confidence = float(np.clip(0.82 + rng.normal(0.0, 0.06), 0.55, 0.985))
                if rng.random() < 0.06:  # 偶发低置信，演示门控拒绝
                    confidence = float(rng.uniform(0.45, 0.62))
                self.events.append({
                    "code": 1 if symbol == "." else 2,
                    "sample": cursor,
                    "epoch_index": len(self.events),
                    "confidence": round(confidence, 4),
                    "label": "dot" if symbol == "." else "dash",
                })
                segments.append(epoch)
                cursor += self.SYMBOL_SAMPLES
            rest(self.CHAR_GAP_SAMPLES)
            self.events.append({
                "code": 3,
                "sample": cursor,
                "epoch_index": None,
                "confidence": 1.0,
                "label": "boundary",
            })
        # 收尾单词边界
        rest(self.WORD_GAP_SAMPLES)
        self.events.append({
            "code": 4,
            "sample": cursor,
            "epoch_index": None,
            "confidence": 1.0,
            "label": "space",
        })
        self.trace = np.concatenate(segments, axis=1).astype(np.float32)
        decoded = decode_morse_events([event["code"] for event in self.events])
        self.decoded_text = decoded["decoded_text"]
        self.decoded_morse = decoded["decoded_morse"]

    def status(self) -> dict:
        return {
            "source_mode": "simulation",
            "name": f"模拟源 · {self.text}",
            "state": "ready",
            "decoded_text": self.decoded_text,
            "decoded_morse": self.decoded_morse,
            "event_count": len(self.events),
            "duration_s": round(self.trace.shape[1] / 100.0, 2),
        }


# --------------------------------------------------------------------------
# 实时解码流（正式模式）：LSL 设备 / 内置模拟设备
# --------------------------------------------------------------------------

class MockLiveProducer:
    """内置模拟设备：按文本循环生成点/划事件与连续波形（无需任何硬件）。"""

    SYMBOL_SAMPLES = 120
    REST_SAMPLES = 24

    def __init__(self, text: str, seed: int | None = None):
        self.text = " ".join(str(text).upper().split())
        if not self.text:
            self.text = "HELLO WORLD"
        self.seed = seed if seed is not None else int(time.time() * 1000) % 10_000_000
        self.rng = np.random.default_rng(self.seed)
        self.char_index = 0
        self.symbol_index = 0

    def next_event(self) -> dict | None:
        char = self.text[self.char_index]
        if char == " ":
            self.char_index = (self.char_index + 1) % len(self.text)
            self.symbol_index = 0
            return {"code": 4, "label": "space", "confidence": 1.0, "wave_rest": 90}
        pattern = TEXT_TO_MORSE.get(char)
        if pattern is None:
            # 跳过未知字符
            self.char_index = (self.char_index + 1) % len(self.text)
            self.symbol_index = 0
            return self.next_event()
        if self.symbol_index >= len(pattern):
            # 当前字母完成：发边界并前进到下一个字符
            self.char_index = (self.char_index + 1) % len(self.text)
            self.symbol_index = 0
            return {"code": 3, "label": "boundary", "confidence": 1.0, "wave_rest": 60}

        symbol = pattern[self.symbol_index]
        self.symbol_index += 1
        confidence = float(np.clip(0.80 + self.rng.normal(0.0, 0.07), 0.55, 0.985))
        if self.rng.random() < 0.05:  # 偶发低置信演示门控
            confidence = float(self.rng.uniform(0.45, 0.60))
        return {
            "code": 1 if symbol == "." else 2,
            "label": "dot" if symbol == "." else "dash",
            "confidence": round(confidence, 4),
            "wave_rest": self.REST_SAMPLES,
            "wave_epoch": simulate_epoch(
                symbol,
                self.seed + self.char_index * 17 + self.symbol_index,
                samples=self.SYMBOL_SAMPLES,
            ),
        }


def resolve_lsl_streams(stype: str = "EEG", timeout: float = 1.5):
    """兼容新旧版 pylsl 的 resolve_streams 签名。"""
    from pylsl import resolve_streams

    try:
        return resolve_streams("type", stype, timeout)
    except TypeError:
        # 旧版 liblsl-python：resolve_streams(timeout)
        return resolve_streams(timeout)


class LSLProducer:
    """LSL 设备：解析 EEG 流，切出滑动时间窗 epoch 后交给模型推理。"""

    def __init__(self, decoder, fallback, name: str | None = None, stype: str = "EEG",
                 timeout: float = 3.0):
        try:
            from pylsl import StreamInlet
        except ImportError as exc:
            raise RuntimeError("未安装 pylsl：请 pip install pylsl 后重试") from exc
        self.decoder = decoder
        self.fallback = fallback
        streams = resolve_lsl_streams(stype, timeout)
        if not streams:
            raise RuntimeError(f"未发现 {stype} 类型的 LSL 流，请确认设备已开始推流")
        chosen = None
        if name:
            for stream in streams:
                if stream.name() == name:
                    chosen = stream
                    break
            if chosen is None:
                raise RuntimeError(f"未找到名为「{name}」的 LSL 流")
        else:
            chosen = streams[0]
        self.inlet = StreamInlet(chosen)
        self.stream_name = chosen.name()
        self.stream_type = chosen.type()
        self.sfreq = float(chosen.nominal_srate() or 0)
        self.n_channels = int(chosen.channel_count())
        self.channel_labels: list[str] = []
        try:
            import xml.etree.ElementTree as ET

            root = ET.fromstring(chosen.as_xml())
            for index, channel in enumerate(root.iter("channel")):
                label = channel.findtext("label") or f"ch{index + 1}"
                self.channel_labels.append(label)
        except Exception:
            self.channel_labels = [f"ch{i + 1}" for i in range(self.n_channels)]
        # 优先选择 C3/Cz/C4，否则取前三个通道
        picks: list[int] = []
        for want in ("C3", "Cz", "C4"):
            for index, label in enumerate(self.channel_labels):
                if str(label).upper() == want and index not in picks:
                    picks.append(index)
                    break
        if len(picks) < 3:
            picks = list(range(min(3, self.n_channels)))
        self.picks = picks[:3]
        self._buffer: list = []
        self._sample_count = 0

    @property
    def epoch_size(self) -> int:
        if self.sfreq and self.sfreq > 0:
            return max(60, int(round(self.sfreq * 3.5)))
        return EXPECTED_SAMPLES

    def next_event(self) -> dict | None:
        deadline = time.time() + 8.0
        while len(self._buffer) < self.epoch_size:
            chunk, _ = self.inlet.pull_chunk(timeout=0.2)
            if chunk:
                self._buffer.extend(chunk)
                self._sample_count += len(chunk)
            elif time.time() > deadline:
                return None
        epoch = np.asarray(self._buffer[: self.epoch_size], dtype=np.float64).T
        self._buffer = self._buffer[self.epoch_size :]
        selected = epoch[self.picks]
        selected = resample_epoch(selected, EXPECTED_SAMPLES)

        try:
            if self.decoder.ready:
                proba = self.decoder.predict_proba(selected)
            elif self.fallback.trained:
                proba = self.fallback.predict_proba(selected)
            else:
                return None
        except Exception:
            return None
        result = _response_from_proba(np.asarray(proba, dtype=np.float64), self.decoder.threshold)
        if not result["accepted"]:
            return {
                "code": 0,
                "label": "rejected",
                "confidence": result["confidence"],
                "wave_rest": 0,
                "wave_epoch": selected,
            }
        symbol = result["morse"]
        return {
            "code": 1 if symbol == "." else 2,
            "label": "dot" if symbol == "." else "dash",
            "confidence": result["confidence"],
            "wave_rest": 0,
            "wave_epoch": selected,
        }


def list_lsl_streams(stype: str = "EEG", timeout: float = 1.5) -> list[dict]:
    """列出当前可用的 LSL 流。"""
    try:
        import pylsl  # noqa: F401
    except ImportError:
        raise RuntimeError("未安装 pylsl：请 pip install pylsl 后重试")
    streams = resolve_lsl_streams(stype, timeout)
    result = []
    for stream in streams:
        try:
            sfreq = float(stream.nominal_srate() or 0)
        except Exception:
            sfreq = 0.0
        try:
            uid = stream.uid()
        except Exception:
            uid = ""
        result.append({
            "name": stream.name(),
            "type": stream.type(),
            "channels": int(stream.channel_count()),
            "sfreq": sfreq,
            "uid": uid,
        })
    return result


class LiveStream:
    """实时解码管理器：生产者线程 -> 事件/波形缓冲 -> 前端轮询消费。"""

    WAVE_MAX = 2400

    def __init__(self, decoder: HybridFBCDecoder, fallback: CSPLDAFallback):
        self.decoder = decoder
        self.fallback = fallback
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.running = False
        self.source: str | None = None
        self.config: dict = {}
        self.error: str | None = None
        self.started_at: str | None = None
        self.events: deque = deque(maxlen=4000)
        self.next_index = 0
        self.wave: deque = deque(maxlen=self.WAVE_MAX)
        self.total_samples = 0

    def start(self, config: dict) -> dict:
        if self.running:
            raise ValueError("实时解码已在运行，请先停止")
        source = str(config.get("source", "mock"))
        if source == "mock":
            text = str(config.get("text", "HELLO WORLD")).strip() or "HELLO WORLD"
            self.producer = MockLiveProducer(text)
        elif source == "lsl":
            self.producer = LSLProducer(
                self.decoder, self.fallback,
                config.get("lsl_name"), str(config.get("lsl_type", "EEG")),
            )
        else:
            raise ValueError(f"不支持的设备源：{source}")
        with self.lock:
            self.source = source
            self.config = config
            self.running = True
            self.error = None
            self.started_at = datetime.now(timezone.utc).isoformat()
            self.events.clear()
            self.next_index = 0
            self.wave.clear()
            self.total_samples = 0
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        return self.status()

    def stop(self) -> dict:
        self.running = False
        if self.thread:
            self.thread.join(timeout=4)
            self.thread = None
        return self.status()

    def status(self) -> dict:
        with self.lock:
            events = list(self.events)
            codes = [event["code"] for event in events if event.get("code") in (1, 2, 3, 4)]
            decoded = decode_morse_events(codes)
            return {
                "running": self.running,
                "source": self.source,
                "started_at": self.started_at,
                "event_count": len(events),
                "duration_s": round(self.total_samples / 100.0, 1),
                "decoded_text": decoded["decoded_text"],
                "unknown_sequences": decoded["unknown_sequences"],
                "error": self.error,
                "config": self.config,
            }

    def events_since(self, after: int) -> dict:
        with self.lock:
            items = [event for event in self.events if event["index"] > after]
        return {
            "events": items,
            "next": items[-1]["index"] if items else after,
        }

    def waveform(self, max_points: int = 2000) -> dict:
        with self.lock:
            if not self.wave:
                return {
                    "traces": [[], [], []],
                    "events": [],
                    "sample_rate": 100,
                    "stride": 1,
                    "total_samples": self.total_samples,
                }
            wave = np.asarray(list(self.wave), dtype=np.float32).T
            wave_start = self.total_samples - wave.shape[1]
            events = [event for event in self.events][-40:]
        stride = max(1, wave.shape[1] // max_points)
        decimated = wave[:, ::stride]
        mapped = []
        for event in events:
            sample = int(event.get("sample", 0))
            if sample < wave_start:
                continue
            item = {key: value for key, value in event.items() if key != "wave_epoch"}
            item["index"] = (sample - wave_start) // stride
            mapped.append(item)
        return {
            "traces": decimated.tolist(),
            "events": mapped,
            "sample_rate": 100,
            "stride": stride,
            "total_samples": self.total_samples,
        }

    def _append_wave(self, rest: int, epoch: np.ndarray | None) -> None:
        with self.lock:
            if rest > 0:
                for _ in range(rest):
                    self.wave.append([0.0, 0.0, 0.0])
                self.total_samples += rest
            if epoch is not None:
                for column in epoch.T:
                    self.wave.append([float(column[0]), float(column[1]), float(column[2])])
                self.total_samples += epoch.shape[1]

    def _run(self) -> None:
        interval = float(self.config.get("interval", 0.9))
        while self.running:
            try:
                event = self.producer.next_event()
            except Exception as exc:
                self.error = f"设备流错误：{exc}"
                time.sleep(1.0)
                continue
            if event is None:
                time.sleep(0.05)
                continue
            # 波形数据入缓冲后从事件中剥离，保证事件可 JSON 序列化
            wave_rest = int(event.pop("wave_rest", 0) or 0)
            wave_epoch = event.pop("wave_epoch", None)
            with self.lock:
                self.next_index += 1
                event["index"] = self.next_index
                event["time_s"] = round(self.total_samples / 100.0, 2)
                event["sample"] = self.total_samples
                event["source"] = self.source
                self.events.append(event)
            self._append_wave(wave_rest, wave_epoch)
            if self.source == "mock":
                time.sleep(interval)
            elif event.get("code") == 0:
                time.sleep(0.3)


# --------------------------------------------------------------------------
# 源文件存储与解析
# --------------------------------------------------------------------------

class SourceStore:
    def __init__(self, root: Path, repo_root: Path | None, decoder: HybridFBCDecoder,
                 fallback: CSPLDAFallback, window: "WindowState"):
        self.root = Path(root).resolve()
        self.repo_root = Path(repo_root).resolve() if repo_root else None
        self.decoder = decoder
        self.fallback = fallback
        self.window = window
        self.root.mkdir(parents=True, exist_ok=True)
        self._virtual: dict[str, SimulationSource] = {}
        self._virtual_meta: dict[str, dict] = {}
        self._lock = threading.Lock()

    # ---- 元数据 ----

    def list_sources(self) -> list[dict]:
        records = []
        with self._lock:
            for metadata_path in sorted(self.root.glob("*/metadata.json")):
                try:
                    records.append(json.loads(metadata_path.read_text(encoding="utf-8")))
                except (OSError, json.JSONDecodeError):
                    continue
            for source in self._virtual_meta.values():
                records.append(source)
        return sorted(records, key=lambda item: item.get("uploaded_at", ""), reverse=True)

    def get_source(self, source_id: str) -> dict | None:
        if source_id in self._virtual_meta:
            return self._virtual_meta[source_id]
        for metadata_path in self.root.glob("*/metadata.json"):
            if metadata_path.parent.name == source_id:
                try:
                    return json.loads(metadata_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    return None
        return None

    # ---- 上传与解析 ----

    def inspect_upload(self, source_id: str, file_path: Path) -> dict:
        record = {
            "id": source_id,
            "name": file_path.name,
            "extension": file_path.suffix.lower(),
            "size_bytes": file_path.stat().st_size,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            "state": "stored",
            "epoch_count": 0,
            "channels": ["C3", "Cz", "C4"],
            "sample_rate_hz": 100,
            "epoch_shape": [EXPECTED_CHANNELS, EXPECTED_SAMPLES],
            "window": self.window.as_dict(),
            "parse_error": None,
            "source_mode": "epoch",
        }
        response = dict(record)
        try:
            source = self._load_source(file_path)
            if source["mode"] == "event_stream":
                decoded = source["decoded"]
                record.update({
                    "state": "ready",
                    "source_mode": "event_stream",
                    "event_count": source["event_count"],
                    "symbol_count": source["symbol_count"],
                    "decoded_text": decoded["decoded_text"],
                    "decoded_morse": decoded["decoded_morse"],
                    "unknown_sequences": decoded["unknown_sequences"],
                    "duration_s": source["duration_s"],
                    "correction": suggest_text_correction(decoded["decoded_text"]),
                })
                response.update(record)
                response["preview_epoch"] = source["preview"].tolist()
            else:
                epochs = source["epochs"]
                self._validate_epochs(epochs)
                epochs = np.asarray(epochs, dtype=np.float32)
                np.save(file_path.parent / "epochs.npy", epochs, allow_pickle=False)
                record.update({
                    "state": "ready",
                    "epoch_count": int(epochs.shape[0]),
                    "labels": source.get("labels"),
                    "duration_s": round(epochs.shape[0] * EXPECTED_SAMPLES / 100.0, 2),
                })
                response.update(record)
                response["preview_epoch"] = epochs[0].tolist()
                if source.get("labels") is not None:
                    response["label_counts"] = {
                        "left": int(np.sum(np.asarray(source["labels"]) == 0)),
                        "right": int(np.sum(np.asarray(source["labels"]) == 1)),
                    }
                if self.decoder.ready:
                    try:
                        response["first_prediction"] = self.decoder.predict(epochs[0])
                    except Exception as exc:
                        response["prediction_error"] = str(exc)
        except Exception as exc:
            record["parse_error"] = self._friendly_parse_error(exc, file_path.suffix.lower())
            response.update(record)

        (file_path.parent / "metadata.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return response

    def _load_source(self, file_path: Path) -> dict:
        suffix = file_path.suffix.lower()
        if suffix in {".edf", ".fif"}:
            continuous = self._load_mne_recording(file_path)
            if isinstance(continuous, dict):
                return continuous
            return {"mode": "epoch", "epochs": continuous, "labels": None}
        if suffix == ".gdf":
            return self._load_gdf(file_path)
        return {"mode": "epoch", "epochs": self._load_epochs(file_path), "labels": None}

    def _load_epochs(self, file_path: Path) -> np.ndarray:
        suffix = file_path.suffix.lower()
        if suffix == ".json":
            payload = json.loads(file_path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                payload = payload.get("epochs", payload.get("epoch"))
            if payload is None:
                raise ValueError("JSON 必须包含 epoch 或 epochs 字段")
            return self._coerce_epochs(np.asarray(payload, dtype=np.float32))
        if suffix == ".npy":
            return self._coerce_epochs(np.load(file_path, allow_pickle=False))
        raise ValueError(f"不支持的文件类型：{suffix}")

    def _load_gdf(self, file_path: Path) -> dict:
        """BCICIV 2b GDF：复用算法仓库的加载器；失败时退回通用 MNE 解析。"""
        tmin, tmax = self.window.tmin, self.window.tmax
        labels = None
        epochs = None
        try:
            if self.repo_root is not None and str(self.repo_root) not in sys_path_entries():
                sys_path_insert(str(self.repo_root))
            from tongyun_bci_algorithm import load_single_session

            X, y = load_single_session(
                str(file_path), tmin=tmin, tmax=tmax, sample_rate=100
            )
            if len(X) > 0:
                epochs = np.asarray(X, dtype=np.float32)
                # load_single_session 约定：0=左手，1=右手
                labels = np.asarray(y, dtype=np.int64).tolist()
        except Exception:
            epochs = None
        if epochs is None:
            epochs, labels = self._load_gdf_generic(file_path, tmin, tmax)
        if epochs is None or len(epochs) == 0:
            raise ValueError("GDF 中没有可用的运动想象事件（769/770）")
        return {"mode": "epoch", "epochs": self._coerce_epochs(epochs), "labels": labels}

    def _load_gdf_generic(self, file_path: Path, tmin: float, tmax: float):
        import mne

        raw = mne.io.read_raw_gdf(file_path, preload=True, verbose=False)
        rename = {name: name[4:] for name in raw.ch_names if name.startswith("EEG:")}
        if rename:
            raw.rename_channels(rename)
        raw.pick(["C3", "Cz", "C4"])
        raw.filter(4.0, 38.0, method="iir", verbose=False)
        raw.resample(100, verbose=False)
        events, event_id = mne.events_from_annotations(raw, verbose=False)
        left_id = event_id.get("769")
        right_id = event_id.get("770")
        if left_id is None or right_id is None:
            return None, None
        wanted = {"left": left_id, "right": right_id}
        epochs = mne.Epochs(
            raw, events, event_id=wanted, tmin=tmin, tmax=tmax,
            baseline=None, preload=True, verbose=False,
        )
        data = epochs.get_data()
        labels = [0 if value == left_id else 1 for value in epochs.events[:, 2]]
        return np.asarray(data, dtype=np.float32), labels

    def _load_mne_recording(self, file_path: Path):
        import mne

        if file_path.suffix.lower() == ".edf":
            raw = mne.io.read_raw_edf(file_path, preload=True, verbose=False)
        else:
            raw = mne.io.read_raw_fif(file_path, preload=True, verbose=False)

        rename = {name: name.removeprefix("EEG:") for name in raw.ch_names if name.startswith("EEG:")}
        if rename:
            raw.rename_channels(rename)
        channel_lookup = {name.casefold(): name for name in raw.ch_names}
        try:
            picks = [channel_lookup[name.casefold()] for name in ("C3", "Cz", "C4")]
        except KeyError as exc:
            raise ValueError("文件必须包含 C3、Cz、C4 三个通道") from exc

        events, _ = mne.events_from_annotations(raw, verbose=False)
        if len(events) == 0 and "STI 014" in raw.ch_names:
            events = mne.find_events(raw, stim_channel="STI 014", shortest_event=1, verbose=False)
        if len(events) == 0:
            raise ValueError("文件没有可用的事件标记，无法切分 Epoch")

        event_codes = events[:, 2].astype(int)
        if set(event_codes).issubset({1, 2, 3, 4}) and any(event_codes == 3):
            # 事件流模式：文件自带完整点/划/边界/空格编码
            preview_raw = raw.copy().pick(picks)
            if preview_raw.info["sfreq"] != 100:
                preview_raw.resample(100, verbose=False)
            eeg = preview_raw.get_data().astype(np.float32)
            resampled_events = []
            for onset_sample, _, code in events:
                onset_100 = int(round(onset_sample * 100.0 / raw.info["sfreq"]))
                resampled_events.append({
                    "code": int(code),
                    "sample": onset_100,
                    "confidence": 1.0,
                    "label": {1: "dot", 2: "dash", 3: "boundary", 4: "space"}.get(int(code), "unknown"),
                })
            decoded = decode_morse_events(event_codes)
            preview = np.zeros((EXPECTED_CHANNELS, EXPECTED_SAMPLES), dtype=np.float32)
            sample_count = min(EXPECTED_SAMPLES, eeg.shape[1])
            preview[:, :sample_count] = eeg[:, :sample_count]
            return {
                "mode": "event_stream",
                "trace": eeg,
                "events": resampled_events,
                "decoded": decoded,
                "event_count": int(len(events)),
                "symbol_count": int(np.isin(event_codes, [1, 2]).sum()),
                "duration_s": round(eeg.shape[1] / 100.0, 2),
                "preview": preview,
            }

        tmin, tmax = self.window.tmin, self.window.tmax
        raw.pick(picks)
        raw.filter(4.0, 38.0, method="iir", verbose=False)
        raw.resample(100, verbose=False)
        epochs = mne.Epochs(
            raw, events, event_id=None, tmin=tmin, tmax=tmax,
            baseline=None, preload=True, verbose=False,
        ).get_data()
        if len(epochs) == 0:
            raise ValueError(f"事件标记附近没有完整的 {tmin}–{tmax} 秒数据")
        return self._coerce_epochs(epochs)

    # ---- 波形 / epoch 读取 ----

    def get_waveform(self, source_id: str, max_points: int = 6000) -> dict:
        source = self.get_source(source_id)
        if source is None:
            raise KeyError(f"未知源文件：{source_id}")
        if source_id in self._virtual:
            sim = self._virtual[source_id]
            return self._decimated_waveform(sim.trace, sim.events, max_points)

        source_dir = self.root / source_id
        if source.get("source_mode") == "event_stream":
            trace, events = self._load_event_stream_trace(source_dir)
            return self._decimated_waveform(trace, events, max_points)

        epochs_path = source_dir / "epochs.npy"
        if not epochs_path.exists():
            raise ValueError("源文件的 epochs.npy 缓存不存在，请重新上传解析")
        epochs = np.load(epochs_path, allow_pickle=False)
        tmin = float(source.get("window", {}).get("tmin", DEFAULT_WINDOW[0]))
        events = [{
            "code": 0,
            "sample": index * EXPECTED_SAMPLES + int(round(-tmin * 100)) if tmin < 0 else index * EXPECTED_SAMPLES,
            "epoch_index": index,
            "confidence": None,
            "label": None,
        } for index in range(min(epochs.shape[0], 600))]
        labels = source.get("labels")
        for event in events:
            if labels is not None and event["epoch_index"] < len(labels):
                event["label"] = "dot" if labels[event["epoch_index"]] == 0 else "dash"
        return self._decimated_waveform(epochs.reshape(EXPECTED_CHANNELS, -1), events, max_points)

    def _load_event_stream_trace(self, source_dir: Path):
        import mne

        file_path = next(
            (p for p in source_dir.iterdir() if p.suffix.lower() in {".fif", ".edf"}),
            None,
        )
        if file_path is None:
            raise ValueError("事件流源文件缺失")
        if file_path.suffix.lower() == ".edf":
            raw = mne.io.read_raw_edf(file_path, preload=True, verbose=False)
        else:
            raw = mne.io.read_raw_fif(file_path, preload=True, verbose=False)
        rename = {name: name.removeprefix("EEG:") for name in raw.ch_names if name.startswith("EEG:")}
        if rename:
            raw.rename_channels(rename)
        lookup = {name.casefold(): name for name in raw.ch_names}
        picks = [lookup[name.casefold()] for name in ("C3", "Cz", "C4")]
        preview_raw = raw.copy().pick(picks)
        if preview_raw.info["sfreq"] != 100:
            preview_raw.resample(100, verbose=False)
        trace = preview_raw.get_data().astype(np.float32)
        events, _ = mne.events_from_annotations(raw, verbose=False)
        if len(events) == 0 and "STI 014" in raw.ch_names:
            events = mne.find_events(raw, stim_channel="STI 014", shortest_event=1, verbose=False)
        event_list = []
        for onset_sample, _, code in events:
            code = int(code)
            event_list.append({
                "code": code,
                "sample": int(round(onset_sample * 100.0 / raw.info["sfreq"])),
                "epoch_index": None,
                "confidence": 1.0 if code in (3, 4) else 0.96,
                "label": {1: "dot", 2: "dash", 3: "boundary", 4: "space"}.get(code, "unknown"),
            })
        return trace, event_list

    @staticmethod
    def _decimated_waveform(trace: np.ndarray, events: list[dict], max_points: int) -> dict:
        trace = np.asarray(trace, dtype=np.float32)
        if trace.ndim != 2 or trace.shape[0] != EXPECTED_CHANNELS:
            raise ValueError("波形数据必须为 [3, N]")
        total = trace.shape[1]
        stride = max(1, int(math.ceil(total / max_points)))
        decimated = trace[:, ::stride]
        # 事件样本映射到抽稀后的下标
        mapped_events = []
        for event in events:
            raw_sample = int(event.get("sample", 0))
            if raw_sample < 0 or raw_sample >= total:
                continue
            mapped = dict(event)
            mapped["sample"] = raw_sample
            mapped["index"] = raw_sample // stride
            mapped["time_s"] = round(raw_sample / 100.0, 3)
            mapped_events.append(mapped)
        return {
            "sample_rate": 100,
            "stride": stride,
            "duration_s": round(total / 100.0, 2),
            "total_samples": total,
            "traces": decimated.tolist(),
            "events": mapped_events,
        }

    def get_epochs(self, source_id: str, start: int, count: int) -> dict:
        source = self.get_source(source_id)
        if source is None:
            raise KeyError(f"未知源文件：{source_id}")
        if source_id in self._virtual:
            # 模拟源为事件流模式，按事件码直接解码，无需读取 epoch
            return {"total": 0, "start": start, "epochs": []}
        epochs_path = self.root / source_id / "epochs.npy"
        if not epochs_path.exists():
            raise ValueError("源文件的 epochs.npy 缓存不存在")
        epochs = np.load(epochs_path, allow_pickle=False, mmap_mode="r")
        total = int(epochs.shape[0])
        chunk = np.asarray(epochs[start:start + count], dtype=np.float32)
        return {"total": total, "start": start, "epochs": chunk.tolist()}

    # ---- 虚拟源（模拟）----

    def create_simulation(self, text: str) -> dict:
        sim = SimulationSource(text)
        source_id = f"sim-{uuid4().hex[:10]}"
        record = sim.status()
        record.update({
            "id": source_id,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            "state": "ready",
            "channels": ["C3", "Cz", "C4"],
            "sample_rate_hz": 100,
            "epoch_shape": [EXPECTED_CHANNELS, EXPECTED_SAMPLES],
            "window": self.window.as_dict(),
            "epoch_count": len(sim.events),
            "correction": suggest_text_correction(sim.decoded_text),
            "extension": ".sim",
            "size_bytes": sim.trace.nbytes,
        })
        with self._lock:
            self._virtual[source_id] = sim
            self._virtual_meta[source_id] = record
        return record

    def get_simulation_events(self, source_id: str) -> list[dict]:
        payload = self._virtual.get(source_id)
        if payload is None or payload.get("mode") != "simulation":
            raise KeyError(f"未知模拟源：{source_id}")
        return payload["object"].events

    # ---- 工具 ----

    @staticmethod
    def _coerce_epochs(values: np.ndarray) -> np.ndarray:
        values = np.asarray(values, dtype=np.float32)
        if values.ndim == 2:
            values = values[np.newaxis, ...]
        return values

    @staticmethod
    def _validate_epochs(epochs: np.ndarray) -> None:
        if epochs.ndim != 3 or epochs.shape[1] != EXPECTED_CHANNELS:
            raise ValueError(
                "解析后的数据必须为 [Epoch数量, 3, T]，"
                f"实际为 {list(epochs.shape)}"
            )
        if epochs.shape[0] == 0:
            raise ValueError("文件中没有可用的 Epoch")
        if not np.isfinite(epochs).all():
            raise ValueError("文件包含 NaN 或无穷值")

    @staticmethod
    def _friendly_parse_error(exc: Exception, suffix: str) -> str:
        if isinstance(exc, ModuleNotFoundError) and exc.name == "mne":
            return f"{suffix.upper()} 已保存；当前环境缺少 MNE，安装算法依赖后即可解析"
        return str(exc)


# --------------------------------------------------------------------------
# 时间窗状态
# --------------------------------------------------------------------------

class WindowState:
    def __init__(self, tmin: float, tmax: float):
        self.tmin = float(tmin)
        self.tmax = float(tmax)

    def as_dict(self) -> dict:
        return {
            "tmin": self.tmin,
            "tmax": self.tmax,
            "duration": round(self.tmax - self.tmin, 3),
            "samples": int(round((self.tmax - self.tmin) * 100)) + 1,
            "bounds": [WINDOW_MIN, WINDOW_MAX],
            "min_span": WINDOW_MIN_SPAN,
            "trained_default": list(DEFAULT_WINDOW),
        }

    def update(self, tmin: float, tmax: float) -> dict:
        tmin, tmax = float(tmin), float(tmax)
        if not (WINDOW_MIN <= tmin < tmax <= WINDOW_MAX):
            raise ValueError(f"时间窗必须位于 [{WINDOW_MIN}, {WINDOW_MAX}] 且 tmin < tmax")
        if tmax - tmin < WINDOW_MIN_SPAN:
            raise ValueError(f"时间窗长度至少 {WINDOW_MIN_SPAN} 秒")
        self.tmin = tmin
        self.tmax = tmax
        return self.as_dict()


def resample_epoch(epoch: np.ndarray, samples: int = EXPECTED_SAMPLES) -> np.ndarray:
    """把任意长度的 epoch（2D 单个或 3D 批量）重采样到模型兼容长度（351 点 @100Hz）。"""
    epoch = np.asarray(epoch, dtype=np.float32)
    if epoch.ndim == 2:
        if epoch.shape[1] == samples:
            return epoch
        axis = 1
    elif epoch.ndim == 3:
        if epoch.shape[2] == samples:
            return epoch
        axis = 2
    else:
        raise ValueError(f"epoch 必须为 [3, T] 或 [N, 3, T]，实际 {list(epoch.shape)}")
    if epoch.shape[axis] < 4:
        raise ValueError("epoch 时间点数过少，无法重采样")
    from scipy.signal import resample as scipy_resample

    return scipy_resample(epoch, samples, axis=axis).astype(np.float32)


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

class AppHandler(BaseHTTPRequestHandler):
    server_version = "TongYunBridge/2.0"

    @property
    def app(self):
        return self.server.app

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-File-Name")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, max_bytes: int = 2_000_000) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > max_bytes:
            raise ValueError("请求体为空或过大")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求体必须为 JSON 对象")
        return payload

    def do_OPTIONS(self) -> None:
        self._send_json(204, {})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = {}
        for key, value in [pair.split("=", 1) for pair in parsed.query.split("&") if "=" in pair]:
            query[key] = unquote(value)
        try:
            if path == "/api/algorithm/health":
                self._send_json(200, self.app.decoder.health(self.app.fallback.status()))
                return
            if path == "/api/window":
                self._send_json(200, self.app.window.as_dict())
                return
            if path == "/api/data/sources":
                self._send_json(200, {"sources": self.app.source_store.list_sources()})
                return
            if path == "/api/data/source":
                source = self.app.source_store.get_source(query.get("id", ""))
                if source is None:
                    self._send_json(404, {"error": f"未知源文件：{query.get('id')}", "code": "UNKNOWN_SOURCE"})
                else:
                    self._send_json(200, source)
                return
            if path == "/api/data/waveform":
                max_points = int(query.get("max_points", "6000"))
                self._send_json(200, self.app.source_store.get_waveform(query.get("id", ""), max_points))
                return
            if path == "/api/live/status":
                self._send_json(200, self.app.live.status())
                return
            if path == "/api/live/events":
                after = int(query.get("after", "0"))
                self._send_json(200, self.app.live.events_since(after))
                return
            if path == "/api/live/waveform":
                max_points = int(query.get("max_points", "2000"))
                self._send_json(200, self.app.live.waveform(max_points))
                return
            if path == "/api/live/lsl/streams":
                self._send_json(200, {"streams": list_lsl_streams()})
                return
            if path == "/api/data/epochs":
                start = max(0, int(query.get("start", "0")))
                count = min(200, max(1, int(query.get("count", "64"))))
                self._send_json(200, self.app.source_store.get_epochs(query.get("id", ""), start, count))
                return
            if path.startswith("/api/"):
                self._send_json(404, {"error": "API 路径不存在", "code": "NOT_FOUND"})
                return
            self._serve_frontend(path)
        except KeyError as exc:
            self._send_json(404, {"error": str(exc), "code": "UNKNOWN_SOURCE"})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc), "code": "INVALID_REQUEST"})
        except Exception as exc:
            self._send_json(500, {"error": f"处理失败：{exc}", "code": "INTERNAL_ERROR"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/algorithm/predict":
                self._predict_epoch()
                return
            if path == "/api/algorithm/threshold":
                self._set_threshold()
                return
            if path == "/api/window":
                self._set_window()
                return
            if path == "/api/data/upload":
                self._upload_source()
                return
            if path == "/api/live/start":
                self._live_start()
                return
            if path == "/api/live/stop":
                self._live_stop()
                return
            if path == "/api/fallback/train":
                self._train_fallback()
                return
            if path == "/api/simulation/start":
                self._start_simulation()
                return
            if path == "/api/morse/decode":
                self._decode_events()
                return
            self._send_json(404, {"error": "API 路径不存在", "code": "NOT_FOUND"})
        except AlgorithmUnavailable as exc:
            self._send_json(503, {"error": str(exc), "code": "MODEL_UNAVAILABLE"})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": str(exc), "code": "INVALID_REQUEST"})
        except Exception as exc:
            self._send_json(500, {"error": f"处理失败：{exc}", "code": "INTERNAL_ERROR"})

    # ---- 推理 ----

    def _predict_epoch(self) -> None:
        payload = self._read_json()
        if "epoch" not in payload:
            raise ValueError("请求必须包含 epoch 字段")
        epoch = np.asarray(payload["epoch"], dtype=np.float32)
        if epoch.ndim != 2 or epoch.shape[0] != EXPECTED_CHANNELS:
            raise ValueError(f"epoch 必须为 [3, T]，实际 {list(epoch.shape)}")
        epoch = resample_epoch(epoch)
        threshold = payload.get("threshold")
        try:
            self._send_json(200, self.app.decoder.predict(epoch.tolist(), threshold))
            return
        except AlgorithmUnavailable:
            if self.app.fallback.trained:
                proba = self.app.fallback.predict_proba(epoch)
                self._send_json(200, _response_from_proba(proba, threshold or self.app.decoder.threshold))
                return
            raise

    def _set_threshold(self) -> None:
        payload = self._read_json()
        threshold = float(payload.get("threshold", self.app.decoder.threshold))
        if not 0.5 <= threshold < 1.0:
            raise ValueError("threshold 必须位于 [0.5, 1.0)")
        self.app.decoder.threshold = threshold
        self._send_json(200, {"confidence_threshold": threshold})

    # ---- 时间窗 ----

    def _set_window(self) -> None:
        payload = self._read_json()
        if "tmin" not in payload or "tmax" not in payload:
            raise ValueError("必须同时提供 tmin 与 tmax")
        self._send_json(200, self.app.window.update(payload["tmin"], payload["tmax"]))

    # ---- 源文件 ----

    def _upload_source(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_SOURCE_BYTES:
            raise ValueError("源文件为空或超过 512 MB")
        supplied_name = unquote(self.headers.get("X-File-Name", ""))
        safe_name = Path(supplied_name).name
        if not safe_name:
            raise ValueError("缺少源文件名")
        suffix = Path(safe_name).suffix.lower()
        if suffix not in ALLOWED_SOURCE_EXTENSIONS:
            raise ValueError("仅支持 GDF、EDF、FIF、JSON、NPY 源文件")

        source_id = uuid4().hex
        source_dir = self.app.source_store.root / source_id
        source_dir.mkdir(parents=True, exist_ok=False)
        file_path = source_dir / safe_name
        remaining = length
        with file_path.open("wb") as target:
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("源文件上传不完整")
                target.write(chunk)
                remaining -= len(chunk)
        self._send_json(201, self.app.source_store.inspect_upload(source_id, file_path))

    # ---- 实时解码 ----

    def _live_start(self) -> None:
        payload = self._read_json()
        self._send_json(201, self.app.live.start(payload))

    def _live_stop(self) -> None:
        self._send_json(200, self.app.live.stop())

    # ---- 回退分类器训练 ----

    def _train_fallback(self) -> None:
        payload = self._read_json()
        source_id = payload.get("source_id")
        source = self.app.source_store.get_source(source_id or "")
        if source is None:
            raise KeyError(f"未知源文件：{source_id}")
        if source_id in self.app.source_store._virtual:
            raise ValueError("模拟源没有真实标签，无法训练")
        epochs_path = self.app.source_store.root / source_id / "epochs.npy"
        if not epochs_path.exists():
            raise ValueError("源文件的 epochs.npy 缓存不存在")
        labels = source.get("labels")
        if not labels:
            raise ValueError("该源文件没有左右手标签（需要 BCICIV 2b 训练 GDF）")
        epochs = np.load(epochs_path, allow_pickle=False)
        X = resample_epoch(epochs)
        y = np.asarray(labels[: X.shape[0]], dtype=np.int64)
        status = self.app.fallback.fit(X, y)
        self._send_json(200, {"status": status, "source_id": source_id})

    # ---- 模拟 ----

    def _start_simulation(self) -> None:
        payload = self._read_json()
        text = str(payload.get("text", "HELLO WORLD")).strip()
        if not text or len(text) > 200:
            raise ValueError("模拟文本不能为空且不超过 200 字符")
        record = self.app.source_store.create_simulation(text)
        self._send_json(201, record)

    # ---- 摩斯解码 ----

    def _decode_events(self) -> None:
        payload = self._read_json()
        events = payload.get("events")
        if not isinstance(events, list) or not events:
            raise ValueError("events 必须为非空数组")
        decoded = decode_morse_events(events)
        decoded["correction"] = suggest_text_correction(decoded["decoded_text"])
        self._send_json(200, decoded)

    # ---- 前端静态文件 ----

    def _serve_frontend(self, request_path: str) -> None:
        root = self.app.static_root
        relative = request_path.lstrip("/") or "index.html"
        candidate = (root / relative).resolve()
        if root not in candidate.parents and candidate != root:
            self.send_error(403)
            return
        if not candidate.is_file():
            candidate = root / "index.html"
        if not candidate.is_file():
            self._send_json(404, {"error": "前端尚未构建：请先在 frontend 目录运行 npm run build"})
            return
        content = candidate.read_bytes()
        media_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")


class TongYunServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, decoder, static_root, source_root, fallback, window):
        super().__init__(address, handler)
        source_store = SourceStore(source_root, decoder.repo_root, decoder, fallback, window)
        live = LiveStream(decoder, fallback)
        self.app = type(
            "AppState",
            (),
            {
                "decoder": decoder,
                "fallback": fallback,
                "window": window,
                "static_root": static_root.resolve(),
                "source_store": source_store,
                "live": live,
            },
        )()


def parse_args() -> argparse.Namespace:
    backend_dir = Path(__file__).parent
    parser = argparse.ArgumentParser(description="TongYun frontend + Hybrid FBC bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path(
            os.environ.get(
                "TONGYUN_ALGORITHM_REPO",
                str(backend_dir.parent / "tongyun-bci-algorithm"),
            )
        ),
    )
    default_model = os.environ.get("TONGYUN_MODEL_PATH")
    if default_model is None:
        # 自动搜索常见权重位置：backend/models/、项目根 models/、算法仓库 models/
        for directory in (
            backend_dir / "models",
            backend_dir.parent / "models",
            Path(os.environ.get("TONGYUN_ALGORITHM_REPO", backend_dir.parent / "tongyun-bci-algorithm")) / "models",
        ):
            if directory.is_dir():
                candidates = sorted(directory.glob("*.pt")) + sorted(directory.glob("*.pth"))
                if candidates:
                    default_model = str(candidates[0])
                    break
    parser.add_argument("--model", type=Path, default=Path(default_model) if default_model else None)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--static", type=Path, default=backend_dir.parent / "frontend" / "dist")
    parser.add_argument("--uploads", type=Path, default=backend_dir / "data" / "uploads")
    parser.add_argument("--tmin", type=float, default=DEFAULT_WINDOW[0])
    parser.add_argument("--tmax", type=float, default=DEFAULT_WINDOW[1])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 0.5 <= args.threshold < 1.0:
        raise ValueError("threshold 必须位于 [0.5, 1.0)")
    decoder = HybridFBCDecoder(args.repo, args.model, args.threshold)
    fallback = CSPLDAFallback()
    window = WindowState(args.tmin, args.tmax)
    server = TongYunServer(
        (args.host, args.port), AppHandler, decoder, args.static, args.uploads, fallback, window
    )
    health = decoder.health(fallback.status())
    health["window"] = window.as_dict()
    print(json.dumps(health, ensure_ascii=False, indent=2))
    print(f"TongYun bridge: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
