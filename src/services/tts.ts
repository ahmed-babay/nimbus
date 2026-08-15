import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import config from '../../config.json'

const VOICE = process.env.TTS_VOICE || 'en-GB-SoniaNeural'

export interface SynthesizedSpeech {
  audio: Buffer
  mimeType: string
}

/**
 * Microsoft Edge's free "Read Aloud" neural TTS service — no signup or API
 * key, and dramatically more natural than the local Windows SAPI voice that
 * SpeechSynthesis falls back to in Electron. It's an unofficial endpoint
 * (like Yahoo Finance), so if it ever breaks, the caller falls back to the
 * renderer's built-in SpeechSynthesis rather than staying silent.
 */
export async function synthesizeSpeech(text: string): Promise<SynthesizedSpeech> {
  // Edge's default pace is slower than reading speed, which makes answers feel
  // laggy next to text that has already finished streaming. Measured on a
  // typical reply: default 6.1s, +25% 4.9s.
  const rate = config.voice?.speechRate || '+20%'
  const tts = new MsEdgeTTS()
  // MP3 rather than Edge's webm/opus: Edge streams a fragmented webm with no
  // duration header, which some decoders reject. MP3 decodes everywhere.
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
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
