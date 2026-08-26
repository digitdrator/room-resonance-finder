// Offline frequency analysis. No microphone/DOM dependency — testable on
// synthetic data alone. Not yet wired to real captured audio (Gate 3 must
// pass first).
import { fft } from "./fft.js";

export function hannWindow(length) {
  const w = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
  }
  return w;
}

// samples length must be a power of two.
export function magnitudeSpectrum(samples, sampleRate) {
  const n = samples.length;
  const window = hannWindow(n);
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    real[i] = samples[i] * window[i];
  }
  fft(real, imag);

  const half = n / 2;
  const frequencies = new Float64Array(half);
  const magnitudes = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    frequencies[i] = (i * sampleRate) / n;
    magnitudes[i] = Math.hypot(real[i], imag[i]);
  }
  return { frequencies, magnitudes };
}

// Local-maxima peak picking, prominence relative to a local average
// "noise floor" around each candidate bin. Deliberately simple — good
// enough to validate against synthetic signals, not a final algorithm.
export function findPeaks(
  frequencies,
  magnitudes,
  { maxPeaks = 5, minProminenceDb = 6, neighborhoodBins = 20, minRelativeToMaxDb = 60 } = {}
) {
  const n = magnitudes.length;
  const magDb = new Float64Array(n);
  let globalMaxDb = -Infinity;
  for (let i = 0; i < n; i++) {
    magDb[i] = 20 * Math.log10(Math.max(magnitudes[i], 1e-9));
    if (magDb[i] > globalMaxDb) globalMaxDb = magDb[i];
  }
  // Below this, a bin is numerical noise floor / silence, not signal —
  // without this gate, near-zero magnitude bins in an otherwise silent
  // region can show huge *relative* prominence against an even quieter
  // neighborhood while carrying no real energy.
  const absoluteFloorDb = globalMaxDb - minRelativeToMaxDb;

  const candidates = [];
  for (let i = 2; i < n - 2; i++) {
    if (magDb[i] < absoluteFloorDb) continue;

    const isLocalMax =
      magDb[i] > magDb[i - 1] &&
      magDb[i] >= magDb[i + 1] &&
      magDb[i] > magDb[i - 2] &&
      magDb[i] >= magDb[i + 2];
    if (!isLocalMax) continue;

    const lo = Math.max(0, i - neighborhoodBins);
    const hi = Math.min(n, i + neighborhoodBins + 1);
    let sum = 0;
    let count = 0;
    for (let k = lo; k < hi; k++) {
      if (k === i) continue;
      sum += magDb[k];
      count++;
    }
    const localAvg = count > 0 ? sum / count : magDb[i];
    const prominenceDb = magDb[i] - localAvg;

    if (prominenceDb >= minProminenceDb) {
      candidates.push({
        frequencyHz: frequencies[i],
        magnitudeDb: magDb[i],
        prominenceDb,
      });
    }
  }

  candidates.sort((a, b) => b.prominenceDb - a.prominenceDb);
  return candidates.slice(0, maxPeaks);
}
