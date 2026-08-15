import type { NewsArticle, NewsCardData } from '../shared/types'
import { fetchImagesAsDataUris } from './images'

const GNEWS_SEARCH_URL = 'https://gnews.io/api/v4/search'
const GNEWS_TOP_URL = 'https://gnews.io/api/v4/top-headlines'
const TAVILY_URL = 'https://api.tavily.com/search'

const MAX_ARTICLES = 4

interface GNewsArticle {
  title: string
  url: string
  publishedAt: string
  image?: string
  source?: { name?: string }
}

interface GNewsResponse {
  articles: GNewsArticle[]
}

interface TavilyNewsResponse {
  results?: Array<{ title?: string; url?: string; published_date?: string }>
  images?: Array<string | { url?: string }>
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'unknown source'
  }
}

/**
 * GNews path — a dedicated news API, so each article carries its own image.
 * Optional: only used when GNEWS_API_KEY is configured.
 */
async function getNewsFromGNews(apiKey: string, query?: string): Promise<NewsCardData> {
  const url = query
    ? `${GNEWS_SEARCH_URL}?q=${encodeURIComponent(query)}&lang=en&max=${MAX_ARTICLES}&apikey=${apiKey}`
    : `${GNEWS_TOP_URL}?lang=en&max=${MAX_ARTICLES}&apikey=${apiKey}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`GNews request failed (${res.status}).`)

  const json = (await res.json()) as GNewsResponse
  const raw = (json.articles ?? []).slice(0, MAX_ARTICLES)
  const images = await fetchImagesAsDataUris(raw.map((a) => a.image))

  const articles: NewsArticle[] = raw.map((a, i) => ({
    title: a.title,
    source: a.source?.name ?? hostOf(a.url),
    url: a.url,
    publishedAt: a.publishedAt,
    image: images[i]
  }))

  return { query: query ?? 'top headlines', articles, heroImages: [] }
}

/**
 * Tavily path — reuses the key already needed for web search, so news works
 * without a second signup. Tavily returns images for the *query* rather than
 * per article, so those become a single topic image instead of being pinned
 * onto individual headlines they may have nothing to do with.
 */
async function getNewsFromTavily(apiKey: string, query?: string): Promise<NewsCardData> {
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: query ?? 'top news headlines today',
      topic: 'news',
      days: 7,
      max_results: MAX_ARTICLES,
      include_images: true
    })
  })

  if (!res.ok) {
    if (res.status === 429) throw new Error("You've used up this month's free Tavily credits.")
    throw new Error(`News request failed (${res.status}).`)
  }

  const json = (await res.json()) as TavilyNewsResponse

  const articles: NewsArticle[] = (json.results ?? [])
    .filter((r) => r.title && r.url)
    .slice(0, MAX_ARTICLES)
    .map((r) => ({
      title: r.title as string,
      source: hostOf(r.url as string),
      url: r.url as string,
      publishedAt: r.published_date ?? '',
      image: null
    }))

  // Several topic images, cross-faded in the card — one static picture next to
  // four headlines looked arbitrary.
  const heroUrls = (json.images ?? [])
    .slice(0, 4)
    .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
  const heroImages = (await fetchImagesAsDataUris(heroUrls)).filter(
    (image): image is string => image !== null
  )

  return { query: query ?? 'top headlines', articles, heroImages }
}

/**
 * News headlines. Prefers GNews when configured (per-article images), and
 * otherwise falls back to Tavily so no extra API key is required.
 */
export async function getNews(query?: string): Promise<NewsCardData> {
  const gnewsKey = process.env.GNEWS_API_KEY
  if (gnewsKey) return getNewsFromGNews(gnewsKey, query)

  const tavilyKey = process.env.TAVILY_API_KEY
  if (tavilyKey) return getNewsFromTavily(tavilyKey, query)

  throw new Error(
    'News needs an API key. Add either TAVILY_API_KEY or GNEWS_API_KEY to your .env file.'
  )
}
