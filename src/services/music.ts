import type { MusicCardData } from '../shared/types'
import { fetchImageAsDataUri } from './images'

// Piped is an open-source YouTube frontend with a public, key-free API.
// Instances go down or rate-limit individually, so several are tried in turn.
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space'
]

const REQUEST_TIMEOUT_MS = 7000

interface PipedItem {
  url?: string
  type?: string
  title?: string
  thumbnail?: string
  uploaderName?: string
  duration?: number
  isShort?: boolean
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  return hrs > 0
    ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${mins}:${String(secs).padStart(2, '0')}`
}

async function searchInstance(base: string, query: string): Promise<PipedItem[] | null> {
  try {
    const res = await fetch(
      `${base}/search?q=${encodeURIComponent(query)}&filter=videos`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    )
    if (!res.ok) return null
    const json = (await res.json()) as { items?: PipedItem[] }
    const items = json.items ?? []
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}

/**
 * Finds something to play on YouTube.
 *
 * Playback deliberately happens by opening the video in the user's browser,
 * using YouTube's own player — the app never extracts or re-streams audio,
 * which would breach YouTube's terms (and break the moment they change a
 * response format). The browser also inherits the user's own YouTube session.
 */
export async function findMusic(query: string): Promise<MusicCardData> {
  let items: PipedItem[] | null = null

  for (const base of PIPED_INSTANCES) {
    items = await searchInstance(base, query)
    if (items) break
  }

  if (!items) {
    throw new Error("I couldn't reach YouTube search just now. Try again in a moment.")
  }

  // Skip Shorts — someone asking to play music wants the real track.
  const video =
    items.find((item) => item.type === 'stream' && !item.isShort && item.url) ??
    items.find((item) => item.url)

  if (!video?.url || !video.title) {
    throw new Error(`I couldn't find anything to play for "${query}".`)
  }

  const videoId = new URLSearchParams(video.url.split('?')[1] ?? '').get('v')
  if (!videoId) {
    throw new Error(`I couldn't find anything to play for "${query}".`)
  }

  return {
    title: video.title,
    channel: video.uploaderName ?? 'Unknown channel',
    duration: formatDuration(video.duration ?? 0),
    thumbnail: await fetchImageAsDataUri(video.thumbnail),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    query
  }
}
