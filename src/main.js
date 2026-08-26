import {
  getAudioContext,
  enableMicrophone,
  disableMicrophone,
  startTone,
  stopTone,
  setToneFrequency,
  setToneGain,
  isToneActive,
  loadCaptureWorklet,
  startCapture,
  stopCapture,
  playBuffer,
  stopBuffer,
} from "./audio-io.js";
import { generateSweepAndInverse, deconvolve } from "./sweep.js";
import { estimateDecayRates, rankRingingCandidates } from "./decay-analysis.js";

const micBtn = document.getElementById("mic-btn");
const micDisableBtn = document.getElementById("mic-disable-btn");
const micStatus = document.getElementById("mic-status");
const levelBar = document.getElementById("level-bar");
const spectrumCanvas = document.getElementById("spectrum");
const trackSettingsEl = document.getElementById("track-settings");
const contextInfoEl = document.getElementById("context-info");

const toneBtn = document.getElementById("tone-btn");
const freqSlider = document.getElementById("freq-slider");
const freqValue = document.getElementById("freq-value");
const gainSlider = document.getElementById("gain-slider");
const gainValue = document.getElementById("gain-value");

const sweepBtn = document.getElementById("sweep-btn");
const sweepStatusEl = document.getElementById("sweep-status");
const sweepWaveformCanvas = document.getElementById("sweep-waveform");
const sweepIrCanvas = document.getElementById("sweep-ir");
const sweepDecayCanvas = document.getElementById("sweep-decay-curves");
const sweepLegendEl = document.getElementById("sweep-legend");
const sweepCandidatesListEl = document.getElementById("sweep-candidates-list");

const spectrumCtx = spectrumCanvas.getContext("2d");
let analyser = null;

const SWEEP_F1 = 40;
const SWEEP_F2 = 4000;
const SWEEP_DURATION_SEC = 3;
const SWEEP_TAIL_SEC = 2.5;
const SWEEP_GAIN = 0.15;
const DECAY_CANDIDATE_FREQUENCIES_HZ = [
  40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
  1250, 1600, 2000, 2500, 3150,
];
const DECAY_CURVE_COLORS = ["#f93", "#39f", "#f3c"];
let sweepRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

micBtn.addEventListener("click", async () => {
  micBtn.disabled = true;
  micStatus.textContent = "Requesting permission…";
  try {
    const { analyserNode, trackSettings } = await enableMicrophone();
    analyser = analyserNode;
    micStatus.textContent = "Microphone active.";
    trackSettingsEl.textContent = JSON.stringify(trackSettings, null, 2);
    renderContextInfo();
    requestAnimationFrame(drawLoop);
    sweepBtn.disabled = false;
    micBtn.hidden = true;
    micDisableBtn.hidden = false;
  } catch (err) {
    micStatus.textContent = `Failed: ${err.message}`;
  } finally {
    micBtn.disabled = false;
  }
});

micDisableBtn.addEventListener("click", () => {
  disableMicrophone();
  analyser = null;
  micStatus.textContent = "Microphone disabled.";
  levelBar.style.width = "0%";
  spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  sweepBtn.disabled = true;
  micDisableBtn.hidden = true;
  micBtn.hidden = false;
});

function renderContextInfo() {
  const ctx = getAudioContext();
  contextInfoEl.textContent = JSON.stringify(
    {
      sampleRate: ctx.sampleRate,
      state: ctx.state,
      baseLatency: ctx.baseLatency,
      outputLatency: ctx.outputLatency ?? null,
      userAgent: navigator.userAgent,
    },
    null,
    2
  );
}

