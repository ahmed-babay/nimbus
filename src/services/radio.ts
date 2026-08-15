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
export async function findStation(query: string): Promise<RadioCardData> {
  const term = encodeURIComponent(query.trim())
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
