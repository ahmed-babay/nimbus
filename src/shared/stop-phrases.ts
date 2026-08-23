// Phrases that dismiss the overlay instead of being sent off as a question.
// Matched locally so "stop" closes instantly — no model round trip, no chance
// of it trying to *answer* the word "stop".

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
  'no more music',
  'stop that song',
  'stop this song',
  'stop that',
  'kill the music'
])

/** Strip punctuation/filler so "That's it for today!" matches "thats it for today". */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tidy(transcript: string): string {
  return normalizeUtterance(transcript)
    .replace(/^(ok|okay|alright|right|well|um|uh|hey|nimbus|please)\s+/, '')
    .replace(/\s+(please|thanks|thank you)$/, '')
}

function matches(phrases: Set<string>, transcript: string): boolean {
  const normalized = normalizeUtterance(transcript)
  if (!normalized) return false
  if (phrases.has(normalized)) return true
  const stripped = tidy(transcript)
  return stripped !== normalized && phrases.has(stripped)
}

export function isStopPhrase(transcript: string): boolean {
  return matches(STOP_PHRASES, transcript)
}

const MEDIA_WORD = /\b(music|radio|song|songs|playback|station|track|video)\b/

function isPlayRequest(transcript: string): boolean {
  return /^(play|put on|listen to|queue|search for|find me|youtube)\b/.test(tidy(transcript))
}

function mediaStopBody(transcript: string): string {
  return tidy(transcript).replace(
    /^(can you|could you|would you|will you|i want you to|i need you to)\s+/,
    ''
  )
}

/**
 * "stop the music", "pause", "turn it off" — stops playback, stays open.
 *
 * Also matches the obvious phrasings that aren't on the exact list
 * ("please stop the music", "stop that song") so they never get sent to the
 * music search as a track title. That is how "Stop the Music" by a random
 * artist ends up playing when someone just wanted silence.
 *
 * "play stop the music" is still a song request — only silence-shaped
 * sentences count.
 */
export function isStopPlaybackPhrase(transcript: string): boolean {
  if (isPlayRequest(transcript)) return false
  if (matches(STOP_PLAYBACK_PHRASES, transcript)) return true
  const stripped = mediaStopBody(transcript)
  if (stripped !== tidy(transcript) && matches(STOP_PLAYBACK_PHRASES, stripped)) return true
  return (
    /^(stop|pause|end|cancel|kill)(\s+(the|this|that))?(\s+(music|radio|song|songs|playback|station|track|video))$/.test(
      stripped
    ) ||
    /^(stop|pause)\s+playing(\s+(the|this|that))?(\s+(music|radio|song))?$/.test(stripped) ||
    /^(turn|shut)(\s+(the|this|that))?(\s+(music|radio|song))\s+off$/.test(stripped) ||
    /^(turn|shut)\s+off(\s+(the|this|that))?(\s+(music|radio|song))$/.test(stripped)
  )
}

/**
 * A stop that named the player — "stop the music" — never a song title.
 * Bare "stop" is not this; that still dismisses the overlay when nothing is on.
 */
export function isMediaStopRequest(transcript: string): boolean {
  if (isPlayRequest(transcript)) return false
  const normalized = normalizeUtterance(transcript)
  if (!MEDIA_WORD.test(normalized)) return false
  return isStopPlaybackPhrase(transcript)
}
