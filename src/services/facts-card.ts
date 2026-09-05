import type { FactGroup, FactLayout, FactRow, FactsCardData, SearchResult } from '../shared/types'

/**
 * Turning the extraction model's JSON into a card, or into nothing.
 *
 * Deliberately separate from `facts.ts`, which talks to a provider: this is
 * the half that decides whether the user sees a laid-out answer or the plain
 * list of links, and that decision has to be exercisable in a test without a
 * key, a network, or the on-device runtime being loaded to reach it.
 *
 * Everything here treats the reply as hostile input. It came from a model that
 * read pages nobody controls, so every field is re-typed, re-measured and
 * re-trimmed on the way in, and anything that does not survive that is simply
 * absent from the card rather than rendered empty.
 */

/** Every layout the extraction is allowed to pick, and the schema's enum. */
export const LAYOUTS: FactLayout[] = [
  'price',
  'metric',
  'profile',
  'comparison',
  'list',
  'steps',
  'timeline'
]

interface RawRow {
  label?: unknown
  value?: unknown
  note?: unknown
  trend?: unknown
}

interface RawFacts {
  usable?: unknown
  layout?: unknown
  title?: unknown
  subtitle?: unknown
  headline?: unknown
  headlineLabel?: unknown
  headlineNote?: unknown
  rows?: unknown
  groups?: unknown
  bullets?: unknown
}

/** Providers without constrained decoding still sometimes fence their JSON. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/\s+/g, ' ').trim()
  // Dropping an oversized field is safer than cutting off its unit or caveat.
  return clean.length > max ? '' : clean
}

function rows(value: unknown, max: number): FactRow[] {
  if (!Array.isArray(value)) return []
  const out: FactRow[] = []
  for (const entry of value as RawRow[]) {
    const label = text(entry?.label, 26)
    const item = text(entry?.value, 64)
    // A row with no value says nothing and takes a whole line to say it.
    if (!label || !item) continue
    const note = text(entry?.note, 40)
    const trend = entry?.trend === 'up' || entry?.trend === 'down' ? entry.trend : undefined
    out.push({ label, value: item, ...(note ? { note } : {}), ...(trend ? { trend } : {}) })
    if (out.length >= max) break
  }
  return out
}

function groups(value: unknown, sources: SearchResult[]): FactGroup[] {
  if (!Array.isArray(value)) return []
  const out: FactGroup[] = []
  for (const entry of value as Array<Record<string, unknown>>) {
    const title = text(entry?.title, 34)
    if (!title) continue
    const headline = text(entry?.headline, 24)
    const note = text(entry?.sourceNote, 32)
    const inner = rows(entry?.rows, 6)
    // A group with a title and nothing else is a heading, not a column.
    if (!headline && inner.length === 0) continue
    // Matched back to a real source by host name so the group can be opened.
    // Only ever a link that was actually read — never one the model wrote.
    const match = note
      ? sources.find((source) => {
          try {
            const url = new URL(source.url)
            const host = url.hostname.toLowerCase().replace(/^www\./, '')
            return ['http:', 'https:'].includes(url.protocol) && host === note.toLowerCase()
          } catch { return false }
        })
      : undefined
    out.push({
      title,
      ...(headline ? { headline } : {}),
      ...(note ? { note } : {}),
      rows: inner,
      ...(match ? { url: match.url } : {})
    })
    if (out.length >= 4) break
  }
  return out
}

function bullets(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return (value as unknown[])
    .map((entry) => text(entry, 150))
    .filter((entry) => entry.length > 0)
    .slice(0, 6)
}

/**
 * Whether what came back is worth showing instead of the plain search card.
 *
 * The bar is deliberately "would a person look at this and learn something the
 * sentence above did not already tell them". One row and a title is not that;
 * it is a table with one entry, which looks like a bug.
 */
function worthShowing(card: FactsCardData): boolean {
  if (!card.title) return false
  if ((card.layout === 'price' || card.layout === 'metric') && card.headline) return true
  const substance =
    card.rows.length + card.groups.length + card.bullets.length + (card.headline ? 2 : 0)
  if (card.layout === 'comparison') return card.groups.length >= 2
  if (card.layout === 'list' || card.layout === 'steps') return card.bullets.length >= 2
  return substance >= 3
}

/**
 * Everything between the model's reply and a card, with no I/O in it.
 *
 * Split out from `extractFacts` because this is the part that decides whether
 * the user sees a laid-out answer or three blue links, and that decision has
 * to be testable without a provider, a key, or a network. Throws on
 * unparseable JSON; the caller treats any throw as "no card".
 */
export function factsFromReply(
  reply: string,
  input: { query: string; sources: SearchResult[] }
): FactsCardData | null {
  const parsed = JSON.parse(stripFences(reply)) as RawFacts
  if (!parsed || typeof parsed !== 'object' || parsed.usable !== true) return null

  const layout = LAYOUTS.includes(parsed.layout as FactLayout)
    ? (parsed.layout as FactLayout)
    : 'profile'
  const card: FactsCardData = {
    layout,
    title: text(parsed.title, 48),
    subtitle: text(parsed.subtitle, 64) || undefined,
    headline: text(parsed.headline, 24) || undefined,
    headlineLabel: text(parsed.headlineLabel, 28) || undefined,
    headlineNote: text(parsed.headlineNote, 48) || undefined,
    rows: rows(parsed.rows, 6),
    groups: groups(parsed.groups, input.sources),
    bullets: bullets(parsed.bullets),
    // Filled in by the caller once the spoken answer exists. Deliberately not
    // an input: this runs *alongside* the answer being written rather than
    // after it. Extraction uses a separate cloud model request.
    answer: '',
    query: input.query,
    sources: input.sources
  }
  return worthShowing(card) ? card : null
}
