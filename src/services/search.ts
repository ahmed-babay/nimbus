import type { SearchCardData, SearchResult } from '../shared/types'
import { httpFetch } from './http'

const SEARCH_URL = 'https://api.tavily.com/search'

interface TavilyResult {
  title: string
  url: string
  content: string
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

/**
 * General web search via Tavily's free tier (1,000 credits/month, no card):
 * https://app.tavily.com/home
 *
 * This is the general-purpose escape hatch — instead of bolting on a
 * dedicated API for every topic, anything that needs live information the
 * model doesn't know can go through here.
 *
 * Why Tavily and not something key-free? As of 2026 the key-free options
 * don't hold up: Bing's Search API was retired (Aug 2025), Brave dropped its
 * free tier (Feb 2026), Gemini's built-in Google Search grounding is
 * paid-tier only, and DuckDuckGo's Instant Answer API returns nothing for
 * ordinary queries. Self-hosted SearXNG is genuinely free and unlimited but
 * needs a Docker instance babysat alongside the app.
 */
export async function webSearch(query: string): Promise<SearchCardData> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    throw new Error(
      'Web search needs a free Tavily API key. Get one at app.tavily.com and add TAVILY_API_KEY to your .env file.'
    )
  }

  const res = await httpFetch(SEARCH_URL, {
    label: 'Tavily',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      max_results: 5,
      // Tavily can pre-summarize the results, which saves Gemini a hop.
      include_answer: true,
      search_depth: 'basic'
    })
  })

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('The Tavily API key looks invalid. Check TAVILY_API_KEY in your .env file.')
    }
    if (res.status === 429) {
      throw new Error("You've used up this month's free Tavily search credits.")
    }
    throw new Error(`Web search failed (${res.status}).`)
  }

  const json = (await res.json()) as TavilyResponse

  const results: SearchResult[] = (json.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content
  }))

  return { query, answer: json.answer ?? null, results }
}
