import test from "node:test";
import assert from "node:assert/strict";
import { estimateDecayRates, rankRingingCandidates } from "../src/decay-analysis.js";

const SAMPLE_RATE = 48000;

// Synthetic ring-down: one frequency decays slowly (long time constant --
// simulates a resonance storing energy), several others decay fast
// (simulates ordinary broadband reflections dying out quickly), plus a
// small noise floor.
function generateRingdown({
  sampleRate = SAMPLE_RATE,
  durationSec = 1.5,
  resonantFreq,
  resonantTau = 1.2,
  broadbandFreqs = [],
  broadbandTau = 0.15,
  noiseAmplitude = 0.01,
} = {}) {
  const n = Math.round(durationSec * sampleRate);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = Math.exp(-t / resonantTau) * Math.sin(2 * Math.PI * resonantFreq * t);
    for (const f of broadbandFreqs) {
      v += 0.5 * Math.exp(-t / broadbandTau) * Math.sin(2 * Math.PI * f * t);
    }
    v += (Math.random() * 2 - 1) * noiseAmplitude;
    samples[i] = v;
  }
  return samples;
}

test("identifies the slow-decaying frequency as the ringing candidate", () => {
  const samples = generateRingdown({
    resonantFreq: 200,
    broadbandFreqs: [300, 500, 800],
  });
  const decay = estimateDecayRates(samples, SAMPLE_RATE, [200, 300, 500, 800]);

  const resonant = decay.find((d) => d.frequencyHz === 200);
  const others = decay.filter((d) => d.frequencyHz !== 200);

  for (const other of others) {
    assert.ok(
      resonant.decayRateDbPerSec > other.decayRateDbPerSec,
      `expected 200 Hz (${resonant.decayRateDbPerSec.toFixed(1)} dB/s) to decay slower than ${other.frequencyHz} Hz (${other.decayRateDbPerSec.toFixed(1)} dB/s)`
    );
  }

  const ranked = rankRingingCandidates(decay);
  assert.equal(ranked[0].frequencyHz, 200);
});

test("works regardless of which frequency is the slow-decaying one", () => {
  const samples = generateRingdown({
    resonantFreq: 630,
    broadbandFreqs: [100, 250, 1000],
  });
  const decay = estimateDecayRates(samples, SAMPLE_RATE, [100, 250, 630, 1000]);
  const ranked = rankRingingCandidates(decay);
  assert.equal(ranked[0].frequencyHz, 630);
});

test("a flat (non-decaying) tone is ranked above fast-decaying ones", () => {
  // sustained tone (tau effectively infinite) vs fast-decaying broadband --
  // a sustained resonance should still win.
  const sampleRate = SAMPLE_RATE;
  const durationSec = 1.5;
  const n = Math.round(durationSec * sampleRate);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = Math.sin(2 * Math.PI * 400 * t); // no decay at all
    v += 0.5 * Math.exp(-t / 0.15) * Math.sin(2 * Math.PI * 900 * t);
    v += (Math.random() * 2 - 1) * 0.01;
    samples[i] = v;
  }
  const decay = estimateDecayRates(samples, sampleRate, [400, 900]);
  const ranked = rankRingingCandidates(decay);
  assert.equal(ranked[0].frequencyHz, 400);
});
