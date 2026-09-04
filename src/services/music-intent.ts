import type { IntentClassification } from '../shared/types'

/** Only explicit media commands bypass the model; questions still use context. */
export function directMusicIntent(utterance: string): IntentClassification | null {
  const text = utterance.trim().replace(/[.!?]+$/, '')
  const command = text.match(/^(?:(?:hey\s+)?nimbus[, ]+)?(?:(?:please|can you|could you|would you)\s+)?(?:play|put on|start playing)\s+(.+?)(?:\s+please)?$/i)
  if (!command) return null
  const query = command[1].trim()
  // Preserve named tracks, artists, videos and ambiguous requests for the model.
  if (/\b(by|song|track|video|album|youtube)\b/i.test(query)) return null
  const genre = query.match(/^(?:some\s+)?(lo[- ]?fi|low fi|luffy|jazz|smooth jazz|classical|ambient|chill|chillout|chillhop|rock|pop|hip hop|hip-hop|techno|house|synthwave|reggae|blues|metal|relaxing|upbeat|focus|study|sleep)(?:\s+(?:music|radio|station|beats))?(?:\s+(?:in|on)\s+nimbus)?$/i)
  if (genre) return { intent: 'music', params: { query: genre[1], playback: 'station' } }
  if (/^(?:some\s+)?(?:music|radio|something)(?:\s+(?:in|on)\s+nimbus)?$/i.test(query)) {
    return { intent: 'music', params: { query: 'chillout', playback: 'station' } }
  }
  return null
}

export function wantsBrowserPlayback(utterance: string): boolean {
  if (/\b(?:not|never|avoid|without|don['’]t|do not)\b.{0,24}\b(?:youtube|browser)\b/i.test(utterance)) return false
  return /\b(?:on|in|via|open|öffne|auf)\s+(?:youtube|yt|the browser|browser)\b|\byoutube\s+(?:video|link)\b|\bopen the video\b/i.test(utterance)
}
