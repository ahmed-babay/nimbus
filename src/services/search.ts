import type { SearchCardData, SearchResult } from '../shared/types'
import { httpFetch } from './http'
import { inputBudgetChars } from './llm'

const SEARCH_URL = 'https://api.tavily.com/search'

interface TavilyResult {
  title: string
  url: string
  content: string
  raw_content?: string | null
  score?: number
  published_date?: string
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
function apiKey(): string {
  const key = process.env.TAVILY_API_KEY
  if (!key) {
    throw new Error(
      'Web search needs a free Tavily API key. Get one at app.tavily.com and add TAVILY_API_KEY to your .env file.'
    )
  }
  return key
}

async function tavily(body: Record<string, unknown>): Promise<TavilyResponse> {
  const res = await httpFetch(SEARCH_URL, {
    label: 'Tavily',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`
    },
    body: JSON.stringify(body),
    // Advanced searches fetch and extract page text, so they run noticeably
    // longer than the default snippet search.
    timeoutMs: 20000
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

  return (await res.json()) as TavilyResponse
}

export async function webSearch(query: string): Promise<SearchCardData> {
  const json = await tavily({
    query,
    max_results: 5,
    // Tavily can pre-summarize the results, which saves Gemini a hop.
    include_answer: true,
    search_depth: 'basic'
  })

  const results: SearchResult[] = (json.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content
  }))

  return { query, answer: json.answer ?? null, results }
}

/**
 * The snippet search's results in the shape the deep path produces.
 *
 * Snippets are thinner than read pages, but they are the same *kind* of thing
 * — a title, a host, and some text that was on the page — so everything
 * downstream that reads evidence works on both without a second code path.
 * Tavily's own summary leads, because it is the one part of a snippet search
 * that has already been aimed at the question.
 */
export function snippetEvidence(data: SearchCardData): Evidence[] {
  const pages = data.results.map((result) => ({
    title: result.title,
    url: result.url,
    host: hostOf(result.url),
    published: null,
    text: result.snippet
  }))
  if (!data.answer) return pages
  return [
    { title: 'Summary of the results', url: '', host: 'search', published: null, text: data.answer },
    ...pages
  ]
}

/** One page, trimmed to what the model should read. */
export interface Evidence {
  title: string
  url: string
  host: string
  published: string | null
  text: string
}

/** How much of any one page is worth reading — the answer is near the top. */
const MAX_CHARS_PER_SOURCE = 3500
/** Total reading budget. Past this, latency grows faster than accuracy. */
const MAX_TOTAL_CHARS = 22000
/** Pages kept after merging every query's results. */
const MAX_SOURCES = 8

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function readable(result: TavilyResult): string {
  // raw_content is the extracted page text; content is Tavily's snippet of the
  // relevant part. The snippet leads because it is already on-topic, and the
  // page body follows for the surrounding detail.
  const body = (result.raw_content ?? '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const combined = body.startsWith(result.content) ? body : `${result.content}\n\n${body}`
  return combined.slice(0, MAX_CHARS_PER_SOURCE).trim()
}

/**
 * Runs several searches at full depth and merges them into one ranked, deduped
 * reading list. Queries run in parallel: a three-part question should not take
 * three times as long to answer.
 */
export async function deepSearch(
  queries: string[]
): Promise<{ evidence: Evidence[]; results: SearchResult[] }> {
  apiKey()

  const settled = await Promise.allSettled(
    queries.map((query) =>
      tavily({
        query,
        max_results: 6,
        search_depth: 'advanced',
        include_raw_content: 'text'
      })
    )
  )

  // One failed sub-query shouldn't sink the whole answer — the others may well
  // cover the question.
  const failures = settled.filter((s) => s.status === 'rejected')
  if (failures.length === settled.length && failures.length > 0) {
    throw (failures[0] as PromiseRejectedResult).reason
  }

  // Interleaved rather than pooled-and-ranked. Ranking everything together
  // lets one sub-query's results fill the whole budget — asking about two
  // things gets you eight pages on the more heavily covered one, and the
  // other half of the question comes back unanswered.
  const perQuery = settled.map((outcome) =>
    outcome.status === 'fulfilled'
      ? (outcome.value.results ?? [])
          .filter((r) => r.url)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      : []
  )

  const seen = new Set<string>()
  const top: TavilyResult[] = []
  const deepest = Math.max(0, ...perQuery.map((list) => list.length))
  for (let rank = 0; rank < deepest && top.length < MAX_SOURCES; rank++) {
    for (const list of perQuery) {
      if (top.length >= MAX_SOURCES) break
      const result = list[rank]
      if (!result || seen.has(result.url)) continue
      seen.add(result.url)
      top.push(result)
    }
  }

  const evidence: Evidence[] = []
  // Capped by what the answering model can actually read: on a cloud provider
  // this is the full reading budget, on the on-device model it is its window.
  // Gathering evidence the model then has to drop is worse than gathering
  // less, because what gets dropped is chosen by truncation rather than rank.
  let budget = Math.min(MAX_TOTAL_CHARS, inputBudgetChars())
  for (const result of top) {
    const text = readable(result)
    if (!text) continue
    // Always admit the first source, even if it is long; after that, stop
    // once the budget is gone rather than truncating everything to nothing.
    if (evidence.length > 0 && text.length > budget) break
    budget -= text.length
    evidence.push({
      title: result.title,
      url: result.url,
      host: hostOf(result.url),
      published: result.published_date ?? null,
      text
    })
  }

  const results: SearchResult[] = top.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content
  }))

  return { evidence, results }
}
