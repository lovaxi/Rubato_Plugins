// Rubato duration estimator for the Cursor plugin — zero-token, feature-based
// kNN. The predictor math is IDENTICAL to the dsh/ plugin (authoritative:
// dsh/lib/index.js): log-scale feature distance, k = min(5, samples),
// weight 1/(1+d), prior 4000 + c * 0.018 ms.
//
// The only hook-layer difference (spec §7): Cursor exposes no request object,
// so the only honest free feature is the opening edit scale of a burst. The
// remaining dsh features are pinned constants (l/f/v/fl = 0, n = 1, e = '') —
// they contribute nothing to the distance (all samples share them) but keep
// the sample store field-compatible with the other harnesses.
'use strict'

// Features at burst open: c = inserted+deleted chars of the first AI-like
// edit (the observable stand-in for dsh's context-size feature).
function extractBurstFeatures(chars) {
  return {
    c: Math.max(0, Math.round(chars)),
    l: 0,
    f: 0,
    v: 0,
    fl: 0,
    n: 1,
    e: '',
  }
}

// Prior (ms) used only while a model has zero samples: small constant plus a
// linear term on context size, roughly matching observed real durations.
function priorMs(feat) {
  return 4000 + feat.c * 0.018
}

// Predict duration (ms): k-nearest historical samples by log-scale feature
// distance, weighted by 1/(1+distance). Effort mismatch is a first-class
// difficulty signal (weight 0.4); message count captures turn depth.
function predictMs(samples, feat) {
  if (!Array.isArray(samples) || samples.length === 0) return priorMs(feat)
  const lc = Math.log(feat.c + 1)
  const ll = Math.log(feat.l + 1)
  const ln = Math.log(feat.n + 1)
  const scored = samples.map((s) => ({
    ms: s.ms,
    d: Math.abs(lc - Math.log((s.c || 0) + 1))
      + Math.abs(ll - Math.log((s.l || 0) + 1)) * 0.3
      + Math.abs(ln - Math.log((s.n || 0) + 1)) * 0.3
      + ((feat.e || '') !== (s.e || '') ? 0.4 : 0)
      + Math.abs((feat.f || 0) - (s.f || 0)) * 0.2
      + ((feat.v || 0) !== (s.v || 0) ? 0.1 : 0)
      + ((feat.fl || 0) !== (s.fl || 0) ? 0.1 : 0),
  }))
  scored.sort((a, b) => a.d - b.d)
  const k = Math.min(5, scored.length)
  let wsum = 0
  let msum = 0
  for (let i = 0; i < k; i += 1) {
    const w = 1 / (1 + scored[i].d)
    wsum += w
    msum += w * scored[i].ms
  }
  return wsum > 0 ? msum / wsum : priorMs(feat)
}

module.exports = { extractBurstFeatures, priorMs, predictMs }
