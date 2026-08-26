import {
  getAudioContext,
  enableMicrophone,
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

const micBtn = document.getElementById("mic-btn");
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

const spectrumCtx = spectrumCanvas.getContext("2d");
let analyser = null;

const MAX_CAPTURE_SECONDS = 8;
let captureStartTime = null;
let captureTimerId = null;
let autoStopTimeoutId = null;
let lastCapture = null;

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
  } catch (err) {
    micStatus.textContent = `Failed: ${err.message}`;
  } finally {
    micBtn.disabled = false;
  }
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
}

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
