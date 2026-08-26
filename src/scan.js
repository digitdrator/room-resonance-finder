// Stepped-sine frequency-response scan. Plays each test frequency for a
// fixed window while capturing the mic response via the already-tested
// Phase 1/2 primitives (startTone/stopTone/startCapture/stopCapture) --
// this file only sequences them, it does not touch the audio graph
// directly. Produces {frequencyHz, levelDb} pairs, not FFT peak-picking:
// since we know exactly which frequency is playing during each window,
// this is a direct measurement, not an estimate.
export const DEFAULT_TEST_FREQUENCIES_HZ = [
  40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Measures ambient noise with no tone playing, so scan results can be
// judged against it (signal near the noise floor is not a reliable
// measurement -- often means the speaker cannot produce real output at
// that frequency, not that the room is quiet there).
export async function measureNoiseFloor({ startCapture, stopCapture, durationMs = 500 } = {}) {
  startCapture();
  await sleep(durationMs);
  const capture = stopCapture();
  const rms = capture ? capture.rms : 0;
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

export async function runSteppedScan({
  frequencies = DEFAULT_TEST_FREQUENCIES_HZ,
  toneDurationMs = 500,
  settleMs = 150,
  gainLinear = 0.12,
  playTone,
  stopTone,
  startCapture,
  stopCapture,
  onStep,
} = {}) {
  const results = [];
  for (let i = 0; i < frequencies.length; i++) {
    const freq = frequencies[i];
    playTone(freq, gainLinear);
    await sleep(settleMs);

    startCapture();
    await sleep(toneDurationMs);
    const capture = stopCapture();

    stopTone();
    await sleep(settleMs);

    const rms = capture ? capture.rms : 0;
    const levelDb = 20 * Math.log10(Math.max(rms, 1e-9));
    const step = { frequencyHz: freq, levelDb };
    results.push(step);
    if (onStep) onStep(step, i + 1, frequencies.length);
  }
  return results;
}
