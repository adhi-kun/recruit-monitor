/* eslint-disable no-undef */
// AudioWorklet processor — runs in worklet global scope.
// Captures PCM Int16 mono at the AudioContext's sample rate (16kHz).
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const numChannels = input.length;
    const frameLength = input[0].length;

    // Explicit mono downmix — average all input channels
    // Fixes silent data loss when browser provides stereo mic input
    let mono;
    if (numChannels === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frameLength);
      for (let i = 0; i < frameLength; i++) {
        let sum = 0;
        for (let ch = 0; ch < numChannels; ch++) {
          sum += input[ch][i];
        }
        mono[i] = sum / numChannels;
      }
    }

    // Convert Float32 [-1,1] → Int16 [-32768,32767]
    const int16 = new Int16Array(frameLength);
    for (let i = 0; i < frameLength; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Transfer buffer (zero-copy via Transferable Objects)
    this.port.postMessage(int16.buffer, [int16.buffer]);
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
