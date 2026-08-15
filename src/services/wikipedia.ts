import type { EntityCardData } from '../shared/types'
import { fetchImageAsDataUri } from './images'

const SEARCH_URL = 'https://en.wikipedia.org/w/rest.php/v1/search/page'
const SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary'

const HEADERS = { 'User-Agent': 'NimbusAssistant/0.1 (personal desktop assistant)' }

interface WikiSearchResponse {
  pages?: Array<{ key?: string; title?: string }>
}

interface WikiSummaryResponse {
  type?: string
  title?: string
  description?: string
  extract?: string
  thumbnail?: { source?: string }
  content_urls?: { desktop?: { page?: string } }
}

/**
 * Wikipedia summary lookup — free, no key, no rate limit worth worrying about
 * at this volume. Used to answer "who/what is X" with a description and photo
 * rather than a wall of search-result links.
 *
 * Returns null when there's no confident match, so the caller can fall back
 * to a general web search.
 */
export async function lookupEntity(query: string): Promise<EntityCardData | null> {
  try {
    // Resolve the phrasing ("who is the nvidia ceo") to an actual page title.
    const searchRes = await fetch(
      `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=1`,
      { headers: HEADERS, signal: AbortSignal.timeout(5000) }
    )
    if (!searchRes.ok) return null

    const searchJson = (await searchRes.json()) as WikiSearchResponse
    const key = searchJson.pages?.[0]?.key
    if (!key) return null

    const summaryRes = await fetch(`${SUMMARY_URL}/${encodeURIComponent(key)}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5000)
    })
    if (!summaryRes.ok) return null

    const summary = (await summaryRes.json()) as WikiSummaryResponse

    // Disambiguation pages have no real content — treat as no match.
    if (summary.type === 'disambiguation' || !summary.extract) return null

    return {
      title: summary.title ?? key,
      description: summary.description ?? null,
      extract: summary.extract,
      image: await fetchImageAsDataUri(summary.thumbnail?.source),
      url: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${key}`
    }
  } catch {
    return null
  }
}
