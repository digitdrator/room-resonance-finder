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
