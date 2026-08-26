// AudioWorkletProcessor: forwards raw mic samples to the main thread while
// active. Output is left silent (all zeros) — this node exists only to be
// pulled by the audio graph, it must never carry signal to destination.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.port.onmessage = (event) => {
      if (event.data === "start") this.active = true;
      if (event.data === "stop") this.active = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.active && input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0].slice());
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
