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
  isCapturing,
} from "./audio-io.js";
import { magnitudeSpectrum, findPeaks } from "./analysis.js";
import { runSteppedScan, measureNoiseFloor } from "./scan.js";

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

const captureBtn = document.getElementById("capture-btn");
const captureElapsedEl = document.getElementById("capture-elapsed");
const waveformCanvas = document.getElementById("waveform");
const waveformCtx = waveformCanvas.getContext("2d");
const captureStatsEl = document.getElementById("capture-stats");
const downloadBtn = document.getElementById("download-btn");
const peaksListEl = document.getElementById("peaks-list");

const scanBtn = document.getElementById("scan-btn");
const scanBtnBottom = document.getElementById("scan-btn-bottom");
const scanStatusEl = document.getElementById("scan-status");
const scanResultsListEl = document.getElementById("scan-results-list");
const saveBaselineBtn = document.getElementById("save-baseline-btn");
const clearBaselineBtn = document.getElementById("clear-baseline-btn");
const baselineStatusEl = document.getElementById("baseline-status");

const candidatesBlockEl = document.getElementById("candidates-block");
const candidatesListEl = document.getElementById("candidates-list");
const zoomBlockEl = document.getElementById("zoom-block");
const zoomTitleEl = document.getElementById("zoom-title");
const zoomStatusEl = document.getElementById("zoom-status");
const zoomResultsListEl = document.getElementById("zoom-results-list");
const zoomListenBtn = document.getElementById("zoom-listen-btn");

const spectrumCtx = spectrumCanvas.getContext("2d");
let analyser = null;

const MAX_CAPTURE_SECONDS = 8;
const ANALYSIS_WINDOW_SIZE = 8192; // must match the window size validated in tests/analysis.test.js
const BASELINE_STORAGE_KEY = "room-resonance-baseline-v3";
const SNR_CONFIDENCE_THRESHOLD_DB = 10;
let captureStartTime = null;
let captureTimerId = null;
let autoStopTimeoutId = null;
let lastCapture = null;
let lastPeaks = [];
let lastScanResults = [];
let lastNoiseFloorDb = null;
let scanRunning = false;

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
    captureBtn.disabled = false;
    scanBtn.disabled = false;
    scanBtnBottom.disabled = false;
    micBtn.hidden = true;
    micDisableBtn.hidden = false;
  } catch (err) {
    micStatus.textContent = `Failed: ${err.message}`;
  } finally {
    micBtn.disabled = false;
  }
});

