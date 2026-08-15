// Phrases that dismiss the overlay instead of being sent off as a question.
// Matched locally in the renderer so "stop" closes instantly — no Gemini
// round trip, no chance of it trying to *answer* the word "stop".

const STOP_PHRASES = new Set([
  'stop',
  'stop it',
  'stop please',
  'please stop',
  'cancel',
  'nevermind',
  'never mind',
  'forget it',
  'thats it',
  'thats it for today',
  'thats all',
  'thats all for now',
  'thats all for today',
  'that will be all',
  'thats enough',
  'im done',
  'were done',
  'we are done',
  'done for today',
  'no thanks',
  'no thank you',
  'nothing',
  'nothing else',
  'goodbye',
  'good bye',
  'bye',
  'bye bye',
  'bye nimbus',
  'goodbye nimbus',
  'see you',
  'see you later',
  'quit',
  'exit',
  'close',
  'dismiss',
  'go away',
  'shut up',
  'be quiet',
  'thank you thats all',
  'thanks thats all'
])

// Phrases that stop *playback* but keep Nimbus open and listening. Checked
// before the dismissal list, and only while something is playing — otherwise
// a bare "stop" during music would close the whole overlay when the user only
// meant "turn the music off".
const STOP_PLAYBACK_PHRASES = new Set([
  'stop',
  'stop it',
  'stop the music',
  'stop music',
  'stop playing',
  'stop the song',
  'stop the radio',
  'stop the video',
  'stop playback',
  'turn it off',
  'turn the music off',
  'turn off the music',
  'turn off',
  'pause',
  'pause it',
  'pause the music',
  'shut it off',
  'silence',
  'quiet',
  'be quiet',
  'mute',
  'enough music',
  'no more music'
])

/** Strip punctuation/filler so "That's it for today!" matches "thats it for today". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // drop apostrophes, periods, etc.
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True if the utterance is a dismissal. Deliberately exact-match on a known
 * list rather than substring matching — "stop" appearing inside a real
 * question ("what stops a heart attack") must not close the overlay.
 */
/** Allows a leading politeness/filler word: "ok stop", "alright thats all". */
function matches(phrases: Set<string>, transcript: string): boolean {
  const normalized = normalize(transcript)
  if (!normalized) return false
  if (phrases.has(normalized)) return true

  const withoutLead = normalized.replace(/^(ok|okay|alright|right|well|um|uh|hey|nimbus)\s+/, '')
  return withoutLead !== normalized && phrases.has(withoutLead)
}

export function isStopPhrase(transcript: string): boolean {
  return matches(STOP_PHRASES, transcript)
}

/** "stop the music", "pause", "turn it off" — stops playback, stays open. */
export function isStopPlaybackPhrase(transcript: string): boolean {
  return matches(STOP_PLAYBACK_PHRASES, transcript)
}
