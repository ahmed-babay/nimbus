import type { RadioCardData } from '../shared/types'

// Radio-Browser is a free, key-free community index of internet radio
// stations. Instances are mirrors of the same dataset; any one can be down.
const INSTANCES = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://fi1.api.radio-browser.info'
]

const HEADERS = { 'User-Agent': 'NimbusAssistant/0.1 (personal desktop assistant)' }
const REQUEST_TIMEOUT_MS = 7000

interface RadioStation {
  name?: string
  url_resolved?: string
  url?: string
  codec?: string
  bitrate?: number
  tags?: string
  country?: string
  favicon?: string
}

async function search(base: string, path: string): Promise<RadioStation[] | null> {
  try {
    const res = await fetch(`${base}${path}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const json = (await res.json()) as RadioStation[]
    return Array.isArray(json) && json.length > 0 ? json : null
  } catch {
    return null
  }
}

function pickStation(stations: RadioStation[]): RadioStation | null {
  const playable = stations.filter((s) => (s.url_resolved || s.url) && s.codec !== 'UNKNOWN')
  // Prefer https: the renderer plays these directly, and an http stream is a
  // mixed-content request from an https-ish context.
  const secure = playable.filter((s) => (s.url_resolved ?? s.url ?? '').startsWith('https://'))
  return secure[0] ?? playable[0] ?? null
}

/**
 * Finds an internet radio station to play *inside* Nimbus.
 *
 * This exists because YouTube audio can't legitimately be played in-app —
 * extracting its streams breaches YouTube's terms. Radio streams are public
 * broadcasts served as plain audio, so the overlay can play them directly
 * with an <audio> element and no browser hand-off.
 */
/**
 * What speech recognition makes of a genre name.
 *
 * "lofi" is the standing example: it comes back as "Luffy" because the One
 * Piece character is a far commoner string than the genre, and a tag search
 * for "luffy" finds nothing, so the request quietly fell through to a YouTube
 * video instead. Whisper is also given these words as a vocabulary hint (see
 * transcriptionHint) — this catches the times that isn't enough.
 *
 * Kept to whole words and to genres, so a real request for One Piece music by
 * name is unaffected: "play the One Piece opening" contains neither token.
 */
const MISHEARD_GENRES: Array<[RegExp, string]> = [
  // The separator is optional and may be a hyphen: "lo-fi" and "low fi" are
  // both how people write it and neither is the tag radio-browser indexes.
  [/\b(luffy|loofy|loafy|lo[-\s]?fi|low[-\s]?fi)\b/gi, 'lofi'],
  [/\bsynth[-\s]?wave\b/gi, 'synthwave'],
  [/\bdrum[-\s]?(and|n|&)[-\s]?bass\b/gi, 'drum and bass'],
  [/\bchill[-\s]?hop\b/gi, 'chillhop'],
  [/\bbossa[-\s]?nova\b/gi, 'bossa nova']
]

/** Where "Luffy" is the character and not a mangled genre. */
const REALLY_THE_CHARACTER = /\b(one piece|anime|manga|straw hat|monkey d)\b/i

export function normalizeGenre(query: string): string {
  return MISHEARD_GENRES.reduce((text, [pattern, correct]) => {
    if (correct === 'lofi' && REALLY_THE_CHARACTER.test(text)) return text
    return text.replace(pattern, correct)
  }, query)
}

export async function findStation(query: string): Promise<RadioCardData> {
  const term = encodeURIComponent(normalizeGenre(query).trim())
  // Tag search matches genres/moods ("jazz", "lofi"); name search catches
  // requests for a specific station.
  const paths = [
    `/json/stations/search?tag=${term}&limit=12&hidebroken=true&order=votes&reverse=true`,
    `/json/stations/search?name=${term}&limit=12&hidebroken=true&order=votes&reverse=true`,
    `/json/stations/search?tagList=${term}&limit=12&hidebroken=true&order=votes&reverse=true`
  ]

  for (const base of INSTANCES) {
    for (const path of paths) {
      const stations = await search(base, path)
      if (!stations) continue
      const station = pickStation(stations)
      if (!station) continue

      const streamUrl = station.url_resolved ?? station.url ?? ''
      if (!streamUrl) continue

      return {
        name: (station.name ?? 'Unknown station').trim(),
        streamUrl,
        codec: station.codec ?? '',
        bitrate: station.bitrate ?? 0,
        tags: (station.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 3),
        country: station.country ?? '',
        query
      }
    }
  }

  throw new Error(`I couldn't find a station playing "${query}".`)
}
