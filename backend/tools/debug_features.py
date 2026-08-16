"""离线调试：BCICIV 2b 三通道 CSP/LDA 特征对比。"""
import sys
import numpy as np

sys.path.insert(0, r"D:\deepseek\tongyun-bci-algorithm")

from tongyun_bci_algorithm import load_single_session
from scipy.linalg import eigh
from scipy.signal import butter, filtfilt
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis as LDA
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import accuracy_score

X, y = load_single_session(r"D:\db\BCICIV_2b_gdf\B0101T.gdf", tmin=0.5, tmax=4.0, sample_rate=100)
print(f"X={X.shape} y={y.shape} balance={np.bincount(y)}")
X = np.asarray(X, dtype=np.float64)

def bandpass(data, lo, hi, fs=100):
    nyq = fs / 2
    b, a = butter(4, [lo / nyq, hi / nyq], btype="band")
    return filtfilt(b, a, data, axis=-1)

def csp_filters(X_tr, y_tr, n_pairs=1):
    cov1 = np.mean([np.cov(x) for x, l in zip(X_tr, y_tr) if l == 0], axis=0)
    cov2 = np.mean([np.cov(x) for x, l in zip(X_tr, y_tr) if l == 1], axis=0)
    lam, W = eigh(cov2, cov1 + cov2 + 1e-5 * np.eye(3))
    order = np.argsort(lam)[::-1]
    keep = list(order[:n_pairs]) + list(order[-n_pairs:])
    for idx in order:
        if idx not in keep:
            keep.append(idx)
        if len(keep) >= 3:
            break
    return W[:, keep]

def csp_features(X, W):
    proj = np.tensordot(X, W, axes=([1], [0]))
    var = np.var(proj, axis=2)
    var = var / (var.sum(axis=1, keepdims=True) + 1e-10)
    return np.log(var + 1e-10)

def bandpower_features(X):
    F = []
    bands = [(8, 13), (13, 30), (4, 8), (20, 30)]
    for x in X:
        fv = []
        for ch in range(3):
            for lo, hi in bands:
                fv.append(np.var(bandpass(x[ch], lo, hi)))
        for lo, hi in bands[:2]:
            c3 = np.var(bandpass(x[0], lo, hi)) + 1e-12
            c4 = np.var(bandpass(x[2], lo, hi)) + 1e-12
            fv.extend([np.log(c3 / c4), (c3 - c4) / (c3 + c4)])
        F.append(fv)
    return np.array(F)

def evaluate(feature_fn, name):
    skf = StratifiedKFold(n_splits=4, shuffle=True, random_state=42)
    scores = []
    for tr, te in skf.split(X, y):
        W = csp_filters(X[tr], y[tr])
        f_tr, f_te = feature_fn(X[tr], W), feature_fn(X[te], W)
        model = LDA()
        model.fit(f_tr, y[tr])
        scores.append(accuracy_score(y[te], model.predict(f_te)))
    print(f"{name}: {np.mean(scores):.3f} (+/- {np.std(scores):.3f})  per-fold={[round(s,3) for s in scores]}")

evaluate(lambda x, w: csp_features(x, w), "CSP log-var (3 filt)")
evaluate(lambda x, w: np.hstack([csp_features(x, w), bandpower_features(x)]), "CSP + bandpower")

# FBCSP: 4 个频带 CSP
def fbcsp_features(X_tr, y_tr, X_te):
    bands = [(4, 8), (8, 12), (12, 16), (16, 20), (20, 24), (24, 28), (28, 32), (32, 38)]
    f_trs, f_tes = [], []
    for lo, hi in bands:
        Xb_tr = bandpass(X_tr, lo, hi)
        Xb_te = bandpass(X_te, lo, hi)
        W = csp_filters(Xb_tr, y_tr)
        f_trs.append(csp_features(Xb_tr, W))
        f_tes.append(csp_features(Xb_te, W))
    return np.hstack(f_trs), np.hstack(f_tes)

skf = StratifiedKFold(n_splits=4, shuffle=True, random_state=42)
scores = []
for tr, te in skf.split(X, y):
    f_tr, f_te = fbcsp_features(X[tr], y[tr], X[te])
    model = LDA()
    model.fit(f_tr, y[tr])
    scores.append(accuracy_score(y[te], model.predict(f_te)))
print(f"FBCSP 8-band: {np.mean(scores):.3f} (+/- {np.std(scores):.3f})  per-fold={[round(s,3) for s in scores]}")

# 原始数据直接均值方差特征
def basic_features(x, w=None):
    return np.hstack([np.mean(x, axis=2), np.std(x, axis=2), np.var(bandpass(x, 8, 13), axis=2), np.var(bandpass(x, 13, 30), axis=2)])

evaluate(basic_features, "basic mean/std/bandvar")
