// Exponential sine sweep (ESS) measurement, Farina's method.
// See references.md: "Angelo Farina, Exponential Sine Sweep method".
//
// Play `sweep` through the speaker while recording. Convolving the
// recording with `inverseFilter` recovers the impulse response of the
// whole system (speaker -> air/room -> mic -> device). No microphone/DOM
// dependency here -- pure signal generation and math, testable on
// synthetic data.
import { fft, ifft, nextPowerOfTwo } from "./fft.js";

// f1, f2 in Hz, durationSec in seconds. Returns the sweep and its
// matched inverse filter (time-reversed sweep with a -6dB/octave
// amplitude envelope, which is what makes sweep (convolve) inverseFilter
// collapse to a clean impulse instead of a smeared pink-noise-like tail).
export function generateSweepAndInverse(f1, f2, durationSec, sampleRate) {
  const n = Math.round(durationSec * sampleRate);
  const T = durationSec;
  const R = Math.log(f2 / f1);

  const sweep = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    sweep[i] = Math.sin(((2 * Math.PI * f1 * T) / R) * (Math.exp((t * R) / T) - 1));
  }

  const inverseFilter = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-(t * R) / T);
    inverseFilter[i] = sweep[n - 1 - i] * envelope;
  }

  return { sweep, inverseFilter, sampleRate, durationSec: T, f1, f2 };
}

// Linear (non-circular) convolution via zero-padded FFT.
export function fftConvolve(a, b) {
  const resultLength = a.length + b.length - 1;
  const n = nextPowerOfTwo(resultLength);

  const aReal = new Float64Array(n);
  aReal.set(a);
  const aImag = new Float64Array(n);
  const bReal = new Float64Array(n);
  bReal.set(b);
  const bImag = new Float64Array(n);

  fft(aReal, aImag);
  fft(bReal, bImag);

  const cReal = new Float64Array(n);
  const cImag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cReal[i] = aReal[i] * bReal[i] - aImag[i] * bImag[i];
    cImag[i] = aReal[i] * bImag[i] + aImag[i] * bReal[i];
  }

  ifft(cReal, cImag);
  return cReal.slice(0, resultLength);
}

// Deconvolves a recorded sweep response against the matched inverse
// filter to recover the system's impulse response. The clean linear
// impulse response is centered near index (sweepLength - 1); harmonic
// distortion products fall before that point (Farina's method), so
// callers that care about isolating them can window accordingly.
export function deconvolve(recorded, inverseFilter) {
  return fftConvolve(recorded, inverseFilter);
}
