import { httpFetch } from './http'
import type { CalendarEvent } from '../shared/types'
import config from '../../config.json'

/**
 * Public holidays, which in Germany decide more than a day off.
 *
 * Shops shut completely, transport moves to a Sunday timetable, and the
 * holidays differ by federal state — Fronleichnam is a holiday in Hesse and an
 * ordinary Thursday in Berlin. "Is Monday a holiday?" is therefore a real
 * question with a real consequence, and one a general-purpose assistant
 * answers badly because it has no idea which state you live in.
 *
 * **Nager.Date** is free, needs no key and no account, and covers a hundred
 * countries with per-state ("county") detail.
 *
 * Returned as `CalendarEvent`s on purpose: they are days on a calendar, the
 * card that renders those already exists, and it means holidays can sit
 * alongside the user's own entries in a briefing without a second shape.
 */

const BASE_URL = 'https://date.nager.at/api/v3'

interface NagerHoliday {
  date?: string
  localName?: string
  name?: string
  global?: boolean
  /** ISO subdivisions, e.g. "DE-HE" for Hesse. Null means nationwide. */
  counties?: string[] | null
}

/** Enough of Europe to cover where this is realistically used. */
const COUNTRIES: Record<string, string> = {
  germany: 'DE',
  deutschland: 'DE',
  austria: 'AT',
  switzerland: 'CH',
  france: 'FR',
  netherlands: 'NL',
  belgium: 'BE',
  poland: 'PL',
  italy: 'IT',
  spain: 'ES',
  portugal: 'PT',
  'united kingdom': 'GB',
  england: 'GB',
  ireland: 'IE',
  turkey: 'TR',
  'united states': 'US',
  usa: 'US',
  canada: 'CA'
}

/** German states, so a Hessian holiday isn't reported to someone in Berlin. */
const GERMAN_STATES: Record<string, string> = {
  hesse: 'DE-HE',
  hessen: 'DE-HE',
  bavaria: 'DE-BY',
  bayern: 'DE-BY',
  berlin: 'DE-BE',
  hamburg: 'DE-HH',
  saxony: 'DE-SN',
  sachsen: 'DE-SN',
  'baden-württemberg': 'DE-BW',
  'baden-wurttemberg': 'DE-BW',
  'north rhine-westphalia': 'DE-NW',
  nordrhein: 'DE-NW',
  'lower saxony': 'DE-NI',
  niedersachsen: 'DE-NI',
  'rhineland-palatinate': 'DE-RP',
  bremen: 'DE-HB',
  thuringia: 'DE-TH',
  brandenburg: 'DE-BB',
  saarland: 'DE-SL'
}

/** Reads the country out of the configured region, defaulting to Germany. */
export function homeCountry(): string {
  const region = (config.location?.region ?? '').toLowerCase()
  for (const [name, code] of Object.entries(COUNTRIES)) {
    if (region.includes(name)) return code
  }
  return 'DE'
}

/** The federal state, when the configured region names one. */
function homeState(): string | null {
  const region = (config.location?.region ?? '').toLowerCase()
  for (const [name, code] of Object.entries(GERMAN_STATES)) {
    if (region.includes(name)) return code
  }
  return null
}

/**
 * Whether a holiday applies where the user actually lives.
 *
 * `counties` names the subdivisions a regional holiday covers. A holiday with
 * no counties is nationwide; one with counties only counts if ours is listed.
 * Skipping this check is how an assistant confidently tells someone in Berlin
 * that the shops are shut.
 */
function appliesHere(holiday: NagerHoliday, state: string | null): boolean {
  if (!holiday.counties || holiday.counties.length === 0) return true
  if (!state) return false
  return holiday.counties.includes(state)
}

export async function upcomingHolidays(): Promise<CalendarEvent[]> {
  const country = homeCountry()
  const res = await httpFetch(`${BASE_URL}/NextPublicHolidays/${country}`, {
    label: 'Nager.Date',
    timeoutMs: 8000,
    retries: 1
  })
  if (!res.ok) throw new Error(`I couldn't look up public holidays (${res.status}).`)

  const json = (await res.json()) as NagerHoliday[]
  const state = homeState()

  return json
    .filter((holiday) => holiday.date && appliesHere(holiday, state))
    .slice(0, 8)
    .map((holiday) => ({
      id: `holiday-${holiday.date}`,
      // The local name is what it is called where it is observed; the English
      // one is a translation nobody uses out loud.
      title: holiday.localName || holiday.name || 'Public holiday',
      startDate: holiday.date as string,
      createdAt: new Date().toISOString()
    }))
}

/** "Thursday is a public holiday" — phrased for speech. */
export function describeHolidays(holidays: CalendarEvent[]): string {
  if (holidays.length === 0) return 'I found no public holidays coming up.'

  const next = holidays[0]
  const date = new Date(`${next.startDate}T12:00:00`)
  const days = Math.round((date.getTime() - Date.now()) / 86400_000)
  const when =
    days <= 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days < 7
          ? `on ${date.toLocaleDateString('en-GB', { weekday: 'long' })}`
          : `on ${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`

  return `The next public holiday is ${next.title}, ${when}.`
}
