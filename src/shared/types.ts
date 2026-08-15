export type NimbusIntent =
  | 'weather'
  | 'stocks'
  | 'crypto'
  | 'news'
  | 'github'
  | 'search'
  | 'music'
  | 'chat'

export interface IntentClassification {
  intent: NimbusIntent
  params: Record<string, string>
}

export interface WeatherCardData {
  city: string
  temp: number
  feelsLike: number
  condition: string
  icon: string
  humidity: number
  windSpeed: number
}

export interface StockCardData {
  symbol: string
  price: number
  change: number
  changePercent: number
  high: number
  low: number
  /** Recent closing prices, oldest first — drives the sparkline. */
  history: number[]
}

export interface CryptoCardData {
  name: string
  symbol: string
  price: number
  change24h: number
  marketCap: number
  /** Recent prices, oldest first — drives the sparkline. */
  history: number[]
}

export interface EntityCardData {
  title: string
  description: string | null
  extract: string
  /** base64 data URI — the overlay's CSP blocks remote image URLs. */
  image: string | null
  url: string
}

export interface NewsArticle {
  title: string
  source: string
  url: string
  publishedAt: string
  /** base64 data URI thumbnail, or null when the article has no usable image. */
  image: string | null
}

export interface NewsCardData {
  query: string
  articles: NewsArticle[]
  /**
   * Topic-level illustrations, used when the provider gives images for the
   * search rather than per article. Deliberately separate from
   * `NewsArticle.image` so an unrelated picture is never shown as if it
   * belonged to a specific headline. Rendered as a cross-fading carousel.
   */
  heroImages: string[]
}

export interface GithubRepo {
  name: string
  fullName: string
  description: string
  stars: number
  url: string
  language: string | null
}

export interface GithubCardData {
  language: string | null
  repos: GithubRepo[]
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchCardData {
  query: string
  answer: string | null
  results: SearchResult[]
}

export interface MusicCardData {
  title: string
  channel: string
  duration: string
  thumbnail: string | null
  url: string
  query: string
}

export interface RadioCardData {
  name: string
  /** Direct audio stream, played in-app by an <audio> element. */
  streamUrl: string
  codec: string
  bitrate: number
  tags: string[]
  country: string
  query: string
}

export type TextActionKind =
  | 'translate'
  | 'summarize'
  | 'explain'
  | 'rewrite'
  | 'grammar'
  | 'custom'

export interface SelectionCardData {
  /** The text that was selected, for reference while reading the result. */
  source: string
  action: TextActionKind
  /** Human-readable label of what was done, e.g. "Fixed grammar". */
  actionLabel: string
  result: string
  /** False when the source window can no longer be targeted for paste-back. */
  canReplace: boolean
}

export interface ScreenCardData {
  /** Data URI of what was captured, shown so it's clear what Nimbus saw. */
  thumbnail: string
}

export type ResponseCardData =
  | { type: 'weather'; data: WeatherCardData }
  | { type: 'stock'; data: StockCardData }
  | { type: 'crypto'; data: CryptoCardData }
  | { type: 'news'; data: NewsCardData }
  | { type: 'github'; data: GithubCardData }
  | { type: 'search'; data: SearchCardData }
  | { type: 'entity'; data: EntityCardData }
  | { type: 'music'; data: MusicCardData }
  | { type: 'radio'; data: RadioCardData }
  | { type: 'screen'; data: ScreenCardData }
  | { type: 'selection'; data: SelectionCardData }
  | { type: 'text' }

export interface SynthesizedSpeech {
  audio: ArrayBuffer
  mimeType: string
}

export interface NimbusResponse {
  speech: string
  card: ResponseCardData
}

export type NimbusState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'playing'

export interface NimbusConfig {
  integrations: {
    weather: boolean
    stocks: boolean
    crypto: boolean
    news: boolean
    github: boolean
    search: boolean
    music: boolean
  }
  hotkey: {
    enabled: boolean
    accelerator: string
    /** Captures the screen, then listens for a question about it. */
    captureAccelerator: string
    /** Grabs the highlighted text in the focused app and offers actions on it. */
    selectionAccelerator: string
  }
  overlay: {
    autoFadeMs: number
  }
  voice: {
    /** Quiet time before a turn is considered finished. Lower = snappier,
     *  but tolerates shorter mid-sentence pauses. */
    endOfSpeechMs: number
  }
  textActions: {
    /** Target language for the Translate button. Speaking an instruction
     *  ("translate to Arabic") overrides it per-use. */
    translateTo: string
  }
}
