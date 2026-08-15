// Whisper does not return an empty string for silence — it invents something.
// The same handful of phrases come back over and over, because they're what
// the training data contains at the quiet start/end of clips. Treating these
// as real questions is what put Nimbus into an answer-listen-answer loop
// without the user ever speaking.

const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks',
  'thank you very much',
  'thank you for watching',
  'thanks for watching',
  'thank you for watching this video',
  'please subscribe',
  'subscribe',
  'bye',
  'bye bye',
  'okay',
  'ok',
  'so',
  'yeah',
  'yes',
  'hmm',
  'mm',
  'mhm',
  'mm hmm',
  'mmhmm',
  'uh huh',
  'uh huh',
  'hm',
  'uh',
  'um',
  'ah',
  'oh',
  'the',
  'a',
  'i',
  'silence',
  'music',
  'applause',
  'beep',
  'blank audio',
  'inaudible',
  'no speech',
  'background noise'
])

/** Strips punctuation and bracketed annotations like "[MUSIC]" or "(silence)". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[[(][^\])]*[\])]/g, ' ') // [MUSIC], (silence)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation, incl. a bare "."
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True when a transcript is almost certainly noise rather than something the
 * user said. Conservative on purpose: only single stock phrases and content
 * that reduces to nothing are rejected, so a genuine short command like
 * "stop" or "louder" still gets through.
 */
export function isLikelyNoise(transcript: string): boolean {
  const normalized = normalize(transcript)

  // Punctuation only ("." or "..."), or nothing left at all.
  if (!normalized) return true

  // A single character that isn't a real one-word command.
  if (normalized.length < 2) return true

  if (HALLUCINATIONS.has(normalized)) return true

  // Whisper often stutters a stock phrase — "Thank you. Thank you." — which
  // isn't caught by an exact match, so check for one repeated outright.
  if (normalized.split(' ').length <= 8) {
    for (const phrase of HALLUCINATIONS) {
      for (let repeats = 2; repeats <= 4; repeats++) {
        if (normalized === Array(repeats).fill(phrase).join(' ')) return true
      }
    }
  }

  return false
}
