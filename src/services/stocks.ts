import type { StockCardData, StockRange } from '../shared/types'
import { httpFetch } from './http'

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search'

// Yahoo's endpoint rejects requests without a browser-like User-Agent.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface YahooSearchResponse {
  quotes?: Array<{ symbol?: string; quoteType?: string }>
}

/**
 * Look a company name up as a ticker. Deliberately *not* guessed from the
 * shape of the input — "Apple" and "Tesla" are five letters and look exactly
 * like tickers, so a length heuristic silently sent them straight through and
 * 404'd. Callers try the input as a symbol first and only come here on a miss.
 */
async function searchSymbol(input: string): Promise<string | null> {
  const res = await httpFetch(
    `${SEARCH_URL}?q=${encodeURIComponent(input)}&quotesCount=5&newsCount=0`,
    { headers: { 'User-Agent': BROWSER_UA } }
  )
  if (!res.ok) return null

  const json = (await res.json()) as YahooSearchResponse
  const match =
    json.quotes?.find((q) => q.symbol && q.quoteType === 'EQUITY') ??
    json.quotes?.find((q) => q.symbol)
  return match?.symbol ?? null
}

/**
 * Sampling interval per range. Chosen so every window lands somewhere between
 * 50 and 130 points: enough to show shape, few enough that the line isn't
 * noise at card size.
 */
const INTERVALS: Record<StockRange, string> = {
  '1d': '5m',
  '5d': '30m',
  '1mo': '1d',
  '6mo': '1d',
  '1y': '1wk'
}

/**
 * Fetches a quote plus history for one window, returning null for anything
 * without a usable price.
 *
 * The range is not just cosmetic. Yahoo's `chartPreviousClose` is the price at
 * the *start of the requested range*, so a month of history makes the change
 * figure a monthly one. Asking for a day is what makes "down 1.2% today"
 * actually mean today.
 */
async function fetchQuote(
  ticker: string,
  range: StockRange
): Promise<{ meta: YahooChartResult['meta']; history: number[] } | null> {
  const res = await httpFetch(
    `${CHART_URL}/${encodeURIComponent(ticker)}?interval=${INTERVALS[range]}&range=${range}`,
    { headers: { 'User-Agent': BROWSER_UA } }
  )
  if (!res.ok) return null

  const json = (await res.json()) as YahooChartResponse
  const result = json.chart?.result?.[0]
  const meta = result?.meta
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null

  const history = (result?.indicators?.quote?.[0]?.close ?? []).filter(
    (value): value is number => typeof value === 'number'
  )
  return { meta, history }
}

interface YahooChartResult {
  meta: {
    symbol: string
    shortName?: string
    longName?: string
    currency?: string
    regularMarketPrice: number
    chartPreviousClose: number
    regularMarketDayHigh: number
    regularMarketDayLow: number
    /**
     * Session window as epoch seconds. This endpoint does NOT return
     * `marketState` despite it appearing on Yahoo's quote API — reading it
     * here silently yielded undefined, so "live" was always false and the
     * chart never polled at all.
     */
    currentTradingPeriod?: {
      regular?: { start?: number; end?: number }
    }
  }
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>
  }
}

/** True while the exchange's regular session is running right now. */
function inSession(meta: YahooChartResult['meta']): boolean {
  const period = meta.currentTradingPeriod?.regular
  if (!period?.start || !period?.end) return false
  const now = Date.now() / 1000
  return now >= period.start && now <= period.end
}

interface YahooChartResponse {
  chart: {
    result: YahooChartResult[] | null
    error: { description: string } | null
  }
}

/**
 * Yahoo Finance's public (but undocumented/unofficial) chart endpoint — no
 * signup or API key needed. Since it's not an official API, Yahoo could
 * change or block it without notice; this is the one place to swap in a
 * keyed alternative (Finnhub, Alpha Vantage, etc.) if that ever happens.
 */
export async function getStockQuote(
  symbol: string,
  range: StockRange = '1d'
): Promise<StockCardData> {
  const candidate = symbol.trim().toUpperCase()

  // Speech gives company names ("how's Apple doing") and the chart endpoint
  // only accepts exact tickers. Validate on the *parsed* payload, not the
  // status code: Yahoo answers some bad symbols with 200 and an empty result,
  // so a status-only check let those through as a priceless card.
  let quote = await fetchQuote(candidate, range)

  if (!quote) {
    const resolved = await searchSymbol(symbol)
    if (resolved && resolved.toUpperCase() !== candidate) {
      quote = await fetchQuote(resolved.toUpperCase(), range)
    }
  }

  if (!quote) {
    throw new Error(`I couldn't find a stock called "${symbol}".`)
  }

  const { meta, history } = quote
  const change = meta.regularMarketPrice - meta.chartPreviousClose
  const changePercent = (change / meta.chartPreviousClose) * 100

  return {
    symbol: meta.symbol,
    // Yahoo pads some names to a fixed width — "SAP SE            I".
    name: (meta.shortName || meta.longName || meta.symbol).replace(/\s+/g, ' ').trim(),
    price: meta.regularMarketPrice,
    change,
    changePercent,
    high: meta.regularMarketDayHigh,
    low: meta.regularMarketDayLow,
    range,
    history,
    currency: meta.currency || 'USD',
    // Derived from the session window rather than a status string, because
    // the chart endpoint doesn't send one. Works for crypto too, whose
    // "session" spans the whole day.
    live: inSession(meta)
  }
}
