import { httpFetch } from './http'
import type { CurrencyCardData } from '../shared/types'

/**
 * "How much is 50 euros in dollars."
 *
 * Rates come from **Frankfurter**, which serves the European Central Bank's
 * own published reference rates — free, no key, no account, and authoritative
 * rather than scraped. The ECB publishes once per working day around 16:00
 * CET, so the card shows the rate's date: a number that is quietly a day old
 * is fine for "what's this worth", and misleading if presented as live.
 *
 * Deliberately not sent through the answer model. A conversion is arithmetic,
 * and a model that occasionally miscalculates one is worse than no feature —
 * so the maths happens here and the model is never asked.
 */

const BASE_URL = 'https://api.frankfurter.dev/v1'

interface FrankfurterResponse {
  amount?: number
  base?: string
  date?: string
  rates?: Record<string, number>
}

/**
 * What people say, mapped to ISO codes. Speech gives "dollars" and "quid", the
 * API wants USD and GBP.
 */
const SPOKEN: Record<string, string> = {
  euro: 'EUR',
  euros: 'EUR',
  eur: 'EUR',
  dollar: 'USD',
  dollars: 'USD',
  usd: 'USD',
  'us dollars': 'USD',
  pound: 'GBP',
  pounds: 'GBP',
  sterling: 'GBP',
  quid: 'GBP',
  gbp: 'GBP',
  franc: 'CHF',
  francs: 'CHF',
  chf: 'CHF',
  yen: 'JPY',
  jpy: 'JPY',
  lira: 'TRY',
  'turkish lira': 'TRY',
  try: 'TRY',
  zloty: 'PLN',
  pln: 'PLN',
  krona: 'SEK',
  crown: 'SEK',
  rupee: 'INR',
  rupees: 'INR',
  inr: 'INR',
  yuan: 'CNY',
  renminbi: 'CNY',
  cny: 'CNY',
  real: 'BRL',
  rand: 'ZAR',
  peso: 'MXN',
  'canadian dollars': 'CAD',
  cad: 'CAD',
  'australian dollars': 'AUD',
  aud: 'AUD'
}

/** Best effort at turning whatever was said into a three-letter code. */
export function currencyCode(input: string | undefined, fallback: string): string {
  const text = (input ?? '').trim().toLowerCase()
  if (!text) return fallback
  if (SPOKEN[text]) return SPOKEN[text]
  // Already a code.
  if (/^[a-z]{3}$/.test(text)) return text.toUpperCase()
  // "50 US dollars" — find any known word inside a longer phrase.
  for (const [word, code] of Object.entries(SPOKEN)) {
    if (text.includes(word)) return code
  }
  return fallback
}

export async function convertCurrency(
  amount: number,
  from: string,
  to: string
): Promise<CurrencyCardData> {
  if (from === to) {
    throw new Error(`${from} and ${to} are the same currency.`)
  }

  const res = await httpFetch(
    `${BASE_URL}/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`,
    // Behind Cloudflare, which intermittently rate-limits and can take a
    // couple of seconds to answer; a tight timeout turned a working lookup
    // into a failure. Two retries, because the first one demonstrably
    // rescued a request during testing.
    { label: 'Frankfurter', timeoutMs: 12000, retries: 2 }
  )
  if (!res.ok) {
    throw new Error(`I couldn't get a rate for ${from} to ${to}.`)
  }

  const json = (await res.json()) as FrankfurterResponse
  // An unrecognised code is silently *dropped* from the rates object rather
  // than 404'd, so a missing rate is the "I don't know that currency" signal.
  const rate = json.rates?.[to]
  if (typeof rate !== 'number') {
    throw new Error(`I don't know a currency called ${to}.`)
  }

  return {
    amount,
    from,
    to,
    rate,
    result: amount * rate,
    // The ECB's publication date, not today's — see the note at the top.
    asOf: json.date ?? ''
  }
}

/** Spoken form, computed here so no model is asked to do arithmetic. */
export function describeConversion(data: CurrencyCardData): string {
  const round = (value: number): string =>
    value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(4)
  return `${round(data.amount)} ${data.from} is about ${round(data.result)} ${data.to}.`
}
