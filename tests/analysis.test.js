import test from "node:test";
import assert from "node:assert/strict";
import { magnitudeSpectrum, findPeaks } from "../src/analysis.js";
import { generateSineMix, generateWhiteNoise } from "./synthetic-signals.js";

const SAMPLE_RATE = 48000;
const N = 8192;
const BIN_HZ = SAMPLE_RATE / N; // ~5.86 Hz
const TOLERANCE_HZ = BIN_HZ * 2;

test("finds a single known frequency", () => {
  const samples = generateSineMix([220], { sampleRate: SAMPLE_RATE, durationSamples: N });
  const { frequencies, magnitudes } = magnitudeSpectrum(samples, SAMPLE_RATE);
  const peaks = findPeaks(frequencies, magnitudes, { maxPeaks: 3, minProminenceDb: 6 });

  assert.ok(peaks.length >= 1, "expected at least one peak");
  const closest = peaks.reduce((a, b) =>
    Math.abs(a.frequencyHz - 220) < Math.abs(b.frequencyHz - 220) ? a : b
  );
  assert.ok(
    Math.abs(closest.frequencyHz - 220) <= TOLERANCE_HZ,
    `closest peak ${closest.frequencyHz} Hz too far from 220 Hz`
  );
});

test("finds several pre-set peaks", () => {
  const targetFreqs = [80, 220, 500];
  const samples = generateSineMix(targetFreqs, { sampleRate: SAMPLE_RATE, durationSamples: N });
  const { frequencies, magnitudes } = magnitudeSpectrum(samples, SAMPLE_RATE);
  const peaks = findPeaks(frequencies, magnitudes, { maxPeaks: 5, minProminenceDb: 3 });

  for (const target of targetFreqs) {
    const found = peaks.some((p) => Math.abs(p.frequencyHz - target) <= TOLERANCE_HZ);
    assert.ok(found, `expected a peak near ${target} Hz, got ${JSON.stringify(peaks)}`);
  }
});

test("still finds the peak with added noise", () => {
  const samples = generateSineMix([300], {
    sampleRate: SAMPLE_RATE,
    durationSamples: N,
    amplitude: 1,
    noiseAmplitude: 0.2,
  });
  const { frequencies, magnitudes } = magnitudeSpectrum(samples, SAMPLE_RATE);
  const peaks = findPeaks(frequencies, magnitudes, { maxPeaks: 5, minProminenceDb: 6 });

  const found = peaks.some((p) => Math.abs(p.frequencyHz - 300) <= TOLERANCE_HZ);
  assert.ok(found, `expected a peak near 300 Hz despite noise, got ${JSON.stringify(peaks)}`);
});

test("pure white noise does not produce a high-prominence peak", () => {
  const samples = generateWhiteNoise(N, 1);
  const { frequencies, magnitudes } = magnitudeSpectrum(samples, SAMPLE_RATE);
  const peaks = findPeaks(frequencies, magnitudes, { maxPeaks: 5, minProminenceDb: 6 });

  for (const p of peaks) {
    assert.ok(p.prominenceDb < 15, `unexpectedly confident peak in pure noise: ${JSON.stringify(p)}`);
  }
});
