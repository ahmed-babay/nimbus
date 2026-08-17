import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getStockQuote } from './stocks'
import type { StockCardData } from '../shared/types'

/**
 * The tickers you actually care about, and the prices you want to be told
 * about.
 *
 * Two things live here because they are the same list from the user's side —
 * "my stocks" — even though one is passive and one fires. Splitting them would
 * mean adding Tesla twice to both follow it and be alerted on it.
 *
 * The alert half is the interesting one: "tell me when Tesla drops below 300"
 * is a question no chat assistant can answer, because answering it means being
 * awake in four hours. Same shape as the train and weather watchers, polled by
 * the same scheduler.
 */

const MAX_SYMBOLS = 12
const MAX_ALERTS = 12

/**
 * Not re-armed after firing. An alert that fired at 299.90 would fire again at
 * 299.85 and again at 299.80, which is a notification storm at exactly the
 * moment the user is trying to think.
 */
export interface PriceAlert {
  id: string
  symbol: string
  direction: 'below' | 'above'
  price: number
  createdAt: string
}

interface WatchlistFile {
  version: 1
  symbols: string[]
  alerts: PriceAlert[]
}

let cache: WatchlistFile | null = null
let storePath: string | null = null

function path(): string {
  if (!storePath) storePath = join(app.getPath('userData'), 'watchlist.json')
  return storePath
}

function load(): WatchlistFile {
  if (cache) return cache
  try {
    if (!existsSync(path())) {
      cache = { version: 1, symbols: [], alerts: [] }
      return cache
    }
    const parsed = JSON.parse(readFileSync(path(), 'utf8')) as Partial<WatchlistFile>
    cache = {
      version: 1,
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [],
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : []
    }
  } catch (err) {
    console.error('[watchlist] could not read store, starting empty:', err)
    cache = { version: 1, symbols: [], alerts: [] }
  }
  return cache
}

