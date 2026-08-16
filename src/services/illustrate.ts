import { httpFetch } from './http'
import { fetchImagesAsDataUris } from './images'
import type { Illustration } from '../shared/types'

/**
 * Pictures to go with an explanation, from Wikipedia's search index.
 *
 * Wikipedia rather than an image search because the useful picture for "how
 * does a jet engine work" is a labelled cutaway diagram, not a stock photo of
 * a plane — and Wikipedia's lead images are exactly that: the citric acid
 * cycle returns the cycle diagram, Rayleigh scattering returns the scattering
 * diagram. It also needs no key and no account.
 *
 * The search is only as good as what it's given: querying the raw utterance
 * ("tell me about the Roman aqueducts") matched *Chinatown (1974 film)*,
 * while the bare topic ("Roman aqueduct") matches the article, then Pont du
 * Gard and the Aqueduct of Segovia. So this takes a topic, and the intent
 * classifier is what extracts it.
 */

const API = 'https://en.wikipedia.org/w/api.php'
const HEADERS = { 'User-Agent': 'NimbusAssistant/0.1 (personal desktop assistant)' }

interface WikiPage {
  title?: string
  index?: number
  thumbnail?: { source?: string }
}

/** Thumbnail width requested from Wikipedia — 2x the strip it's shown in. */
const THUMB_WIDTH = 640

export async function findIllustrations(topic: string, limit = 3): Promise<Illustration[]> {
  const trimmed = topic.trim()
  if (!trimmed) return []

  const url =
    `${API}?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${encodeURIComponent(trimmed)}&gsrlimit=${limit + 2}` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=${THUMB_WIDTH}&pilimit=${limit + 2}`

  const res = await httpFetch(url, { headers: HEADERS, label: 'Wikipedia', timeoutMs: 6000 })
  if (!res.ok) return []

  const json = (await res.json()) as { query?: { pages?: Record<string, WikiPage> } }
  const pages = Object.values(json.query?.pages ?? {})
    // The API returns pages keyed by id in arbitrary order; `index` is the
    // search ranking, and the first hit is overwhelmingly the right one.
    .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
    .filter((page) => page.thumbnail?.source && page.title)
    .slice(0, limit)

  if (pages.length === 0) return []

  const images = await fetchImagesAsDataUris(
    pages.map((page) => page.thumbnail?.source),
    { keepTransparency: true }
  )

  return pages
    .map((page, index) => ({
      image: images[index],
      caption: page.title as string,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((page.title as string).replace(/ /g, '_'))}`,
      // Only the alpha-carrying PNGs survive as PNG through the image
      // pipeline, and on Wikipedia those are the rendered SVG diagrams.
      diagram: (images[index] ?? '').startsWith('data:image/png')
    }))
    .filter((item): item is Illustration => typeof item.image === 'string')
}

/**
 * Never throws and never blocks the answer: illustrations are decoration, and
 * a slow or missing picture must not cost the user their reply.
 */
export async function tryIllustrate(
  topic: string | undefined,
  limit = 3
): Promise<Illustration[]> {
  if (!topic) return []
  try {
    return await findIllustrations(topic, limit)
  } catch {
    return []
  }
}
