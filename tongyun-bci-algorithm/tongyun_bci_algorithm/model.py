"""Lightweight deep model for left/right motor-imagery EEG decoding.

The network is intentionally compact for the three-channel BCICIV-2b setting:
multi-scale temporal filters learn rhythm-specific features, a spatial filter
learns C3/Cz/C4 interactions, and local TCN plus global attention branches are
fused before classification. The forward path contains no STFT, which keeps
single-epoch inference inexpensive.
"""

from __future__ import annotations

from contextlib import nullcontext
import math
import time
from typing import Dict, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from scipy.signal import firwin
from sklearn.metrics import accuracy_score, balanced_accuracy_score, cohen_kappa_score
from sklearn.model_selection import GroupShuffleSplit, train_test_split


class ChannelAttention(nn.Module):
    """Data-dependent weighting for the C3/Cz/C4 input channels."""

    def __init__(self, n_channels: int, hidden: int = 12):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_channels * 2, hidden),
            nn.GELU(),
            nn.Linear(hidden, n_channels),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        mean_abs = x.abs().mean(dim=-1)
        std = x.std(dim=-1, unbiased=False)
        weights = self.net(torch.cat([mean_abs, std], dim=1)).unsqueeze(-1)
        return x * (0.5 + weights), weights.squeeze(-1)


