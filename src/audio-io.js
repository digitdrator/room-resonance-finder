// Audio input/output graph. No UI, no analysis — reusable across phases.
//
// Graph:
//   mic -> getUserMedia -> MediaStreamAudioSourceNode -> AnalyserNode   (never -> destination)
//   OscillatorNode -> GainNode -> AudioContext.destination

let audioContext = null;
let micStream = null;
let micSourceNode = null;
let analyserNode = null;
let oscillatorNode = null;
let toneGainNode = null;

let captureWorkletLoaded = false;
let captureNode = null;
let captureChunks = [];
let capturing = false;

export function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

export async function enableMicrophone() {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  micSourceNode = ctx.createMediaStreamSource(micStream);
  analyserNode = ctx.createAnalyser();
  analyserNode.fftSize = 2048;
  micSourceNode.connect(analyserNode);

  const [track] = micStream.getAudioTracks();
  return { analyserNode, trackSettings: track.getSettings() };
}

export function startTone(frequencyHz, gainLinear) {
  const ctx = getAudioContext();
  stopTone();

  oscillatorNode = ctx.createOscillator();
  oscillatorNode.type = "sine";
  oscillatorNode.frequency.value = frequencyHz;

  toneGainNode = ctx.createGain();
  toneGainNode.gain.value = gainLinear;

  oscillatorNode.connect(toneGainNode).connect(ctx.destination);
  oscillatorNode.start();
}

export function setToneFrequency(frequencyHz) {
  if (oscillatorNode) {
    oscillatorNode.frequency.value = frequencyHz;
  }
}

export function setToneGain(gainLinear) {
  if (toneGainNode) {
    toneGainNode.gain.value = gainLinear;
  }
}

export function stopTone() {
  if (oscillatorNode) {
    oscillatorNode.stop();
    oscillatorNode.disconnect();
    oscillatorNode = null;
  }
  if (toneGainNode) {
    toneGainNode.disconnect();
    toneGainNode = null;
  }
}

export function isToneActive() {
  return oscillatorNode !== null;
}

export async function loadCaptureWorklet() {
  if (captureWorkletLoaded) return;
  const ctx = getAudioContext();
  await ctx.audioWorklet.addModule("src/capture-processor.js");
  captureWorkletLoaded = true;
}

export function startCapture() {
  if (!micSourceNode) {
    throw new Error("Microphone is not enabled yet.");
  }
  const ctx = getAudioContext();
  captureChunks = [];
  capturing = true;

  captureNode = new AudioWorkletNode(ctx, "capture-processor");
  captureNode.port.onmessage = (event) => {
    if (capturing) captureChunks.push(event.data);
  };
  micSourceNode.connect(captureNode);
  captureNode.connect(ctx.destination); // silent output, keeps node pulled
  captureNode.port.postMessage("start");
}

export function stopCapture() {
  if (!captureNode) return null;

  capturing = false;
  captureNode.port.postMessage("stop");
  micSourceNode.disconnect(captureNode);
  captureNode.disconnect();
  captureNode = null;

  const totalLength = captureChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of captureChunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  captureChunks = [];

  let peakAbs = 0;
  let sumSquares = 0;
  let clippedCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peakAbs) peakAbs = abs;
    if (abs >= 0.99) clippedCount++;
    sumSquares += samples[i] * samples[i];
  }
  const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;

  const ctx = getAudioContext();
  return {
    samples,
    sampleRate: ctx.sampleRate,
    durationSeconds: samples.length / ctx.sampleRate,
    peakAbs,
    rms,
    clippedCount,
    clippedRatio: samples.length > 0 ? clippedCount / samples.length : 0,
  };
}

export function isCapturing() {
  return capturing;
}
