import { getWeather } from './weather'
import { getNews } from './news'
import { findJourneys } from './transit'
import { geocode, homeLocation } from './maps'
import { pendingReminders } from './reminders'
import type { BriefingCardData } from '../shared/types'
import config from '../../config.json'

/**
 * "What does my day look like" — weather, the next departures on your usual
 * route, today's reminders and a couple of headlines, in one answer.
 *
 * Nothing here is new capability: it is the five services that already exist,
 * asked at once. That is the point — it turns a set of things you *could* ask
 * into the one thing you actually want on the way out of the door.
 *
 * Every section is independently optional. A briefing that fails because the
 * news provider is down is worse than useless, so each piece is settled
 * separately and simply omitted when it fails.
 */

/** Reminders beyond this are not part of "today" in any useful sense. */
const HORIZON_HOURS = 18

function homeCity(): string {
  // The region is "Darmstadt, Hesse, Germany"; the weather API wants the city.
  const configured = config.briefing?.weatherCity
  if (configured) return configured
  return (config.location?.region || '').split(',')[0].trim()
}

async function weatherSection(): Promise<BriefingCardData['weather']> {
  if (!config.integrations.weather) return null
  const city = homeCity()
  if (!city) return null
  try {
    const weather = await getWeather(city)
    // OpenWeatherMap labels this location "Regierungsbezirk Darmstadt" — the
    // administrative district, not the city. The coordinates it used are the
    // right ones, so the configured name is the more accurate label of the
    // two, and far more readable on a card.
    return { ...weather, city }
  } catch {
    return null
  }
}

async function commuteSection(): Promise<BriefingCardData['commute']> {
  const destination = config.briefing?.commuteTo
  if (!destination || !config.integrations.transit) return null
  try {
    // Coordinates on both ends, for the reason documented in transit.ts:
    // handing a second geocoder the raw words picks a different place.
    const origin = await homeLocation()
    if (!origin) return null
    const target = await geocode(destination, origin)
    if (!target) return null
    const plan = await findJourneys(origin, target)
    return plan.journeys.length > 0 ? plan : null
  } catch {
    return null
  }
}

/**
 * Headlines are only worth having if they're real ones. Asked for "top news
 * headlines today" the provider returns aggregator filler — "School Assembly
 * News Headlines", "MONDAY NEWS IN A RUSH". Asked for a country it returns
 * actual reporting from DW, Reuters and the like, which is also the news a
 * briefing should carry: the one where the user lives.
 */
function newsTopic(): string | undefined {
  const configured = config.briefing?.newsTopic
  if (configured) return configured
  const region = config.location?.region || ''
  const country = region.split(',').pop()?.trim()
  return country || undefined
}

async function newsSection(): Promise<BriefingCardData['news']> {
  if (!config.integrations.news) return null
  try {
    const news = await getNews(newsTopic())
    return news.articles.length > 0 ? { ...news, articles: news.articles.slice(0, 3) } : null
  } catch {
    return null
  }
}

export async function buildBriefing(): Promise<BriefingCardData> {
  const horizon = Date.now() + HORIZON_HOURS * 3600_000
  const reminders = pendingReminders().filter(
    (reminder) => new Date(reminder.at).getTime() <= horizon
  )

  // All three network sections at once: a briefing that took the sum of their
  // latencies would be slower than asking the questions separately.
  const [weather, commute, news] = await Promise.all([
    weatherSection(),
    commuteSection(),
    newsSection()
  ])

  return { weather, commute, news, reminders }
}
