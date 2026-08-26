// Synthetic test signals with known characteristics — used only by tests,
// never shipped to the app.
export function generateSineMix(
  frequenciesHz,
  { sampleRate = 48000, durationSamples = 8192, amplitude = 1, noiseAmplitude = 0 } = {}
) {
  const samples = new Float64Array(durationSamples);
  for (let i = 0; i < durationSamples; i++) {
    let v = 0;
    for (const f of frequenciesHz) {
      v += Math.sin((2 * Math.PI * f * i) / sampleRate);
    }
    v = (v / frequenciesHz.length) * amplitude;
    if (noiseAmplitude > 0) {
      v += (Math.random() * 2 - 1) * noiseAmplitude;
    }
    samples[i] = v;
  }
  return samples;
}

export function generateWhiteNoise(durationSamples, amplitude = 1) {
  const samples = new Float64Array(durationSamples);
  for (let i = 0; i < durationSamples; i++) {
    samples[i] = (Math.random() * 2 - 1) * amplitude;
  }
  return samples;
}
