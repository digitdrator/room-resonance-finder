// Decay-rate analysis: after an impulse/burst stops, measure how fast
// energy at each candidate frequency dies away in the recorded tail.
// A true resonance stores and releases energy slowly -- it keeps
// "ringing" after broadband content has already decayed. This is a
// fundamentally different signal from steady-state level (which cannot
// distinguish "loud because resonant" from "loud for any other reason").
// No microphone/DOM dependency -- testable on synthetic data alone.

// Goertzel algorithm: magnitude of a single target frequency within one
// block of samples. Standard technique for tracking a known frequency
// over short windows without a full FFT per window.
function goertzelMagnitude(samples, sampleRate, targetFreq) {
  const n = samples.length;
  const k = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * cosine;
  const imag = q2 * Math.sin(omega);
  return Math.sqrt(real * real + imag * imag) / (n / 2);
}

function linearRegression(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

// samples: ring-down recording, starting at (or shortly after) the
// moment excitation stopped. Tracks magnitude at each frequency over a
// sliding window and fits a linear decay slope (dB/sec) to it -- less
// negative (closer to zero, or positive) means slower decay, i.e. more
// "ringing."
export function estimateDecayRates(
  samples,
  sampleRate,
  frequenciesHz,
  { windowMs = 50, hopMs = 25 } = {}
) {
  const windowSize = Math.round((windowMs / 1000) * sampleRate);
  const hopSize = Math.round((hopMs / 1000) * sampleRate);

  const results = [];
  for (const freq of frequenciesHz) {
    const times = [];
    const levelsDb = [];
    for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
      const windowSamples = samples.subarray(start, start + windowSize);
      const magnitude = goertzelMagnitude(windowSamples, sampleRate, freq);
      levelsDb.push(20 * Math.log10(Math.max(magnitude, 1e-9)));
      times.push(start / sampleRate);
    }
    const { slope, intercept } = linearRegression(times, levelsDb);
    results.push({
      frequencyHz: freq,
      decayRateDbPerSec: slope,
      initialLevelDb: intercept,
      series: { times, levelsDb },
    });
  }
  return results;
}

// Ranks candidates by slowest decay (least negative slope), excluding
// anything that never had real signal to begin with (reuses the same
// SNR-gating idea as the stepped-sine scan).
export function rankRingingCandidates(decayResults, { minInitialLevelDb = -80, maxCandidates = 3 } = {}) {
  return decayResults
    .filter((r) => r.initialLevelDb >= minInitialLevelDb)
    .slice()
    .sort((a, b) => b.decayRateDbPerSec - a.decayRateDbPerSec)
    .slice(0, maxCandidates);
}
