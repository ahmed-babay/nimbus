import { transcribeLocally } from './local-stt'
import { targetLanguage } from './translate'
import config from '../../config.json'

/**
 * Listening for "hello Nimbus".
 *
 * **This is keyword spotting, not a trained wake-word model, and the
 * difference matters.** A model like openWakeWord answers exactly one question
 * — "was that the phrase?" — and never turns nearby speech into text. There is
 * no pretrained model for "Nimbus", and making one means generating synthetic
 * speech and training a classifier offline; that is a real pipeline, not
 * something to fake.
 *
 * So this transcribes short bursts of speech locally and looks for the name in
 * them. The privacy trade is deliberate and bounded:
 *
 *  - It is **off by default**, and the only thing that turns it on is the user.
 *  - Transcription is the on-device model. When the local weights are missing
 *    this stays off rather than quietly uploading a room's conversation to
 *    Groq — which is why `wakeWordAvailable` exists.
 *  - Nothing is stored. The text is matched, and the function returns a
 *    boolean; no transcript, recording or buffer outlives the call.
 *
 * That keeps it on the right side of the rule the rest of Nimbus follows —
 * ambient audio never leaves the machine and is never retained — while being
 * honest that a real wake-word model would not need to read the words at all.
 */

/** Longer than this is a conversation, not someone calling a name. */
const MAX_WAKE_MS = 2600

/** Cheap edit distance, capped: two candidate words are compared, not essays. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let edits = 0

  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    // Same length means a substitution; different means the longer string has
    // an extra character to skip past.
    if (shorter.length === longer.length) i++
    j++
  }

  return edits + (longer.length - j) + (shorter.length - i) <= 1
}

/**
 * Whether a heard word was probably the name.
 *
 * Whisper transcribes a proper noun inconsistently, so exact matching misses
 * too much: "nimbus" comes back as "nimbis" or "limbus". One edit covers those
 * while still rejecting "minibus" (distance 3), "number" (3) and "campus" (3).
 *
 * Two edits was tried and rejected. It would admit "nimble", an ordinary
 * English word, to catch "nimbo" — a mishearing that was hypothesised rather
 * than observed. The bias is deliberate: a false positive opens the overlay
 * and starts recording while the user is mid-conversation with someone else,
 * a false negative costs them saying the name twice.
 */
function soundsLikeName(word: string, name: string): boolean {
  return withinOneEdit(word, name)
}

/** The name being listened for, lowercased and without punctuation. */
export function wakeName(): string {
  const phrase = (config.wakeWord?.phrase ?? 'hello nimbus').toLowerCase()
  const words = phrase.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  // The last word is the name; the greeting in front of it varies far too much
  // ("hello", "hey", "hi", "ok") to be worth insisting on.
  return words[words.length - 1] ?? 'nimbus'
}

/**
 * Whether the heard text was someone calling Nimbus.
 *
 * Exported separately from the audio path so the rule can be tested against
 * strings directly, which is the only part of this worth arguing about.
 */
export function matchesWakeWord(heard: string): boolean {
  const name = wakeName()
  const words = heard
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  // A wake phrase is a few words. Requiring brevity is what stops the name
  // appearing mid-sentence ("the nimbus cloud layer") from opening the
  // overlay while someone is talking to a person.
  if (words.length === 0 || words.length > 4) return false

  return words.some((word) => soundsLikeName(word, name))
}

/** Turned on by the user, and only usable with the on-device recogniser. */
export function wakeWordEnabled(): boolean {
  return config.wakeWord?.enabled === true
}

/**
 * Decides whether a captured burst was the wake phrase.
 *
 * Deliberately returns a boolean and nothing else: the caller has no way to
 * learn what was said, so ambient speech cannot leak into a log, an IPC
 * message or the renderer even by accident.
 */
export async function heardWakeWord(pcm: Float32Array, sampleRate = 16000): Promise<boolean> {
  const durationMs = (pcm.length / sampleRate) * 1000
  // Skip long bursts before running the model at all — this is both the false
  // positive guard and the cheaper path.
  if (durationMs > MAX_WAKE_MS) return false

  const heard = await transcribeLocally(pcm, { language: targetLanguage() })
  return matchesWakeWord(heard)
}