class MultiScaleSpatialStem(nn.Module):
    """Multi-scale temporal filtering followed by learned spatial filtering."""

    def __init__(
        self,
        n_channels: int,
        d_model: int,
        branch_channels: int = 8,
        kernels: Sequence[int] = (15, 31, 63),
        spatial_multiplier: int = 2,
        dropout: float = 0.25,
    ):
        super().__init__()
        self.temporal_branches = nn.ModuleList([
            nn.Sequential(
                nn.Conv2d(
                    1,
                    branch_channels,
                    kernel_size=(1, kernel),
                    padding=(0, kernel // 2),
                    bias=False,
                ),
                nn.BatchNorm2d(branch_channels),
                nn.GELU(),
            )
            for kernel in kernels
        ])

        temporal_channels = branch_channels * len(kernels)
        spatial_channels = temporal_channels * spatial_multiplier
        self.spatial = nn.Sequential(
            nn.Conv2d(
                temporal_channels,
                spatial_channels,
                kernel_size=(n_channels, 1),
                groups=temporal_channels,
                bias=False,
            ),
            nn.BatchNorm2d(spatial_channels),
            nn.GELU(),
            nn.AvgPool2d(kernel_size=(1, 4), stride=(1, 4)),
            nn.Dropout(dropout),
        )
        self.project = nn.Sequential(
            nn.Conv1d(spatial_channels, d_model, kernel_size=1, bias=False),
            nn.BatchNorm1d(d_model),
            nn.GELU(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x_2d = x.unsqueeze(1)
        temporal = torch.cat([branch(x_2d) for branch in self.temporal_branches], dim=1)
        spatial = self.spatial(temporal).squeeze(2)
        return self.project(spatial)


class DepthwiseTCNBlock(nn.Module):
    """Residual temporal block with depthwise separable dilated convolution."""

    def __init__(self, channels: int, dilation: int, dropout: float):
        super().__init__()
        self.block = nn.Sequential(
            nn.Conv1d(
                channels,
                channels,
                kernel_size=5,
                padding=2 * dilation,
                dilation=dilation,
                groups=channels,
                bias=False,
            ),
            nn.Conv1d(channels, channels, kernel_size=1, bias=False),
            nn.BatchNorm1d(channels),
            nn.GELU(),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.block(x)


class AttentionPool(nn.Module):
    """Learned pooling over temporal tokens."""

    def __init__(self, d_model: int):
        super().__init__()
        self.score = nn.Sequential(
            nn.Linear(d_model, max(8, d_model // 4)),
            nn.Tanh(),
            nn.Linear(max(8, d_model // 4), 1),
        )

    def forward(self, tokens: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        weights = F.softmax(self.score(tokens), dim=1)
        pooled = (tokens * weights).sum(dim=1)
        return pooled, weights.squeeze(-1)


class SinusoidalPositionEncoding(nn.Module):
    def __init__(self, d_model: int, max_len: int = 512):
        super().__init__()
        position = torch.arange(max_len, dtype=torch.float32).unsqueeze(1)
        div_term = torch.exp(
            torch.arange(0, d_model, 2, dtype=torch.float32)
            * (-math.log(10000.0) / d_model)
        )
        encoding = torch.zeros(1, max_len, d_model)
        encoding[0, :, 0::2] = torch.sin(position * div_term)
        encoding[0, :, 1::2] = torch.cos(position * div_term)
        self.register_buffer("encoding", encoding, persistent=False)

    def forward(self, tokens: torch.Tensor) -> torch.Tensor:
        if tokens.size(1) > self.encoding.size(1):
            raise ValueError("EEG token sequence exceeds positional encoding length")
        return tokens + self.encoding[:, :tokens.size(1)]


class FixedFilterBank(nn.Module):
    """Zero-phase-like linear-phase FIR bank implemented as one GPU convolution."""

    def __init__(
        self,
        fs: int,
        bands: Sequence[Tuple[float, float]],
        kernel_size: int = 51,
    ):
        super().__init__()
        kernels = np.stack([
            firwin(kernel_size, [low, high], pass_zero=False, fs=fs)
            for low, high in bands
        ])
        self.register_buffer(
            "kernels",
            torch.from_numpy(kernels.astype(np.float32)).unsqueeze(1),
        )
        self.padding = kernel_size // 2

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        batch, channels, n_times = x.shape
        filtered = F.conv1d(
            x.reshape(batch * channels, 1, n_times),
            self.kernels,
            padding=self.padding,
        )
        return filtered.view(batch, channels, len(self.kernels), n_times).permute(
            0, 2, 1, 3
        )


class FBCVarianceBranch(nn.Module):
    """FBCNet-style spectro-spatial filters with robust log-variance pooling."""

    def __init__(
        self,
        n_channels: int,
        fs: int,
        d_model: int,
        spatial_filters: int = 4,
        segments: int = 4,
        dropout: float = 0.25,
    ):
        super().__init__()
        bands = ((4, 8), (8, 12), (12, 16), (16, 20),
                 (20, 24), (24, 28), (28, 32), (32, 38))
        self.filter_bank = FixedFilterBank(fs, bands)
        self.segments = segments
        spectral_channels = len(bands) * spatial_filters
        self.spatial = nn.Sequential(
            nn.Conv2d(
                len(bands),
                spectral_channels,
                kernel_size=(n_channels, 1),
                groups=len(bands),
                bias=False,
            ),
            nn.BatchNorm2d(spectral_channels),
            nn.SiLU(),
        )
        self.project = nn.Sequential(
            nn.Linear(spectral_channels * segments, d_model),
            nn.LayerNorm(d_model),
            nn.GELU(),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.spatial(self.filter_bank(x)).squeeze(2)
        usable_times = (features.size(-1) // self.segments) * self.segments
        features = features[..., :usable_times]
        features = features.view(
            features.size(0),
            features.size(1),
            self.segments,
            usable_times // self.segments,
        )
        log_variance = torch.log(features.var(dim=-1, unbiased=False) + 1e-6)
        return self.project(log_variance.flatten(1))


class HybridFBCMIFormer(nn.Module):
    """Compact local/global network for motor-imagery EEG classification."""

    def __init__(
        self,
        n_channels: int = 3,
        n_classes: int = 2,
        fs: int = 100,
        d_model: int = 48,
        attention_heads: int = 4,
        attention_layers: int = 1,
        dropout: float = 0.25,
        **_: object,
    ):
        super().__init__()
        if d_model % attention_heads != 0:
            raise ValueError("d_model must be divisible by attention_heads")

        self.fs = fs
        self.channel_attention = ChannelAttention(n_channels)
        self.stem = MultiScaleSpatialStem(
            n_channels=n_channels,
            d_model=d_model,
            dropout=dropout,
        )
        self.local_branch = nn.Sequential(
            DepthwiseTCNBlock(d_model, dilation=1, dropout=dropout),
            DepthwiseTCNBlock(d_model, dilation=2, dropout=dropout),
        )

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=attention_heads,
            dim_feedforward=d_model * 2,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=False,
        )
        self.position = SinusoidalPositionEncoding(d_model)
        self.global_branch = nn.TransformerEncoder(
            encoder_layer,
            num_layers=attention_layers,
            enable_nested_tensor=False,
        )
        self.global_pool = AttentionPool(d_model)
        self.spectral_branch = FBCVarianceBranch(
            n_channels=n_channels,
            fs=fs,
            d_model=d_model,
            dropout=dropout,
        )
        self.fusion_gate = nn.Sequential(
            nn.Linear(d_model * 2, d_model),
            nn.Sigmoid(),
        )
        self.spectral_gate = nn.Sequential(
            nn.Linear(d_model * 2, d_model),
            nn.Sigmoid(),
        )
        self.classifier = nn.Sequential(
            nn.LayerNorm(d_model),
            nn.Linear(d_model, d_model),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(d_model, n_classes),
        )
        self._init_weights()

    def _init_weights(self) -> None:
        for module in self.modules():
            if isinstance(module, (nn.Conv1d, nn.Conv2d)):
                nn.init.kaiming_normal_(module.weight, nonlinearity="relu")
            elif isinstance(module, nn.Linear):
                nn.init.xavier_uniform_(module.weight)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, Dict[str, torch.Tensor]]:
        if x.ndim != 3:
            raise ValueError("Expected EEG input with shape (batch, channels, time)")

        x, channel_weights = self.channel_attention(x)
        features = self.stem(x)

        local = self.local_branch(features).mean(dim=-1)
        tokens = self.position(features.transpose(1, 2))
        global_tokens = self.global_branch(tokens)
        global_features, temporal_weights = self.global_pool(global_tokens)

        gate = self.fusion_gate(torch.cat([local, global_features], dim=1))
        temporal_fused = gate * global_features + (1.0 - gate) * local
        spectral_features = self.spectral_branch(x)
        spectral_gate = self.spectral_gate(
            torch.cat([temporal_fused, spectral_features], dim=1)
        )
        fused = spectral_gate * spectral_features
        fused += (1.0 - spectral_gate) * temporal_fused
        logits = self.classifier(fused)
        return logits, {
            "channel_attention": channel_weights,
            "temporal_attention": temporal_weights,
            "fusion_gate": gate,
            "spectral_gate": spectral_gate,
        }


class HybridFBCMIFormerWrapper:
    """Training, persistence, prediction and efficiency reporting wrapper."""

    def __init__(
        self,
        fs: int = 100,
        n_channels: int = 3,
        lr: float = 8e-4,
        weight_decay: float = 1e-3,
        epochs: int = 120,
        batch_size: int = 64,
        patience: int = 20,
        device: str = "auto",
        seed: int = 42,
        d_model: int = 48,
        attention_heads: int = 4,
        attention_layers: int = 1,
        dropout: float = 0.25,
        mixup_alpha: float = 0.2,
        **legacy_kwargs: object,
    ):
        # Accept older argument names so existing calls remain usable.
        d_model = int(legacy_kwargs.get("attn_d_model", d_model))
        attention_heads = int(legacy_kwargs.get("attn_heads", attention_heads))
        attention_layers = int(legacy_kwargs.get("attn_layers", attention_layers))

        self.fs = fs
        self.n_channels = n_channels
        self.lr = lr
        self.weight_decay = weight_decay
        self.epochs = epochs
        self.batch_size = batch_size
        self.patience = patience
        self.seed = seed
        self.d_model = d_model
        self.attention_heads = attention_heads
        self.attention_layers = attention_layers
        self.dropout = dropout
        self.mixup_alpha = mixup_alpha
        self.device = self._resolve_device(device)
        self.use_amp = self.device.type == "cuda"
        self.model: Optional[HybridFBCMIFormer] = None
        self.channel_mean: Optional[torch.Tensor] = None
        self.channel_std: Optional[torch.Tensor] = None
        self.is_trained = False
        self.history = {
            "train_loss": [],
            "val_accuracy": [],
            "val_balanced_accuracy": [],
        }

    @staticmethod
    def _resolve_device(device: str) -> torch.device:
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        return torch.device(device)

    def _set_seed(self) -> None:
        torch.manual_seed(self.seed)
        np.random.seed(self.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(self.seed)
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

    def _build_model(self) -> HybridFBCMIFormer:
        return HybridFBCMIFormer(
            n_channels=self.n_channels,
            n_classes=2,
            fs=self.fs,
            d_model=self.d_model,
            attention_heads=self.attention_heads,
            attention_layers=self.attention_layers,
            dropout=self.dropout,
        ).to(self.device)

    def fit(
        self,
        X,
        y,
        X_val=None,
        y_val=None,
        groups=None,
        use_validation: bool = True,
    ) -> "HybridFBCMIFormerWrapper":
        self._set_seed()
        X = self._as_float_tensor(X)
        y = self._as_label_tensor(y)

        if X_val is None and use_validation:
            X, X_val, y, y_val = self._split_train_val(X, y, groups)
        elif X_val is not None:
            X_val = self._as_float_tensor(X_val)
            y_val = self._as_label_tensor(y_val)

        if X.ndim != 3 or X.size(1) != self.n_channels:
            raise ValueError(
                "Expected training data with shape "
                f"(samples, {self.n_channels}, time), got {tuple(X.shape)}"
            )
        if len(X) < 2:
            raise ValueError("At least two training epochs are required")

        self._fit_normalizer(X)
        X_train = self._normalize(X)
        self.model = self._build_model()
        self.is_trained = False

        train_dataset = EEGDatasetV2(X_train, y, augment=True, fs=self.fs)
        generator = torch.Generator().manual_seed(self.seed)
        train_loader = torch.utils.data.DataLoader(
            train_dataset,
            batch_size=min(self.batch_size, len(train_dataset)),
            shuffle=True,
            num_workers=0,
            pin_memory=self.use_amp,
            generator=generator,
        )

        optimizer = torch.optim.AdamW(
            self.model.parameters(),
            lr=self.lr,
            weight_decay=self.weight_decay,
        )
        scheduler = torch.optim.lr_scheduler.OneCycleLR(
            optimizer,
            max_lr=self.lr,
            epochs=self.epochs,
            steps_per_epoch=max(1, len(train_loader)),
            pct_start=0.15,
            anneal_strategy="cos",
        )
        class_weights = self._class_weights(y).to(self.device)
        criterion = nn.CrossEntropyLoss(weight=class_weights, label_smoothing=0.05)
        scaler = self._make_grad_scaler()

        best_score = -float("inf")
        best_state = None
        patience_count = 0
        parameter_count = sum(p.numel() for p in self.model.parameters())
        print(
            f"  Hybrid FBC-MIFormer parameters: {parameter_count:,} | "
            f"device: {self.device.type}"
        )

        for epoch in range(self.epochs):
            self.model.train()
            total_loss = 0.0

            for batch_x, batch_y in train_loader:
                batch_x = batch_x.to(self.device, non_blocking=self.use_amp)
                batch_y = batch_y.to(self.device, non_blocking=self.use_amp)
                optimizer.zero_grad(set_to_none=True)

                with self._autocast():
                    mixed_x, target_a, target_b, lam = self._mixup(batch_x, batch_y)
                    logits, _ = self.model(mixed_x)
                    loss = lam * criterion(logits, target_a)
                    loss += (1.0 - lam) * criterion(logits, target_b)

                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
                scale_before_step = scaler.get_scale()
                scaler.step(optimizer)
                scaler.update()
                # AMP can skip an optimizer step when gradients overflow. Keep
                # OneCycleLR synchronized with actual optimizer updates.
                if scaler.get_scale() >= scale_before_step:
                    scheduler.step()
                total_loss += float(loss.detach().cpu())

            train_loss = total_loss / max(1, len(train_loader))
            self.history["train_loss"].append(train_loss)

            if X_val is not None:
                metrics = self.evaluate(X_val, y_val)
                val_acc = metrics["accuracy"]
                val_bal_acc = metrics["balanced_accuracy"]
                self.history["val_accuracy"].append(val_acc)
                self.history["val_balanced_accuracy"].append(val_bal_acc)

                if val_bal_acc > best_score + 1e-4:
                    best_score = val_bal_acc
                    best_state = {
                        key: value.detach().cpu().clone()
                        for key, value in self.model.state_dict().items()
                    }
                    patience_count = 0
                else:
                    patience_count += 1

                if epoch == 0 or (epoch + 1) % 5 == 0:
                    print(
                        f"  epoch {epoch + 1:3d}/{self.epochs} | "
                        f"loss={train_loss:.4f} | acc={val_acc:.3f} | "
                        f"bal_acc={val_bal_acc:.3f}"
                    )
                if patience_count >= self.patience:
                    print(f"  early stop at epoch {epoch + 1}")
                    break
            elif epoch == 0 or (epoch + 1) % 5 == 0:
                print(
                    f"  epoch {epoch + 1:3d}/{self.epochs} | "
                    f"loss={train_loss:.4f}"
                )

        if best_state is not None:
            self.model.load_state_dict(best_state)
            print(f"  best validation balanced accuracy: {best_score:.3f}")

        self.is_trained = True
        return self

    def fine_tune(
        self,
        X,
        y,
        X_val=None,
        y_val=None,
        epochs: int = 20,
        lr: float = 2e-4,
        patience: int = 10,
        scope: str = "head",
        refit_normalizer: bool = False,
    ) -> "HybridFBCMIFormerWrapper":
        """Adapt high-level layers to a labeled target-session calibration set."""
        if self.model is None or not self.is_trained:
            raise ValueError("Pretrain Hybrid FBC-MIFormer before fine-tuning")

        X = self._as_float_tensor(X)
        y = self._as_label_tensor(y)
        if refit_normalizer:
            self._fit_normalizer(X)
        X = self._normalize(X)
        has_validation = X_val is not None and y_val is not None
        if has_validation:
            X_val = self._as_float_tensor(X_val)
            y_val = self._as_label_tensor(y_val)

        if scope not in {"head", "all"}:
            raise ValueError("fine-tune scope must be 'head' or 'all'")
        if scope == "all":
            adaptation_modules = (self.model,)
            for parameter in self.model.parameters():
                parameter.requires_grad = True
        else:
            for parameter in self.model.parameters():
                parameter.requires_grad = False
            adaptation_modules = (
                self.model.global_pool,
                self.model.fusion_gate,
                self.model.spectral_branch.project,
                self.model.spectral_gate,
                self.model.classifier,
            )
            for module in adaptation_modules:
                for parameter in module.parameters():
                    parameter.requires_grad = True

        trainable_parameters = [
            parameter for parameter in self.model.parameters() if parameter.requires_grad
        ]
        dataset = EEGDatasetV2(X, y, augment=True, fs=self.fs)
        loader = torch.utils.data.DataLoader(
            dataset,
            batch_size=min(32, len(dataset)),
            shuffle=True,
            num_workers=0,
            pin_memory=self.use_amp,
            generator=torch.Generator().manual_seed(self.seed + 10_000),
        )
        optimizer = torch.optim.AdamW(
            trainable_parameters,
            lr=lr,
            weight_decay=self.weight_decay,
        )
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            optimizer,
            T_max=max(1, epochs * len(loader)),
            eta_min=lr * 0.05,
        )
        criterion = nn.CrossEntropyLoss(
            weight=self._class_weights(y).to(self.device),
            label_smoothing=0.02,
        )
        scaler = self._make_grad_scaler()
        best_score = -float("inf")
        best_state = None
        patience_count = 0

        print(
            f"  fine-tuning {sum(p.numel() for p in trainable_parameters):,} "
            f"high-level parameters on {len(X)} calibration epochs"
        )
        for epoch in range(epochs):
            if scope == "all":
                self.model.train()
            else:
                # Keep frozen BatchNorm statistics fixed while high-level
                # pooling, fusion and classifier layers adapt.
                self.model.eval()
                for module in adaptation_modules:
                    module.train()

            total_loss = 0.0
            for batch_x, batch_y in loader:
                batch_x = batch_x.to(self.device, non_blocking=self.use_amp)
                batch_y = batch_y.to(self.device, non_blocking=self.use_amp)
                optimizer.zero_grad(set_to_none=True)
                with self._autocast():
                    logits, _ = self.model(batch_x)
                    loss = criterion(logits, batch_y)
                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                nn.utils.clip_grad_norm_(trainable_parameters, 1.0)
                scale_before_step = scaler.get_scale()
                scaler.step(optimizer)
                scaler.update()
                if scaler.get_scale() >= scale_before_step:
                    scheduler.step()
                total_loss += float(loss.detach().cpu())

            score = None
            if has_validation:
                metrics = self.evaluate(X_val, y_val)
                score = metrics["balanced_accuracy"]
                if score > best_score + 1e-4:
                    best_score = score
                    best_state = {
                        key: value.detach().cpu().clone()
                        for key, value in self.model.state_dict().items()
                    }
                    patience_count = 0
                else:
                    patience_count += 1

            if epoch == 0 or (epoch + 1) % 5 == 0:
                message = (
                    f"  adapt {epoch + 1:3d}/{epochs} | "
                    f"loss={total_loss / max(1, len(loader)):.4f}"
                )
                if score is not None:
                    message += f" | bal_acc={score:.3f}"
                print(message)
            if has_validation and patience_count >= patience:
                print(f"  adaptation early stop at epoch {epoch + 1}")
                break

        if best_state is not None:
            self.model.load_state_dict(best_state)
            print(f"  best adaptation balanced accuracy: {best_score:.3f}")
        for parameter in self.model.parameters():
            parameter.requires_grad = True
        self.model.eval()
        return self

    def _mixup(
        self,
        batch_x: torch.Tensor,
        batch_y: torch.Tensor,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, float]:
        if self.mixup_alpha <= 0 or len(batch_x) < 2:
            return batch_x, batch_y, batch_y, 1.0
        lam = float(np.random.beta(self.mixup_alpha, self.mixup_alpha))
        permutation = torch.randperm(len(batch_x), device=batch_x.device)
        mixed = lam * batch_x + (1.0 - lam) * batch_x[permutation]
        return mixed, batch_y, batch_y[permutation], lam

    def predict(self, X, batch_size: int = 256) -> np.ndarray:
        return self.predict_proba(X, batch_size=batch_size).argmax(axis=1)

    def predict_proba(self, X, batch_size: int = 256) -> np.ndarray:
        if self.model is None:
            raise ValueError("Hybrid FBC-MIFormer has not been trained or loaded")

        X = self._normalize(self._as_float_tensor(X))
        probabilities = []
        self.model.eval()
        with torch.inference_mode():
            for start in range(0, len(X), batch_size):
                batch = X[start:start + batch_size].to(
                    self.device,
                    non_blocking=self.use_amp,
                )
                with self._autocast():
                    logits, _ = self.model(batch)
                probabilities.append(F.softmax(logits.float(), dim=1).cpu())
        return torch.cat(probabilities).numpy()

    def evaluate(self, X, y) -> Dict[str, float]:
        y_true = np.asarray(y.cpu().numpy() if isinstance(y, torch.Tensor) else y)
        y_pred = self.predict(X)
        return {
            "accuracy": float(accuracy_score(y_true, y_pred)),
            "balanced_accuracy": float(balanced_accuracy_score(y_true, y_pred)),
            "kappa": float(cohen_kappa_score(y_true, y_pred)),
        }

    def _eval(self, X, y) -> float:
        return self.evaluate(X, y)["accuracy"]

    def benchmark(
        self,
        sample,
        warmup: int = 20,
        runs: int = 100,
    ) -> Dict[str, float]:
        if self.model is None:
            raise ValueError("Hybrid FBC-MIFormer has not been trained or loaded")

        x = self._as_float_tensor(sample)
        if x.ndim == 2:
            x = x.unsqueeze(0)
        x = self._normalize(x).to(self.device)
        self.model.eval()

        with torch.inference_mode():
            for _ in range(warmup):
                self.model(x)
            self._synchronize()
            start = time.perf_counter()
            for _ in range(runs):
                self.model(x)
            self._synchronize()

        latency_ms = (time.perf_counter() - start) * 1000.0 / runs
        parameters = sum(p.numel() for p in self.model.parameters())
        model_size_mb = sum(
            p.numel() * p.element_size() for p in self.model.parameters()
        ) / (1024.0 ** 2)
        return {
            "parameters": float(parameters),
            "model_size_mb": float(model_size_mb),
            "latency_ms": float(latency_ms),
            "epochs_per_second": float(1000.0 / max(latency_ms, 1e-9)),
        }

    def _synchronize(self) -> None:
        if self.device.type == "cuda":
            torch.cuda.synchronize(self.device)

    def _autocast(self):
        if not self.use_amp:
            return nullcontext()
        if hasattr(torch, "amp") and hasattr(torch.amp, "autocast"):
            return torch.amp.autocast(device_type="cuda", enabled=True)
        return torch.cuda.amp.autocast(enabled=True)

    def _make_grad_scaler(self):
        if hasattr(torch, "amp") and hasattr(torch.amp, "GradScaler"):
            try:
                return torch.amp.GradScaler("cuda", enabled=self.use_amp)
            except TypeError:
                pass
        return torch.cuda.amp.GradScaler(enabled=self.use_amp)

    def save(self, path: str) -> None:
        if self.model is None:
            raise ValueError("No trained model to save")
        torch.save({
            "format_version": 4,
            "architecture": "hybrid_fbc_mi_former",
            "state": self.model.state_dict(),
            "history": self.history,
            "channel_mean": self.channel_mean,
            "channel_std": self.channel_std,
            "model_config": self._model_config(),
        }, path)
        print(f"  saved: {path}")

    def load(self, path: str) -> "HybridFBCMIFormerWrapper":
        checkpoint = torch.load(path, map_location=self.device)
        if checkpoint.get("architecture") != "hybrid_fbc_mi_former":
            raise ValueError(
                "This checkpoint predates Hybrid FBC-MIFormer and is not compatible; "
                "retrain it with the current code."
            )

        config = checkpoint["model_config"]
        for key, value in config.items():
            setattr(self, key, value)
        self.model = self._build_model()
        self.model.load_state_dict(checkpoint["state"])
        self.history = checkpoint.get("history", self.history)
        self.channel_mean = checkpoint["channel_mean"]
        self.channel_std = checkpoint["channel_std"]
        self.is_trained = True
        print(f"  loaded: {path}")
        return self

    def _model_config(self) -> Dict[str, object]:
        return {
            "fs": self.fs,
            "n_channels": self.n_channels,
            "d_model": self.d_model,
            "attention_heads": self.attention_heads,
            "attention_layers": self.attention_layers,
            "dropout": self.dropout,
        }

    def _split_train_val(self, X, y, groups=None, val_ratio: float = 0.2):
        y_np = y.numpy()
        indices = np.arange(len(y_np))

        if groups is not None:
            groups_np = np.asarray(groups)
            if len(groups_np) != len(y_np):
                raise ValueError("groups must have one value per EEG epoch")
            if len(np.unique(groups_np)) > 1:
                splitter = GroupShuffleSplit(
                    n_splits=1,
                    test_size=val_ratio,
                    random_state=self.seed,
                )
                train_idx, val_idx = next(splitter.split(indices, y_np, groups_np))
                return X[train_idx], X[val_idx], y[train_idx], y[val_idx]

        classes, counts = np.unique(y_np, return_counts=True)
        if len(classes) < 2 or counts.min() < 2 or len(y_np) < 10:
            return X, None, y, None
        train_idx, val_idx = train_test_split(
            indices,
            test_size=val_ratio,
            random_state=self.seed,
            stratify=y_np,
        )
        return X[train_idx], X[val_idx], y[train_idx], y[val_idx]

    def _fit_normalizer(self, X: torch.Tensor) -> None:
        X = self._epoch_rms_normalize(X)
        self.channel_mean = X.mean(dim=(0, 2), keepdim=True).cpu()
        self.channel_std = X.std(dim=(0, 2), keepdim=True).clamp_min(1e-7).cpu()

    def _normalize(self, X: torch.Tensor) -> torch.Tensor:
        X = self._epoch_rms_normalize(X)
        if self.channel_mean is None or self.channel_std is None:
            return X
        return (X - self.channel_mean.to(X.device)) / self.channel_std.to(X.device)

    @staticmethod
    def _epoch_rms_normalize(X: torch.Tensor) -> torch.Tensor:
        # This operation is per epoch and label-free, so it is safe for unseen
        # subjects and can be reproduced online one window at a time.
        X = X - X.mean(dim=-1, keepdim=True)
        rms = X.square().mean(dim=(1, 2), keepdim=True).sqrt().clamp_min(1e-7)
        return X / rms

    @staticmethod
    def _class_weights(y: torch.Tensor) -> torch.Tensor:
        counts = torch.bincount(y, minlength=2).float().clamp_min(1.0)
        return counts.sum() / (len(counts) * counts)

    @staticmethod
    def _as_float_tensor(X) -> torch.Tensor:
        if isinstance(X, torch.Tensor):
            return X.detach().cpu().float()
        return torch.from_numpy(np.asarray(X, dtype=np.float32))

    @staticmethod
    def _as_label_tensor(y) -> torch.Tensor:
        if isinstance(y, torch.Tensor):
            return y.detach().cpu().long()
        return torch.from_numpy(np.asarray(y, dtype=np.int64))


class EEGDatasetV2(torch.utils.data.Dataset):
    """Conservative EEG augmentations that preserve class semantics."""

    def __init__(self, X, y, augment: bool = False, fs: int = 100):
        self.X = X.float()
        self.y = y.long()
        self.augment = augment
        self.fs = fs

    def __len__(self) -> int:
        return len(self.X)

    def __getitem__(self, index: int) -> Tuple[torch.Tensor, torch.Tensor]:
        x = self.X[index].clone()
        y = self.y[index]

        if self.augment:
            if torch.rand(()) < 0.6:
                x += torch.randn_like(x) * float(torch.empty(1).uniform_(0.01, 0.04))
            if torch.rand(()) < 0.5:
                shift = int(torch.randint(-self.fs // 10, self.fs // 10 + 1, (1,)))
                x = torch.roll(x, shifts=shift, dims=-1)
            if torch.rand(()) < 0.4:
                x *= float(torch.empty(1).uniform_(0.9, 1.1))
            if torch.rand(()) < 0.15:
                channel = int(torch.randint(0, x.size(0), (1,)))
                x[channel] = 0

        return x, y
