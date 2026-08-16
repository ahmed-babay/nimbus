import type { StockCardData } from '../shared/types'
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
 * Fetches a quote plus a month of daily closes in one call, returning null
 * for anything without a usable price. The `1mo` range costs nothing extra
 * over `1d` and gives the card a real sparkline instead of a bare number.
 */
async function fetchQuote(
  ticker: string
): Promise<{ meta: YahooChartResult['meta']; history: number[] } | null> {
  const res = await httpFetch(`${CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=1mo`, {
    headers: { 'User-Agent': BROWSER_UA }
  })
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
    regularMarketPrice: number
    chartPreviousClose: number
    regularMarketDayHigh: number
    regularMarketDayLow: number
  }
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>
  }
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
export async function getStockQuote(symbol: string): Promise<StockCardData> {
  const candidate = symbol.trim().toUpperCase()

  // Speech gives company names ("how's Apple doing") and the chart endpoint
  // only accepts exact tickers. Validate on the *parsed* payload, not the
  // status code: Yahoo answers some bad symbols with 200 and an empty result,
  // so a status-only check let those through as a priceless card.
  let quote = await fetchQuote(candidate)

  if (!quote) {
    const resolved = await searchSymbol(symbol)
    if (resolved && resolved.toUpperCase() !== candidate) {
      quote = await fetchQuote(resolved.toUpperCase())
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
    price: meta.regularMarketPrice,
    change,
    changePercent,
    high: meta.regularMarketDayHigh,
    low: meta.regularMarketDayLow,
    history
  }
}
