"""Fast, label-free Euclidean alignment for cross-session EEG decoding."""

from __future__ import annotations

from typing import Dict, Optional, Tuple

import numpy as np


class EuclideanAligner:
    """Estimate and apply a small spatial whitening transform."""

    def __init__(self, regularization: float = 1e-5):
        self.regularization = regularization
        self.matrix: Optional[np.ndarray] = None

    def fit(self, epochs: np.ndarray) -> "EuclideanAligner":
        epochs = _validate_epochs(epochs)
        centered = epochs - epochs.mean(axis=2, keepdims=True)
        covariances = centered @ centered.transpose(0, 2, 1)
        covariances /= max(1, centered.shape[2] - 1)
        traces = np.trace(covariances, axis1=1, axis2=2)
        covariances /= np.maximum(traces[:, None, None], 1e-12)

        reference = covariances.mean(axis=0)
        reference += self.regularization * np.eye(reference.shape[0])
        eigenvalues, eigenvectors = np.linalg.eigh(reference)
        eigenvalues = np.maximum(eigenvalues, self.regularization)
        self.matrix = (
            eigenvectors
            @ np.diag(eigenvalues ** -0.5)
            @ eigenvectors.T
        ).astype(np.float32)
        return self

    def transform(self, epochs: np.ndarray) -> np.ndarray:
        if self.matrix is None:
            raise ValueError("EuclideanAligner must be fitted before transform")
        epochs = _validate_epochs(epochs)
        centered = epochs - epochs.mean(axis=2, keepdims=True)
        return np.einsum("ij,njt->nit", self.matrix, centered).astype(np.float32)

    def fit_transform(self, epochs: np.ndarray) -> np.ndarray:
        return self.fit(epochs).transform(epochs)


def align_by_group(
    epochs: np.ndarray,
    groups: np.ndarray,
    regularization: float = 1e-5,
) -> Tuple[np.ndarray, Dict[str, np.ndarray]]:
    """Align each recording/session independently without using labels."""
    epochs = _validate_epochs(epochs)
    groups = np.asarray(groups)
    if len(groups) != len(epochs):
        raise ValueError("groups must have one value per EEG epoch")

    aligned = np.empty_like(epochs, dtype=np.float32)
    matrices: Dict[str, np.ndarray] = {}
    for group in np.unique(groups):
        indices = np.flatnonzero(groups == group)
        aligner = EuclideanAligner(regularization=regularization)
        aligned[indices] = aligner.fit_transform(epochs[indices])
        matrices[str(group)] = aligner.matrix
    return aligned, matrices


def _validate_epochs(epochs: np.ndarray) -> np.ndarray:
    epochs = np.asarray(epochs, dtype=np.float32)
    if epochs.ndim != 3:
        raise ValueError("Expected epochs with shape (samples, channels, time)")
    if len(epochs) == 0:
        raise ValueError("Cannot align an empty EEG array")
    return epochs
