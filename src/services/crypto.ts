import type { CryptoCardData } from '../shared/types'

const SEARCH_URL = 'https://api.coingecko.com/api/v3/search'
const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price'
const CHART_URL = 'https://api.coingecko.com/api/v3/coins'

/** 7 days of prices for the sparkline; failure just means no chart. */
async function fetchHistory(coinId: string): Promise<number[]> {
  try {
    const res = await fetch(
      `${CHART_URL}/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=7&interval=daily`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return []
    const json = (await res.json()) as { prices?: Array<[number, number]> }
    return (json.prices ?? []).map(([, price]) => price)
  } catch {
    return []
  }
}

interface CoinGeckoSearchResponse {
  coins: Array<{ id: string; name: string; symbol: string }>
}

type CoinGeckoPriceResponse = Record<
  string,
  { usd: number; usd_24h_change: number; usd_market_cap: number }
>

/**
 * CoinGecko's public API — free, no signup or key required (rate-limited
 * per IP, ~10-30 req/min). `query` can be a name ("bitcoin") or symbol
 * ("btc"); it's resolved to a CoinGecko coin id via /search first since
 * /simple/price only accepts ids.
 */
export async function getCryptoPrice(query: string): Promise<CryptoCardData> {
  const searchRes = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(query)}`)
  if (!searchRes.ok) {
    throw new Error(`CoinGecko search failed (${searchRes.status}).`)
  }
  const searchJson = (await searchRes.json()) as CoinGeckoSearchResponse
  const coin = searchJson.coins[0]
  if (!coin) {
    throw new Error(`I couldn't find a cryptocurrency called "${query}".`)
  }

  const priceRes = await fetch(
    `${PRICE_URL}?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
  )
  if (!priceRes.ok) {
    throw new Error(`CoinGecko price lookup failed (${priceRes.status}).`)
  }
  const priceJson = (await priceRes.json()) as CoinGeckoPriceResponse
  const price = priceJson[coin.id]
  if (!price) {
    throw new Error(`I couldn't find a current price for "${coin.name}".`)
  }

  return {
    name: coin.name,
    symbol: coin.symbol.toUpperCase(),
    price: price.usd,
    change24h: price.usd_24h_change,
    marketCap: price.usd_market_cap,
    history: await fetchHistory(coin.id)
  }
}
