import type { TvCardData, TvEpisode } from '../shared/types'
import { fetchImagesAsDataUris } from './images'
import { httpFetch } from './http'

const SEARCH_URL = 'https://api.tvmaze.com/singlesearch/shows'

interface MazeEpisode {
  name?: string
  season?: number
  number?: number
  airstamp?: string
}

interface MazeShow {
  name?: string
  status?: string
  network?: { name?: string } | null
  webChannel?: { name?: string } | null
  image?: { medium?: string } | null
  _embedded?: { nextepisode?: MazeEpisode | null }
  _links?: { previousepisode?: { href?: string } }
}

/**
 * TV schedules from TVMaze — no key, no signup.
 *
 * "When's the next episode" has three honest answers, and the useful part of
 * this service is telling them apart: there is a date, or the show is running
 * but nothing is scheduled yet, or it is over. A card that only handled the
 * first would be wrong exactly when the question is worth asking — between
 * seasons, which is when nobody knows the answer offhand.
 */

function episodeOf(raw: MazeEpisode | null | undefined): TvEpisode | null {
  if (!raw) return null
  return {
    // TVMaze uses "TBA" for an episode that is scheduled before it is titled.
    title: raw.name && raw.name !== 'TBA' ? raw.name : null,
    season: raw.season ?? null,
    number: raw.number ?? null,
    airstamp: raw.airstamp ?? null
  }
}

/** The last episode is a separate resource; only fetched when it is the answer. */
async function previousEpisode(href: string | undefined): Promise<TvEpisode | null> {
  if (!href) return null
  try {
    const res = await httpFetch(href, { label: 'TVMaze episode', timeoutMs: 8000 })
    if (!res.ok) return null
    return episodeOf((await res.json()) as MazeEpisode)
  } catch {
    // A missing "and the last one was…" is a smaller loss than no answer.
    return null
  }
}

export async function nextEpisode(show: string): Promise<TvCardData> {
  const res = await httpFetch(
    `${SEARCH_URL}?q=${encodeURIComponent(show)}&embed=nextepisode`,
    { label: 'TVMaze', timeoutMs: 10000, retries: 1 }
  )

  if (res.status === 404) {
    throw new Error(`I couldn't find a show called "${show}".`)
  }
  if (!res.ok) {
    throw new Error(`The TV lookup failed (${res.status}).`)
  }

  const json = (await res.json()) as MazeShow
  const next = episodeOf(json._embedded?.nextepisode)
  const previous = next ? null : await previousEpisode(json._links?.previousepisode?.href)

  // The overlay's CSP blocks remote images, so the poster travels as a data
  // URI the same way news thumbnails do.
  const [poster] = await fetchImagesAsDataUris([json.image?.medium])

  return {
    show: json.name ?? show,
    status: json.status ?? 'Unknown',
    network: json.network?.name ?? json.webChannel?.name ?? null,
    next,
    previous,
    poster
  }
}

/** "season 2 episode 3", as much of it as is known. */
function label(episode: TvEpisode): string {
  const parts: string[] = []
  if (episode.season !== null) parts.push(`season ${episode.season}`)
  if (episode.number !== null) parts.push(`episode ${episode.number}`)
  return parts.join(' ')
}

/**
 * How far off it is, in the words someone would actually use. Same shape as
 * the holiday answer: near dates get a weekday, distant ones get a date.
 *
 * Runs backwards as well as forwards — the last-aired episode of a finished
 * show is years old, and calling that "today" is how a relative date goes
 * wrong.
 */
function when(airstamp: string): string {
  const date = new Date(airstamp)
  if (Number.isNaN(date.getTime())) return ''
  const days = Math.round((date.getTime() - Date.now()) / 86400_000)

  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'

  const weekday = date.toLocaleDateString('en-GB', { weekday: 'long' })
  if (days > 1 && days < 7) return `on ${weekday}`
  if (days < -1 && days > -7) return `last ${weekday}`

  const full = date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    // A show that ended years ago needs the year; one airing this season
    // does not, and the sentence reads better without it.
    year: Math.abs(days) > 300 ? 'numeric' : undefined
  })
  return `on ${full}`
}

/**
 * Written out rather than handed to the model, because every useful part of
 * this answer is a date. A sentence that invents one is worse than no answer.
 */
export function describeEpisode(data: TvCardData): string {
  if (data.next) {
    const bits = [data.show, label(data.next)].filter(Boolean).join(', ')
    const title = data.next.title ? `, "${data.next.title}",` : ''
    const airs = data.next.airstamp ? ` airs ${when(data.next.airstamp)}` : ' has no air date yet'
    return `${bits}${title}${airs}.`
  }

  const last =
    data.previous?.airstamp && when(data.previous.airstamp)
      ? ` The last one, ${label(data.previous)}, aired ${when(data.previous.airstamp)}.`
      : ''

  if (data.status.toLowerCase() === 'ended') {
    return `${data.show} has ended.${last}`
  }

  return `${data.show} is still running, but the next episode has not been scheduled yet.${last}`
}