micDisableBtn.addEventListener("click", () => {
  if (isCapturing()) finishCapture();
  disableMicrophone();
  analyser = null;
  micStatus.textContent = "Microphone disabled.";
  levelBar.style.width = "0%";
  spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  captureBtn.disabled = true;
  scanBtn.disabled = true;
  scanBtnBottom.disabled = true;
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

// Jump from a candidate/zoom-scan result straight into the manual test
// tone, for by-ear verification (test-protocol.md "Manual Verification").
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

captureBtn.addEventListener("click", async () => {
  if (isCapturing()) {
    finishCapture();
    return;
  }
  captureBtn.disabled = true;
  try {
    await loadCaptureWorklet();
    startCapture();
  } catch (err) {
    captureStatsEl.textContent = `Capture failed: ${err.message}`;
    captureBtn.disabled = false;
    return;
  }
  captureBtn.disabled = false;
  captureBtn.textContent = "Stop capture";
  captureBtn.classList.add("active");
  downloadBtn.hidden = true;

  captureStartTime = performance.now();
  captureTimerId = setInterval(() => {
    const elapsed = (performance.now() - captureStartTime) / 1000;
    captureElapsedEl.textContent = elapsed.toFixed(1);
  }, 100);
  autoStopTimeoutId = setTimeout(finishCapture, MAX_CAPTURE_SECONDS * 1000);
});

function finishCapture() {
  clearInterval(captureTimerId);
  clearTimeout(autoStopTimeoutId);
  captureBtn.textContent = "Start capture";
  captureBtn.classList.remove("active");

  const result = stopCapture();
  if (!result) return;
  lastCapture = result;
  renderWaveform(result.samples);

  const peakDb = 20 * Math.log10(Math.max(result.peakAbs, 1e-6));
  const rmsDb = 20 * Math.log10(Math.max(result.rms, 1e-6));
  const lines = [
    `duration: ${result.durationSeconds.toFixed(2)} s`,
    `sampleRate: ${result.sampleRate} Hz`,
    `samples: ${result.samples.length}`,
    `peak: ${peakDb.toFixed(1)} dBFS`,
    `rms: ${rmsDb.toFixed(1)} dBFS`,
    `clipped samples: ${result.clippedCount} (${(result.clippedRatio * 100).toFixed(3)}%)`,
  ];
  if (result.clippedRatio > 0) {
    lines.push("", "WARNING: clipping detected.");
  }
  captureStatsEl.textContent = lines.join("\n");
  downloadBtn.hidden = false;

  lastPeaks = analyzeCapture(result.samples, result.sampleRate);
  renderPeaks(lastPeaks);
}

function analyzeCapture(samples, sampleRate) {
  const window = extractAnalysisWindow(samples, ANALYSIS_WINDOW_SIZE);
  const { frequencies, magnitudes } = magnitudeSpectrum(window, sampleRate);
  return findPeaks(frequencies, magnitudes, { maxPeaks: 5, minProminenceDb: 6 });
}

function extractAnalysisWindow(samples, windowSize) {
  if (samples.length <= windowSize) {
    const padded = new Float32Array(windowSize);
    padded.set(samples);
    return padded;
  }
  const start = Math.floor((samples.length - windowSize) / 2);
  return samples.subarray(start, start + windowSize);
}

function renderPeaks(peaks) {
  peaksListEl.innerHTML = "";
  if (peaks.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No peaks above the prominence threshold.";
    peaksListEl.appendChild(li);
    return;
  }
  for (const peak of peaks) {
    const li = document.createElement("li");
    const freq = document.createElement("span");
    freq.textContent = `${peak.frequencyHz.toFixed(1)} Hz`;
    const prom = document.createElement("span");
    prom.textContent = `+${peak.prominenceDb.toFixed(1)} dB`;
    li.append(freq, prom);
    peaksListEl.appendChild(li);
  }
}

async function runScan() {
  if (scanRunning) return;
  scanRunning = true;
  scanBtn.disabled = true;
  scanBtnBottom.disabled = true;
  micDisableBtn.disabled = true;
  saveBaselineBtn.hidden = true;
  candidatesBlockEl.hidden = true;
  zoomBlockEl.hidden = true;
  scanResultsListEl.innerHTML = "";
  scanResultsListEl.scrollIntoView({ behavior: "smooth", block: "start" });
  const baselineForThisRun = loadBaseline();

  try {
    await loadCaptureWorklet();
    scanStatusEl.textContent = "Measuring ambient noise floor (stay quiet)…";
    const noiseFloorDb = await measureNoiseFloor({ startCapture, stopCapture, durationMs: 500 });
    lastNoiseFloorDb = noiseFloorDb;

    const rawResults = await runSteppedScan({
      playTone: startTone,
      stopTone,
      startCapture,
      stopCapture,
      onStep: (step, index, total) => {
        const snrDb = step.levelDb - noiseFloorDb;
        scanStatusEl.textContent = `Step ${index}/${total}: ${step.frequencyHz} Hz -> ${step.levelDb.toFixed(1)} dBFS (SNR ${snrDb.toFixed(1)} dB)`;
        appendScanResultRow({ ...step, snrDb }, baselineForThisRun);
      },
    });
    const results = rawResults.map((step) => ({ ...step, snrDb: step.levelDb - noiseFloorDb }));
    lastScanResults = results;
    scanStatusEl.textContent = baselineForThisRun
      ? `Scan complete: ${results.length} frequencies, compared against baseline above.`
      : `Scan complete: ${results.length} frequencies. Save this as baseline, then scan again in the room to compare.`;
    saveBaselineBtn.hidden = false;
    if (baselineForThisRun) {
      renderCandidates(results, baselineForThisRun);
    }
  } catch (err) {
    scanStatusEl.textContent = `Scan failed: ${err.message}`;
  } finally {
    scanRunning = false;
    scanBtn.disabled = false;
    scanBtnBottom.disabled = false;
    micDisableBtn.disabled = false;
  }
}

scanBtn.addEventListener("click", runScan);
scanBtnBottom.addEventListener("click", runScan);

function appendScanResultRow(step, baseline) {
  const li = document.createElement("li");
  const freq = document.createElement("span");
  freq.textContent = `${step.frequencyHz} Hz`;
  const level = document.createElement("span");

  const lowConfidence = typeof step.snrDb === "number" && step.snrDb < SNR_CONFIDENCE_THRESHOLD_DB;
  const suffix = lowConfidence ? " ⚠ near noise floor, speaker may not reach here" : "";

  const baselineStep = baseline?.results.find((b) => b.frequencyHz === step.frequencyHz);
  if (baselineStep) {
    const deltaDb = step.levelDb - baselineStep.levelDb;
    level.textContent = `${step.levelDb.toFixed(1)} dBFS (${deltaDb >= 0 ? "+" : ""}${deltaDb.toFixed(1)} dB vs baseline)${suffix}`;
  } else if (baseline) {
    level.textContent = `${step.levelDb.toFixed(1)} dBFS (no baseline data at this frequency)${suffix}`;
  } else {
    level.textContent = `${step.levelDb.toFixed(1)} dBFS${suffix}`;
  }
  if (lowConfidence) li.classList.add("low-confidence");

  li.append(freq, level);
  scanResultsListEl.appendChild(li);
}

function renderCandidates(results, baseline) {
  const allDeltas = results
    .map((step) => {
      const baselineStep = baseline.results.find((b) => b.frequencyHz === step.frequencyHz);
      if (!baselineStep) return null;
      const roomSnrOk = typeof step.snrDb !== "number" || step.snrDb >= SNR_CONFIDENCE_THRESHOLD_DB;
      const baselineSnrOk =
        typeof baselineStep.snrDb !== "number" || baselineStep.snrDb >= SNR_CONFIDENCE_THRESHOLD_DB;
      return {
        frequencyHz: step.frequencyHz,
        deltaDb: step.levelDb - baselineStep.levelDb,
        confident: roomSnrOk && baselineSnrOk,
      };
    })
    .filter((x) => x && x.deltaDb > 0);

  const withDelta = allDeltas
    .filter((x) => x.confident)
    .sort((a, b) => b.deltaDb - a.deltaDb)
    .slice(0, 3);
  const excludedCount = allDeltas.length - withDelta.length;

  candidatesListEl.innerHTML = "";
  if (excludedCount > 0) {
    const note = document.createElement("li");
    note.className = "empty";
    note.textContent = `${excludedCount} positive-delta frequenc${excludedCount === 1 ? "y" : "ies"} excluded: signal too close to the noise floor (SNR < ${SNR_CONFIDENCE_THRESHOLD_DB} dB), likely a speaker/mic limitation rather than a real difference.`;
    candidatesListEl.appendChild(note);
  }
  if (withDelta.length === 0) {
    if (excludedCount === 0) candidatesBlockEl.hidden = true;
    else candidatesBlockEl.hidden = false;
    return;
  }
  candidatesBlockEl.hidden = false;
  for (const candidate of withDelta) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${candidate.frequencyHz} Hz (+${candidate.deltaDb.toFixed(1)} dB)`;
    const listenBtn = document.createElement("button");
    listenBtn.textContent = "Listen";
    listenBtn.addEventListener("click", () => listenToFrequency(candidate.frequencyHz));
    const zoomBtn = document.createElement("button");
    zoomBtn.textContent = "Zoom in";
    zoomBtn.addEventListener("click", () => runZoomScan(candidate.frequencyHz));
    li.append(label, listenBtn, zoomBtn);
    candidatesListEl.appendChild(li);
  }
}

function buildFineFrequencyList(centerHz, steps = 10, spanRatio = 0.3) {
  const lo = centerHz * (1 - spanRatio / 2);
  const hi = centerHz * (1 + spanRatio / 2);
  const list = [];
  for (let i = 0; i < steps; i++) {
    list.push(Math.round(lo + ((hi - lo) * i) / (steps - 1)));
  }
  return list;
}

async function runZoomScan(centerHz) {
  if (scanRunning) return;
  scanRunning = true;
  scanBtn.disabled = true;
  scanBtnBottom.disabled = true;
  micDisableBtn.disabled = true;
  zoomBlockEl.hidden = false;
  zoomResultsListEl.innerHTML = "";
  zoomListenBtn.hidden = true;
  zoomTitleEl.textContent = `Zoom-in scan around ${centerHz} Hz`;
  zoomStatusEl.textContent = "Running…";
  zoomBlockEl.scrollIntoView({ behavior: "smooth", block: "start" });

  const frequencies = buildFineFrequencyList(centerHz);
  try {
    const results = await runSteppedScan({
      frequencies,
      toneDurationMs: 400,
      settleMs: 100,
      playTone: startTone,
      stopTone,
      startCapture,
      stopCapture,
      onStep: (step, index, total) => {
        zoomStatusEl.textContent = `Step ${index}/${total}: ${step.frequencyHz} Hz`;
        const li = document.createElement("li");
        const freq = document.createElement("span");
        freq.textContent = `${step.frequencyHz} Hz`;
        const level = document.createElement("span");
        level.textContent = `${step.levelDb.toFixed(1)} dBFS`;
        li.append(freq, level);
        zoomResultsListEl.appendChild(li);
      },
    });
    const peak = results.reduce((a, b) => (b.levelDb > a.levelDb ? b : a));
    zoomStatusEl.textContent = `Sharpest response in this range: ${peak.frequencyHz} Hz (${peak.levelDb.toFixed(1)} dBFS). This narrows down where the peak sits, it does not by itself confirm the room caused it.`;
    zoomListenBtn.hidden = false;
    zoomListenBtn.onclick = () => listenToFrequency(peak.frequencyHz);
  } catch (err) {
    zoomStatusEl.textContent = `Zoom scan failed: ${err.message}`;
  } finally {
    scanRunning = false;
    scanBtn.disabled = false;
    scanBtnBottom.disabled = false;
    micDisableBtn.disabled = false;
  }
}

function loadBaseline() {
  try {
    const raw = localStorage.getItem(BASELINE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function renderBaselineStatus() {
  const baseline = loadBaseline();
  if (!baseline) {
    baselineStatusEl.textContent = "No baseline saved yet.";
    clearBaselineBtn.hidden = true;
    scanBtnBottom.hidden = true;
    return;
  }
  baselineStatusEl.textContent = `Baseline saved ${new Date(baseline.savedAt).toLocaleString()} — ${baseline.results.length} frequencies scanned. Now go to the room and tap "Run scan again" below to compare.`;
  clearBaselineBtn.hidden = false;
  scanBtnBottom.hidden = false;
  scanBtnBottom.disabled = scanBtn.disabled;
}

saveBaselineBtn.addEventListener("click", () => {
  if (lastScanResults.length === 0) return;
  const payload = {
    savedAt: new Date().toISOString(),
    noiseFloorDb: lastNoiseFloorDb,
    results: lastScanResults,
  };
  localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(payload));
  saveBaselineBtn.textContent = "Saved ✓";
  setTimeout(() => {
    saveBaselineBtn.textContent = "Save this scan as baseline";
  }, 2000);
  renderBaselineStatus();
  baselineStatusEl.scrollIntoView({ behavior: "smooth", block: "center" });
});

clearBaselineBtn.addEventListener("click", () => {
  localStorage.removeItem(BASELINE_STORAGE_KEY);
  renderBaselineStatus();
  candidatesBlockEl.hidden = true;
  zoomBlockEl.hidden = true;
});

renderBaselineStatus();

function renderWaveform(samples) {
  const { width, height } = waveformCanvas;
  waveformCtx.clearRect(0, 0, width, height);
  waveformCtx.strokeStyle = "#3a7";
  waveformCtx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0; x < width; x++) {
    const idx = x * step;
    const v = samples[idx] ?? 0;
    const y = height / 2 - v * (height / 2);
    if (x === 0) waveformCtx.moveTo(x, y);
    else waveformCtx.lineTo(x, y);
  }
  waveformCtx.stroke();
}

downloadBtn.addEventListener("click", () => {
  if (!lastCapture) return;
  const payload = {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    sampleRate: lastCapture.sampleRate,
    durationSeconds: lastCapture.durationSeconds,
    peakAbs: lastCapture.peakAbs,
    rms: lastCapture.rms,
    clippedRatio: lastCapture.clippedRatio,
    samples: Array.from(lastCapture.samples),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `room-resonance-capture-${Date.now()}.json`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

window.addEventListener("pagehide", stopTone);
