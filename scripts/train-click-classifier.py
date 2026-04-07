#!/usr/bin/env python3
"""
Click classifier training script.

Input:  JSON file exported from click-collect.html
        { samples: [{label, fft: [float...], sampleRate}], counts: {...} }

Output: weights.json  — { classes, weights, bias, fftSize, sampleRate }
        Used by clickDetect.ts for in-browser inference:
          score[c] = dot(weights[c], fftFrame) + bias[c]
          predicted = argmax(score)
"""

import json
import sys
import numpy as np
from pathlib import Path

try:
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import cross_val_score
except ImportError:
    print("pip install scikit-learn numpy")
    sys.exit(1)

# ── config ──────────────────────────────────────────────────────────────────
# For click detection we care about: is this a tongue click?
# Binary mode: click+dblclick = positive, everything else = negative.
# Multiclass mode: train on all labels, inference uses argmax.
MODE = "binary"   # "binary" or "multiclass"

POSITIVE_LABELS = {"click", "dblclick"}
NEGATIVE_LABELS = {"pop", "typing", "knock", "fan", "ambient"}

# Frequency range to use as features (Hz).
# Below LO_HZ is mostly floor hum; above HI_HZ is noise.
# Using the same range as the browser analyser.
LO_HZ = 200
HI_HZ = 16000   # will be capped at nyquist

# ── load data ────────────────────────────────────────────────────────────────
def load(path: str):
    with open(path) as f:
        data = json.load(f)
    samples = data["samples"]
    print(f"Loaded {len(samples)} samples from {path}")
    counts = {}
    for s in samples:
        counts[s["label"]] = counts.get(s["label"], 0) + 1
    print("  counts:", counts)
    return samples

# ── feature extraction ───────────────────────────────────────────────────────
def fft_to_features(fft_dbfs: list[float], sample_rate: int, lo_hz: float, hi_hz: float) -> np.ndarray:
    """
    Convert a dBFS FFT frame to a feature vector.
    - Slice to [lo_hz, hi_hz]
    - Convert dBFS → linear power
    - L1-normalise so amplitude doesn't dominate
    """
    n = len(fft_dbfs)
    nyquist = sample_rate / 2
    bin_width = nyquist / n
    lo_bin = max(0, int(lo_hz / bin_width))
    hi_bin = min(n - 1, int(min(hi_hz, nyquist * 0.95) / bin_width))

    arr = np.array(fft_dbfs[lo_bin:hi_bin+1], dtype=np.float32)
    # dBFS → linear power
    linear = np.power(10.0, arr / 20.0)
    linear_power = linear ** 2
    # L1 normalise (shape, not amplitude)
    total = linear_power.sum()
    if total > 0:
        linear_power /= total
    return linear_power

def build_xy(samples, mode, lo_hz, hi_hz):
    X, y, labels_used = [], [], []
    sr = samples[0]["sampleRate"]
    fft_size = len(samples[0]["fft"])

    for s in samples:
        feat = fft_to_features(s["fft"], s["sampleRate"], lo_hz, hi_hz)
        X.append(feat)
        if mode == "binary":
            y.append(1 if s["label"] in POSITIVE_LABELS else 0)
        else:
            y.append(s["label"])
        labels_used.append(s["label"])

    return np.array(X), np.array(y), sr, fft_size

# ── train ────────────────────────────────────────────────────────────────────
def train(X, y, mode):
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    if mode == "binary":
        clf = LogisticRegression(C=0.1, max_iter=1000, class_weight="balanced")
    else:
        clf = LogisticRegression(C=0.1, max_iter=1000, multi_class="ovr", class_weight="balanced")

    # Cross-val score
    cv = min(5, min(np.bincount(y if mode == "binary" else
                                np.array([list(set(y)).index(l) for l in y]))))
    if cv >= 2:
        scores = cross_val_score(clf, X_scaled, y, cv=cv, scoring="f1_weighted")
        print(f"  CV f1 ({cv}-fold): {scores.mean():.3f} ± {scores.std():.3f}")

    clf.fit(X_scaled, y)
    print(f"  Train accuracy: {clf.score(X_scaled, y):.3f}")
    return clf, scaler

# ── export ───────────────────────────────────────────────────────────────────
def export(clf, scaler, sr, fft_size, lo_hz, hi_hz, mode, out_path):
    """
    Export weights so the browser can do:
      features = fft_to_features(frame)  // same normalisation
      features_scaled = (features - mean) / std
      score = dot(weights, features_scaled) + bias
      isClick = score > threshold   (binary)
    """
    nyquist = sr / 2
    bin_width = nyquist / fft_size
    lo_bin = max(0, int(lo_hz / bin_width))
    hi_bin = min(fft_size - 1, int(min(hi_hz, nyquist * 0.95) / bin_width))
    n_features = hi_bin - lo_bin + 1

    out = {
        "mode": mode,
        "sampleRate": sr,
        "fftSize": fft_size,
        "loBin": lo_bin,
        "hiBin": hi_bin,
        "nFeatures": n_features,
        "scalerMean": scaler.mean_.tolist(),
        "scalerStd": scaler.scale_.tolist(),
    }

    if mode == "binary":
        out["classes"] = [0, 1]
        out["weights"] = clf.coef_[0].tolist()
        out["bias"] = float(clf.intercept_[0])
        out["threshold"] = 0.0   # adjust to trade precision/recall
        print(f"  {n_features} features, binary weights shape: {clf.coef_.shape}")
    else:
        out["classes"] = list(clf.classes_)
        out["weights"] = clf.coef_.tolist()
        out["bias"] = clf.intercept_.tolist()
        print(f"  {n_features} features, multiclass weights shape: {clf.coef_.shape}")

    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"Wrote {out_path}  ({Path(out_path).stat().st_size // 1024}KB)")

# ── main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python train-click-classifier.py <samples.json> [weights_out.json]")
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else in_path.replace(".json", "-weights.json")

    samples = load(in_path)
    if not samples:
        print("No samples found.")
        sys.exit(1)

    X, y, sr, fft_size = build_xy(samples, MODE, LO_HZ, HI_HZ)
    print(f"\nFeature matrix: {X.shape}, labels: {np.unique(y)}")

    clf, scaler = train(X, y, MODE)
    export(clf, scaler, sr, fft_size, LO_HZ, HI_HZ, MODE, out_path)
    print("\nDone. Load weights in clickDetect.ts via loadClassifier(weightsUrl).")
