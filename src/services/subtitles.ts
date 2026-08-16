import { transcribeAudio } from './whisper'
import { translate } from './translate'
import type { Subtitle } from '../shared/types'

export type { Subtitle }

/**
 * Live subtitles for anything the computer is playing.
 *
 * For a film or a video with no subtitle track: hear it, transcribe it,
 * translate it, put it on screen. Nothing is spoken back and the microphone
 * is never opened — this mode only listens to the machine.
 *
 * On timing, honestly: this is delayed subtitling, not simultaneous
 * interpretation. A piece has to finish before it can be transcribed, so a
 * line appears roughly one pause-to-pause phrase behind the audio, plus about
 * half a second of processing. Measured end to end on German broadcast
 * speech, transcription ran 280-500ms and translation 180-900ms. Waiting for
 * the phrase to complete is what makes the translation a real sentence rather
 * than a fragment, so the delay buys the quality.
 *
 * Whisper is not asked to translate directly. Its translation endpoint
 * returned the source language unchanged on real German audio, and the turbo
 * model refuses that endpoint outright, so translation is a separate hop —
 * see `translate.ts`, which is also far faster and costs no model quota.
 */

/**
 * Whisper invents filler when handed near-silence — a stray "." or "Thank
 * you." over a quiet passage. Subtitles run continuously over music and room
 * tone, so this happens often enough to matter.
 */
const NOISE = /^[\s.,!?…-]*$/
const NOISE_PHRASES = new Set([
  'you',
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'subscribe',
  'bye',
  'okay',
  'so',
  'music',
  'applause'
])

function isNoise(text: string): boolean {
  const bare = text
    .toLowerCase()
    .replace(/[.,!?…\-[\]()*]/g, '')
    .trim()
  return NOISE.test(text) || NOISE_PHRASES.has(bare)
}

/** How much previous text to feed back as context. */
const CONTEXT_CHARS = 220

export interface SubtitleRequest {
  audio: Buffer
  mimeType: string
  offsetMs: number
  /** Tail of the previous line, for continuity across a forced cut. */
  previous?: string
  /** Language detected earlier in this session, for the fallback translator. */
  sourceHint?: string
}

/**
 * Returns null when the piece held nothing worth showing — silence, a stray
 * noise transcription, or audio already in the user's own language. Showing
 * someone their own language back as a "translation" is just clutter.
 */
export async function subtitleFor(request: SubtitleRequest): Promise<Subtitle | null> {
  const spoken = await transcribeAudio(request.audio, request.mimeType, {
    contextPrompt: request.previous?.slice(-CONTEXT_CHARS)
  })

  if (!spoken || isNoise(spoken)) return null

  const result = await translate(spoken, request.sourceHint)
  if (result.passthrough) return null

  return {
    original: spoken,
    translated: result.text,
    detected: result.detected,
    offsetMs: request.offsetMs
  }
}