function drawLoop() {
  if (!analyser) return;

  const freqData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqData);

  const timeData = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(timeData);

  let sumSquares = 0;
  for (let i = 0; i < timeData.length; i++) {
    const centered = (timeData[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  const rms = Math.sqrt(sumSquares / timeData.length);
  levelBar.style.width = `${Math.min(100, rms * 300)}%`;

  spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  const barWidth = spectrumCanvas.width / freqData.length;
  spectrumCtx.fillStyle = "#3a7";
  for (let i = 0; i < freqData.length; i++) {
    const barHeight = (freqData[i] / 255) * spectrumCanvas.height;
    spectrumCtx.fillRect(
      i * barWidth,
      spectrumCanvas.height - barHeight,
      barWidth,
      barHeight
    );
  }

  requestAnimationFrame(drawLoop);
}

function currentGainLinear() {
  return Number(gainSlider.value) / 100;
}

toneBtn.addEventListener("click", () => {
  if (isToneActive()) {
    stopTone();
    toneBtn.textContent = "Play tone";
    toneBtn.classList.remove("active");
  } else {
    startTone(Number(freqSlider.value), currentGainLinear());
    toneBtn.textContent = "Stop tone";
    toneBtn.classList.add("active");
  }
});

freqSlider.addEventListener("input", () => {
  freqValue.textContent = freqSlider.value;
  setToneFrequency(Number(freqSlider.value));
});

gainSlider.addEventListener("input", () => {
  gainValue.textContent = gainSlider.value;
  setToneGain(currentGainLinear());
});

for (const btn of document.querySelectorAll("[data-nudge]")) {
  btn.addEventListener("click", () => {
    const delta = Number(btn.dataset.nudge);
    const min = Number(freqSlider.min);
    const max = Number(freqSlider.max);
    const next = Math.min(max, Math.max(min, Number(freqSlider.value) + delta));
    freqSlider.value = next;
    freqValue.textContent = next;
    if (isToneActive()) setToneFrequency(next);
  });
}

// Jump from a sweep candidate straight into the manual test tone, for
// by-ear verification (test-protocol.md "Manual Verification").
function listenToFrequency(freqHz) {
  const min = Number(freqSlider.min);
  const max = Number(freqSlider.max);
  const clamped = Math.min(max, Math.max(min, freqHz));
  freqSlider.value = clamped;
  freqValue.textContent = clamped;
  if (!isToneActive()) {
    startTone(clamped, currentGainLinear());
    toneBtn.textContent = "Stop tone";
    toneBtn.classList.add("active");
  } else {
    setToneFrequency(clamped);
  }
  document.getElementById("tone-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

sweepBtn.addEventListener("click", runSweepMeasurement);

async function runSweepMeasurement() {
  if (sweepRunning) return;
  sweepRunning = true;
  sweepBtn.disabled = true;
  micDisableBtn.disabled = true;
  sweepCandidatesListEl.innerHTML = "";
  sweepLegendEl.textContent = "";
  clearCanvas(sweepWaveformCanvas);
  clearCanvas(sweepIrCanvas);
  clearCanvas(sweepDecayCanvas);
  sweepStatusEl.textContent = "Generating sweep…";
  sweepStatusEl.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const ctx = getAudioContext();
    const sampleRate = ctx.sampleRate;
    const { sweep, inverseFilter } = generateSweepAndInverse(
      SWEEP_F1,
      SWEEP_F2,
      SWEEP_DURATION_SEC,
      sampleRate
    );

    await loadCaptureWorklet();
    sweepStatusEl.textContent = "Recording sweep + ring-down… keep the phone still.";
    startCapture();
    playBuffer(sweep, SWEEP_GAIN);
    await sleep((SWEEP_DURATION_SEC + SWEEP_TAIL_SEC) * 1000);
    const capture = stopCapture();
    stopBuffer();

    if (!capture || capture.samples.length === 0) {
      throw new Error("no audio captured");
    }
    renderWaveformCanvas(sweepWaveformCanvas, capture.samples);

    sweepStatusEl.textContent = "Deconvolving…";
    const recorded = Float64Array.from(capture.samples);
    const recoveredIR = deconvolve(recorded, inverseFilter);

    const theoreticalPeakIdx = sweep.length - 1;
    const searchStart = Math.max(0, theoreticalPeakIdx - Math.round(1.0 * sampleRate));
    const searchEnd = Math.min(recoveredIR.length, theoreticalPeakIdx + Math.round(1.0 * sampleRate));
    let peakIdx = searchStart;
    let peakVal = -Infinity;
    for (let i = searchStart; i < searchEnd; i++) {
      if (Math.abs(recoveredIR[i]) > peakVal) {
        peakVal = Math.abs(recoveredIR[i]);
        peakIdx = i;
      }
    }
    renderImpulseResponseCanvas(sweepIrCanvas, recoveredIR, peakIdx, sampleRate);

    const tailStart = peakIdx + Math.round(0.01 * sampleRate);
    const tailLength = Math.min(Math.round(1.2 * sampleRate), recoveredIR.length - tailStart);
    if (tailLength < Math.round(0.3 * sampleRate)) {
      throw new Error("not enough ring-down captured after the impulse peak");
    }
    const tail = recoveredIR.subarray(tailStart, tailStart + tailLength);

    sweepStatusEl.textContent = "Analyzing decay rates…";
    const decay = estimateDecayRates(tail, sampleRate, DECAY_CANDIDATE_FREQUENCIES_HZ);
    const maxInitialDb = Math.max(...decay.map((d) => d.initialLevelDb));
    const ranked = rankRingingCandidates(decay, {
      minInitialLevelDb: maxInitialDb - 40,
      maxCandidates: 3,
    });

    renderDecayCurves(decay, ranked);
    renderSweepCandidates(ranked);

    sweepStatusEl.textContent = `Sweep complete. Impulse peak at ${(peakIdx / sampleRate).toFixed(2)}s into the recording.`;
  } catch (err) {
    sweepStatusEl.textContent = `Sweep failed: ${err.message}`;
  } finally {
    sweepRunning = false;
    sweepBtn.disabled = false;
    micDisableBtn.disabled = false;
  }
}

function clearCanvas(canvas) {
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function renderWaveformCanvas(canvas, samples) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#3a7";
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0; x < width; x++) {
    const idx = x * step;
    const v = samples[idx] ?? 0;
    const y = height / 2 - v * (height / 2);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function renderImpulseResponseCanvas(canvas, ir, peakIdx, sampleRate) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const preSamples = Math.round(0.005 * sampleRate);
  const postSamples = Math.round(0.05 * sampleRate);
  const start = Math.max(0, peakIdx - preSamples);
  const end = Math.min(ir.length, peakIdx + postSamples);
  const segment = ir.subarray(start, end);

  let maxAbs = 1e-9;
  for (let i = 0; i < segment.length; i++) {
    const a = Math.abs(segment[i]);
    if (a > maxAbs) maxAbs = a;
  }

  ctx.strokeStyle = "#f93";
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const idx = Math.floor((x / width) * segment.length);
    const v = segment[idx] / maxAbs;
    const y = height / 2 - v * (height / 2 - 4);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function renderDecayCurves(decay, ranked) {
  const canvas = sweepDecayCanvas;
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  if (ranked.length === 0) return;

  let maxDb = -Infinity;
  let minDb = Infinity;
  for (const r of ranked) {
    for (const v of r.series.levelsDb) {
      if (v > maxDb) maxDb = v;
      if (v < minDb) minDb = v;
    }
  }
  const range = Math.max(1, maxDb - minDb);
  const maxTime = Math.max(...ranked.map((r) => r.series.times[r.series.times.length - 1] || 0));

  const legendParts = [];
  ranked.forEach((r, idx) => {
    const color = DECAY_CURVE_COLORS[idx % DECAY_CURVE_COLORS.length];
    legendParts.push(`<span style="color:${color}">■ ${r.frequencyHz} Hz</span>`);

    ctx.strokeStyle = color;
    ctx.beginPath();
    r.series.times.forEach((t, i) => {
      const x = maxTime > 0 ? (t / maxTime) * width : 0;
      const y = height - ((r.series.levelsDb[i] - minDb) / range) * (height - 10) - 5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  sweepLegendEl.innerHTML = legendParts.join(" ");
}

function renderSweepCandidates(ranked) {
  sweepCandidatesListEl.innerHTML = "";
  if (ranked.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No candidates above the signal-level floor.";
    sweepCandidatesListEl.appendChild(li);
    return;
  }
  for (const r of ranked) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${r.frequencyHz} Hz (${r.decayRateDbPerSec.toFixed(1)} dB/s)`;
    const listenBtn = document.createElement("button");
    listenBtn.textContent = "Listen";
    listenBtn.addEventListener("click", () => listenToFrequency(r.frequencyHz));
    li.append(label, listenBtn);
    sweepCandidatesListEl.appendChild(li);
  }
}

window.addEventListener("pagehide", () => {
  stopTone();
  stopBuffer();
});
