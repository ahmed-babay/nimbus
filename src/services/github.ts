import type { GithubCardData, GithubRepo } from '../shared/types'
import { httpFetch } from './http'

const SEARCH_URL = 'https://api.github.com/search/repositories'

interface GithubApiRepo {
  name: string
  full_name: string
  description: string | null
  stargazers_count: number
  html_url: string
  language: string | null
}

interface GithubSearchResponse {
  items: GithubApiRepo[]
}

/**
 * GitHub's public REST API. No auth required for search, but an optional
 * GITHUB_TOKEN raises the rate limit from 60/hr to 5000/hr.
 *
 * There's no official "trending" endpoint, so this approximates it: repos
 * created in the last 7 days, sorted by star count.
 */
export async function getTrendingRepos(language?: string): Promise<GithubCardData> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const langFilter = language ? `+language:${encodeURIComponent(language)}` : ''
  const q = `created:>${since}${langFilter}`

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  const res = await httpFetch(
    `${SEARCH_URL}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=5`,
    { headers }
  )

  if (!res.ok) {
    throw new Error(`GitHub request failed (${res.status}).`)
  }

  const json = (await res.json()) as GithubSearchResponse
  const items: GithubApiRepo[] = json.items ?? []

  const repos: GithubRepo[] = items.map((r) => ({
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? '',
    stars: r.stargazers_count,
    url: r.html_url,
    language: r.language
  }))

  return { language: language ?? null, repos }
}