function save(): void {
  if (!cache) return
  try {
    const temp = `${path()}.tmp`
    writeFileSync(temp, JSON.stringify(cache), 'utf8')
    renameSync(temp, path())
  } catch (err) {
    console.error('[watchlist] could not write store:', err)
  }
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function watchedSymbols(): string[] {
  return load().symbols
}

export function priceAlerts(): PriceAlert[] {
  return load().alerts
}

/** Returns the resolved ticker, so "Apple" is stored as AAPL. */
export async function addToWatchlist(symbol: string): Promise<string> {
  const store = load()
  if (store.symbols.length >= MAX_SYMBOLS) {
    throw new Error("That's as many stocks as I can follow at once.")
  }
  // Priced first so a typo fails here rather than becoming a permanent row
  // that errors every time the list is opened.
  const quote = await getStockQuote(symbol, '1d')
  if (!store.symbols.includes(quote.symbol)) {
    store.symbols.push(quote.symbol)
    save()
  }
  return quote.symbol
}

export function removeFromWatchlist(symbol: string): boolean {
  const store = load()
  const upper = symbol.trim().toUpperCase()
  const before = store.symbols.length
  store.symbols = store.symbols.filter((entry) => entry.toUpperCase() !== upper)
  if (store.symbols.length === before) return false
  save()
  return true
}

export function cancelPriceAlertById(target: string): boolean {
  const store = load()
  const before = store.alerts.length
  store.alerts = store.alerts.filter((alert) => alert.id !== target)
  if (store.alerts.length === before) return false
  save()
  return true
}

/**
 * Pulls the threshold out of the sentence.
 *
 * A backstop for the router, which reliably picks the *action* but keeps
 * omitting the number: "tell me when Tesla drops below 300" came back with
 * stockAction "alert" and no alertPrice at all.
 *
 * Two passes, because an earlier single pass was far too narrow and broke on
 * the most natural phrasing there is. It matched "drops below 300" but not
 * "goes down to $200" -- and a price alert that cannot read "down to" is a
 * price alert nobody can use.
 *
 *  1. A comparison word followed by a number, which also tells us the side.
 *  2. Failing that, any number at all, with the direction taken from whatever
 *     directional word appears anywhere in the sentence.
 *
 * `direction` is null when the words genuinely do not say -- "notify me at
 * 300" -- and the caller settles it against the current price.
 */
export function parseAlert(
  utterance: string
): { direction: PriceAlert['direction'] | null; price: number } | null {
  const text = utterance.toLowerCase()

  // Strictly ASCII. A currency-symbol character class here once matched
  // nothing at all while still printing correctly in an editor.
  const DOWN = '(?:below|under|beneath|less than|down to|drops? to|falls? to|dips? to|sinks? to)'
  const UP = '(?:above|over|beyond|more than|past|up to|rises? to|climbs? to|jumps? to)'
  const NEUTRAL = '(?:hits?|reaches|gets to|touches|at)'
  const NUMBER = '([0-9][0-9,]*(?:\.[0-9]+)?)'
  // Up to a dozen non-digits between the word and the number covers "to $",
  // "around", and stray punctuation.
  const GAP = '[^0-9]{0,12}'

  const down = text.match(new RegExp(DOWN + GAP + NUMBER))
  if (down) {
    const price = toPrice(down[1])
    if (price !== null) return { direction: 'below', price }
  }

  const up = text.match(new RegExp(UP + GAP + NUMBER))
  if (up) {
    const price = toPrice(up[1])
    if (price !== null) return { direction: 'above', price }
  }

  const neutral = text.match(new RegExp(NEUTRAL + GAP + NUMBER))
  if (neutral) {
    const price = toPrice(neutral[1])
    if (price !== null) return { direction: directionFromWords(text), price }
  }

  // Last resort: a bare number somewhere in the sentence. Skips anything that
  // looks like a year or a share count by requiring a currency symbol or a
  // decimal, unless the sentence is clearly about a level.
  const bare = text.match(new RegExp('[$]\s?' + NUMBER))
  if (bare) {
    const price = toPrice(bare[1])
    if (price !== null) return { direction: directionFromWords(text), price }
  }

  return null
}

/** Digits only, with thousands separators and a trailing stop removed. */
function toPrice(raw: string): number | null {
  const price = Number(raw.replace(/,/g, '').replace(/\.$/, ''))
  return Number.isFinite(price) && price > 0 ? price : null
}

/** Which way the sentence is pointing, when the comparison word didn't say. */
function directionFromWords(text: string): PriceAlert['direction'] | null {
  if (/(down|drops?|falls?|dips?|sinks?|lower|cheaper|below|under)/.test(text)) return 'below'
  if (/(up|rises?|climbs?|jumps?|higher|above|over)/.test(text)) return 'above'
  return null
}

export interface AlertConfirmation {
  alert: PriceAlert
  speech: string
}

export async function addPriceAlert(
  symbol: string,
  direction: PriceAlert['direction'],
  price: number
): Promise<AlertConfirmation> {
  const store = load()
  if (store.alerts.length >= MAX_ALERTS) {
    throw new Error("I'm already watching as many prices as I can keep track of.")
  }

  const quote = await getStockQuote(symbol, '1d')

  const alert: PriceAlert = {
    id: id(),
    symbol: quote.symbol,
    direction,
    price,
    createdAt: new Date().toISOString()
  }
  store.alerts.push(alert)
  save()

  // Saying where it is now is what makes the alert trustworthy — "below 300"
  // means something different when it's at 305 than at 250.
  const away = Math.abs(((quote.price - price) / price) * 100)
  const already =
    (direction === 'below' && quote.price < price) ||
    (direction === 'above' && quote.price > price)

  return {
    alert,
    speech: already
      ? `${quote.symbol} is already ${direction} ${price} at ${quote.price.toFixed(2)}. I'll tell you if it crosses back.`
      : `Watching ${quote.symbol}. It's ${quote.price.toFixed(2)} now, ${away.toFixed(1)}% ${direction === 'below' ? 'above' : 'below'} your ${price}. I'll tell you when it gets there.`
  }
}

export interface PriceUpdate {
  alert: PriceAlert
  speech: string
}

/**
 * Checks every alert and returns the ones that just crossed.
 *
 * A crossed alert is removed rather than kept: the user asked to be told when
 * it happened, and it happened.
 */
export async function checkPriceAlerts(): Promise<PriceUpdate[]> {
  const store = load()
  if (store.alerts.length === 0) return []

  const updates: PriceUpdate[] = []
  const keep: PriceAlert[] = []

  // One request per distinct symbol, not per alert — two alerts on Tesla are
  // one lookup.
  const symbols = [...new Set(store.alerts.map((alert) => alert.symbol))]
  const prices = new Map<string, number>()

  for (const symbol of symbols) {
    try {
      const quote = await getStockQuote(symbol, '1d')
      prices.set(symbol, quote.price)
    } catch (err) {
      console.warn(`[watchlist] could not price ${symbol}:`, err)
    }
  }

  for (const alert of store.alerts) {
    const price = prices.get(alert.symbol)
    // An unpriced symbol keeps its alert: a failed lookup is not a crossing.
    if (price === undefined) {
      keep.push(alert)
      continue
    }

    const crossed =
      alert.direction === 'below' ? price <= alert.price : price >= alert.price

    if (crossed) {
      updates.push({
        alert,
        speech: `${alert.symbol} is ${alert.direction} ${alert.price} — it's at ${price.toFixed(2)}.`
      })
      continue
    }

    keep.push(alert)
  }

  store.alerts = keep
  save()
  return updates
}

/** The whole watchlist, priced, for "show me my stocks". */
export async function pricedWatchlist(): Promise<StockCardData[]> {
  const symbols = watchedSymbols()
  const quotes = await Promise.all(
    symbols.map((symbol) =>
      // One bad ticker must not empty the whole list.
      getStockQuote(symbol, '1d').catch(() => null)
    )
  )
  return quotes.filter((quote): quote is StockCardData => quote !== null)
}
