/**
 * Turns recorded audio into the raw samples a speech model wants.
 *
 * This lives in the renderer for one reason: Chromium can decode WebM/Opus and
 * Node cannot. Doing it here costs nothing — the codec is already in the
 * process — and saves bundling one into the main process purely to undo what
 * MediaRecorder just did.
 *
 * Whisper expects 16kHz mono. Asking the AudioContext for that sample rate
 * makes the browser resample during decode, which is both faster and better
 * than doing it by hand afterwards.
 */

/** What every speech model in Nimbus is trained on. */
export const SAMPLE_RATE = 16000

/**
 * Reused across pieces. Creating an AudioContext per subtitle chunk leaks
 * hardware contexts fast enough that Chromium eventually refuses to make more.
 */
let decoder: AudioContext | null = null

function context(): AudioContext {
  if (!decoder || decoder.state === 'closed') {
    decoder = new AudioContext({ sampleRate: SAMPLE_RATE })
  }
  return decoder
}

/**
 * Decodes a recorded blob to 16kHz mono float samples.
 *
 * Channels are averaged rather than dropped: a meeting recorded from system
 * audio can put one speaker mostly in the left channel, and taking channel 0
 * alone would make them quiet or lose them.
 */
export async function toPcm(blob: Blob): Promise<Float32Array> {
  const encoded = await blob.arrayBuffer()
  const audio = await context().decodeAudioData(encoded)

  if (audio.numberOfChannels === 1) return audio.getChannelData(0)

  const merged = new Float32Array(audio.length)
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel)
    for (let i = 0; i < samples.length; i++) merged[i] += samples[i]
  }
  for (let i = 0; i < merged.length; i++) merged[i] /= audio.numberOfChannels

  return merged
}

/**
 * Same, but from bytes already read off a blob.
 *
 * `decodeAudioData` detaches the buffer it is given, so this hands it a copy —
 * callers keep their own bytes usable afterwards.
 */
export async function bytesToPcm(bytes: ArrayBuffer): Promise<Float32Array> {
  const audio = await context().decodeAudioData(bytes.slice(0))

  if (audio.numberOfChannels === 1) return audio.getChannelData(0)

  const merged = new Float32Array(audio.length)
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel)
    for (let i = 0; i < samples.length; i++) merged[i] += samples[i]
  }
  for (let i = 0; i < merged.length; i++) merged[i] /= audio.numberOfChannels

  return merged
}
