import test from "node:test";
import assert from "node:assert/strict";
import { generateSweepAndInverse, fftConvolve, deconvolve } from "../src/sweep.js";
import { estimateDecayRates, rankRingingCandidates } from "../src/decay-analysis.js";

const SAMPLE_RATE = 48000;

test("sweep convolved with its own inverse filter collapses to a clean impulse", () => {
  const { sweep, inverseFilter } = generateSweepAndInverse(40, 4000, 1.0, SAMPLE_RATE);
  const ir = fftConvolve(sweep, inverseFilter);

  let peakIdx = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < ir.length; i++) {
    if (Math.abs(ir[i]) > peakVal) {
      peakVal = Math.abs(ir[i]);
      peakIdx = i;
    }
  }
  // The linear impulse response of a perfect (identity) system appears
  // exactly at sweep.length - 1 -- this is the core sanity check that the
  // Farina inverse-filter formula and the FFT convolution are correct.
  assert.equal(peakIdx, sweep.length - 1);

  let nearEnergy = 0;
  let totalEnergy = 0;
  for (let i = 0; i < ir.length; i++) {
    const e = ir[i] * ir[i];
    totalEnergy += e;
    if (Math.abs(i - peakIdx) <= 5) nearEnergy += e;
  }
  assert.ok(
    nearEnergy / totalEnergy > 0.8,
    `expected most energy concentrated at the peak, got ${(nearEnergy / totalEnergy).toFixed(3)}`
  );
});

test("recovers a known resonance from a synthetic room impulse response via sweep+deconvolution+decay analysis", () => {
  const { sweep, inverseFilter } = generateSweepAndInverse(40, 4000, 1.0, SAMPLE_RATE);

  // Synthetic room: fast-decaying broadband reflections + one slow,
  // deliberately-injected resonance, plus a direct-sound spike.
  const roomDurationSec = 1.5;
  const roomN = Math.round(roomDurationSec * SAMPLE_RATE);
  const roomIR = new Float64Array(roomN);
  const resonantFreq = 200;
  const broadbandFreqs = [300, 500, 800];
  for (let i = 0; i < roomN; i++) {
    const t = i / SAMPLE_RATE;
    let v = Math.exp(-t / 1.2) * Math.sin(2 * Math.PI * resonantFreq * t);
    for (const f of broadbandFreqs) {
      v += 0.5 * Math.exp(-t / 0.15) * Math.sin(2 * Math.PI * f * t);
    }
    roomIR[i] = v;
  }
  roomIR[0] += 3; // direct sound

  // Simulate the recording: sweep passed through the room's impulse response.
  const recorded = fftConvolve(sweep, roomIR);
  const recoveredIR = deconvolve(recorded, inverseFilter);

  // Locate the recovered impulse peak near the expected offset.
  let peakIdx = 0;
  let peakVal = -Infinity;
  const searchStart = Math.max(0, sweep.length - 2000);
  const searchEnd = Math.min(recoveredIR.length, sweep.length + 5000);
  for (let i = searchStart; i < searchEnd; i++) {
    if (Math.abs(recoveredIR[i]) > peakVal) {
      peakVal = Math.abs(recoveredIR[i]);
      peakIdx = i;
    }
  }
  assert.ok(
    Math.abs(peakIdx - (sweep.length - 1)) < 1000,
    `recovered IR peak at ${peakIdx}, expected near ${sweep.length - 1}`
  );

  // Ring-down window: skip 10ms past the peak (direct sound) then take 1.2s.
  const tailStart = peakIdx + Math.round(0.01 * SAMPLE_RATE);
  const tailLength = Math.round(1.2 * SAMPLE_RATE);
  const tail = recoveredIR.subarray(tailStart, tailStart + tailLength);

  const candidateFreqs = [resonantFreq, ...broadbandFreqs];
  const decay = estimateDecayRates(tail, SAMPLE_RATE, candidateFreqs);
  const ranked = rankRingingCandidates(decay);

  assert.equal(ranked[0].frequencyHz, resonantFreq);

  const resonantDecay = decay.find((d) => d.frequencyHz === resonantFreq);
  for (const f of broadbandFreqs) {
    const other = decay.find((d) => d.frequencyHz === f);
    assert.ok(
      resonantDecay.decayRateDbPerSec > other.decayRateDbPerSec,
      `expected ${resonantFreq} Hz to decay slower than ${f} Hz`
    );
  }
});
