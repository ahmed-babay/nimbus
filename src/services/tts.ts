import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import config from '../../config.json'
import { purgeLocalTts, localTtsInstalled, localTtsSupportsLanguage, localVoiceName } from './local-tts'
import { localVoiceAvailable, speakOutOfProcess } from '../main/speech-host'

/**
 * Male neural voice, configurable for another locale or speaking style.
 * Read lazily because the main process loads .env after static imports run.
 */
function voice(): string {
  return process.env.TTS_VOICE || 'en-US-BrianNeural'
}

export interface SynthesizedSpeech {
  audio: Buffer
  mimeType: string
}

/**
 * Turns an answer into audio, on-device when it can.
 *
 * There are three tiers, and each exists because the one below it can fail in
 * a way the user would notice:
 *
 *  1. Kokoro on this machine — no network, and a steady ~860ms.
 *  2. Microsoft Edge's free "Read Aloud" neural service — no signup or key,
 *     but a network call whose latency swings by a factor of eight.
 *  3. The renderer's own SpeechSynthesis, chosen by the caller when this
 *     throws. Robotic, but never silent.
 */
export async function synthesizeSpeech(text: string): Promise<SynthesizedSpeech> {
  // Only when the weights are already here: downloading 330MB mid-answer
  // would look like a hang, so installing is something settings does.
  if (localTtsSupportsLanguage() && localVoiceAvailable() && (await localTtsInstalled())) {
    try {
      // Out of process, deliberately. Kokoro on WebGPU takes the whole process
      // down when the GPU device is freed - not while speaking, but whenever
      // the collector gets round to it - so it lives somewhere its death only
      // costs one answer. See main/tts-host.ts.
      return { audio: await speakOutOfProcess(text, localVoiceName()), mimeType: 'audio/wav' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[tts] on-device voice failed, falling back to Edge: ${message}`)
      // Same as speech recognition: unparseable weights are a truncated
      // download, and a bad cache nobody clears never gets better.
      if (/protobuf|deserial|invalid|corrupt|failed to load model/i.test(message)) {
        await purgeLocalTts()
      }
    }
  }

  return synthesizeWithEdge(text)
}

/**
 * Edge's endpoint is unofficial (like Yahoo Finance), so if it ever breaks the
 * caller falls back to the renderer's built-in SpeechSynthesis rather than
 * staying silent.
 */
async function synthesizeWithEdge(text: string): Promise<SynthesizedSpeech> {
  // Edge's default pace is slower than reading speed, which makes answers feel
  // laggy next to text that has already finished streaming. Measured on a
  // typical reply: default 6.1s, +25% 4.9s.
  const rate = config.voice?.speechRate || '+10%'
  const tts = new MsEdgeTTS()
  // MP3 rather than Edge's webm/opus: Edge streams a fragmented webm with no
  // duration header, which some decoders reject. MP3 decodes everywhere.
  await tts.setMetadata(voice(), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  const { audioStream } = tts.toStream(text, { rate })

  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    audioStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    audioStream.on('close', () => resolve())
    audioStream.on('error', reject)
  })

  const audio = Buffer.concat(chunks)
  if (audio.length === 0) {
    throw new Error('Edge TTS returned no audio.')
  }
  return { audio, mimeType: 'audio/mpeg' }
}
