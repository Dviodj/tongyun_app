"""生成一个随机权重的 Hybrid FBC-MIFormer 检查点，用于验证深度学习加载链路。

注意：权重是随机初始化的，没有任何解码能力，只用于验证
「桥接服务 -> tongyun_bci_algorithm -> predict_proba」这条链路通畅。
用法：
    python tools/make_dummy_checkpoint.py [输出路径]
    python backend.py --repo <算法仓库> --model <输出路径>
"""
import os
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parent.parent
# 算法仓库：环境变量优先，其次项目同级目录（tongyun-bci-web 与 tongyun-bci-algorithm 并排）
ALGO_REPO = Path(
    os.environ.get("TONGYUN_ALGORITHM_REPO", ROOT.parent.parent / "tongyun-bci-algorithm")
).resolve()
sys.path.insert(0, str(ALGO_REPO))

from tongyun_bci_algorithm.model import HybridFBCMIFormer


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "models" / "hybrid_fbc_mi_former.pt"
    out.parent.mkdir(parents=True, exist_ok=True)
    model = HybridFBCMIFormer(n_channels=3, n_classes=2, fs=100)
    torch.save(
        {
            "format_version": 4,
            "architecture": "hybrid_fbc_mi_former",
            "state": model.state_dict(),
            "history": {"train_loss": [], "val_accuracy": []},
            "channel_mean": torch.zeros(1, 3, 1),
            "channel_std": torch.ones(1, 3, 1),
            "model_config": {
                "fs": 100,
                "n_channels": 3,
                "d_model": 48,
                "attention_heads": 4,
                "attention_layers": 1,
                "dropout": 0.25,
            },
        },
        out,
    )
    print(f"已生成随机权重检查点: {out}")


if __name__ == "__main__":
    main()
