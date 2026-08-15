import { motion } from 'framer-motion'
import type { RefObject } from 'react'
import type { RadioPlayerControls } from '../hooks/useRadioPlayer'
import { ImageCarousel } from './ImageCarousel'
import { Sparkline } from './Sparkline'
import { SpokenText } from './SpokenText'
import type {
  CryptoCardData,
  EntityCardData,
  GithubCardData,
  MusicCardData,
  NewsCardData,
  NimbusResponse,
  RadioCardData,
  ResponseCardData,
  ScreenCardData,
  SearchCardData,
  SelectionCardData,
  StockCardData,
  WeatherCardData
} from '@shared/types'

interface ResponseCardProps {
  response: NimbusResponse
  speechProgressRef: RefObject<number>
  radio: RadioPlayerControls
  onReplace: (text: string) => void
}

const panel =
  'mt-2.5 rounded-xl border border-white/[0.06] bg-nimbus-bg-raised px-3 py-2.5 backdrop-blur-sm'

/** Media entrance: images fade and lift in once decoded, rather than popping. */
const mediaIn = {
  initial: { opacity: 0, scale: 0.94 },
  animate: { opacity: 1, scale: 1 },
  transition: { duration: 0.34, ease: [0.22, 1, 0.36, 1] as const }
}

/** Generic response card; body varies by `card.type`. */
export function ResponseCard({ response, speechProgressRef, radio, onReplace }: ResponseCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <SpokenText text={response.speech} progressRef={speechProgressRef} />
      <CardBody card={response.card} radio={radio} onReplace={onReplace} />
    </motion.div>
  )
}

function CardBody({
  card,
  radio,
  onReplace
}: {
  card: ResponseCardData
  radio: RadioPlayerControls
  onReplace: (text: string) => void
}) {
  switch (card.type) {
    case 'weather':
      return <WeatherBody data={card.data} />
    case 'stock':
      return <StockBody data={card.data} />
    case 'crypto':
      return <CryptoBody data={card.data} />
    case 'news':
      return <NewsBody data={card.data} />
    case 'github':
      return <GithubBody data={card.data} />
    case 'search':
      return <SearchBody data={card.data} />
    case 'entity':
      return <EntityBody data={card.data} />
    case 'music':
      return <MusicBody data={card.data} />
    case 'radio':
      return <RadioBody data={card.data} radio={radio} />
    case 'screen':
      return <ScreenBody data={card.data} />
    case 'selection':
      return <SelectionBody data={card.data} onReplace={onReplace} />
    default:
      return null
  }
}

function Delta({ value, suffix = '' }: { value: number; suffix?: string }) {
  const positive = value >= 0
  return (
    <span
      className={`text-[11px] font-medium tabular-nums ${
        positive ? 'text-nimbus-positive' : 'text-nimbus-negative'
      }`}
    >
      {positive ? '▲' : '▼'} {Math.abs(value).toFixed(2)}
      {suffix}
    </span>
  )
}

function WeatherBody({ data }: { data: WeatherCardData }) {
  return (
    <div className={`${panel} flex items-center justify-between`}>
      <div>
        <div className="text-2xl font-semibold tabular-nums text-nimbus-text">{data.temp}°</div>
        <div className="mt-0.5 text-[11px] capitalize text-nimbus-text-dim">
          {data.condition} · {data.city}
        </div>
      </div>
      <div className="space-y-0.5 text-right text-[11px] text-nimbus-text-dim">
        <div>Feels {data.feelsLike}°</div>
        <div>{data.humidity}% humidity</div>
        <div>{Math.round(data.windSpeed)} m/s wind</div>
      </div>
    </div>
  )
}

function StockBody({ data }: { data: StockCardData }) {
  const positive = data.changePercent >= 0
  return (
    <div className={`${panel} flex items-center gap-3`}>
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-wide text-nimbus-text">{data.symbol}</div>
        <div className="mt-0.5 text-[11px] tabular-nums text-nimbus-text-dim">
          H {data.high.toFixed(2)} · L {data.low.toFixed(2)}
        </div>
      </div>
      <div className="ml-auto shrink-0">
        <Sparkline values={data.history} positive={positive} />
      </div>
      <div className="shrink-0 text-right">
        <div className="text-lg font-semibold tabular-nums text-nimbus-text">
          ${data.price.toFixed(2)}
        </div>
        <Delta value={data.changePercent} suffix="%" />
      </div>
    </div>
  )
}

function CryptoBody({ data }: { data: CryptoCardData }) {
  const positive = data.change24h >= 0
  return (
    <div className={`${panel} flex items-center gap-3`}>
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-wide text-nimbus-text">{data.symbol}</div>
        <div className="mt-0.5 truncate text-[11px] text-nimbus-text-dim">{data.name}</div>
      </div>
      <div className="ml-auto shrink-0">
        <Sparkline values={data.history} positive={positive} />
      </div>
      <div className="shrink-0 text-right">
        <div className="text-lg font-semibold tabular-nums text-nimbus-text">
          ${data.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
        <Delta value={data.change24h} suffix="% 24h" />
      </div>
    </div>
  )
}

function MusicBody({ data }: { data: MusicCardData }) {
  return (
    <button
      onClick={() => openLink(data.url)}
      title={data.url}
      className={`${panel} group flex w-full items-center gap-3 text-left transition-colors hover:bg-white/[0.08]`}
    >
      <div className="relative shrink-0">
        {data.thumbnail ? (
          <motion.img
            {...mediaIn}
            src={data.thumbnail}
            alt=""
            className="h-[68px] w-[120px] rounded-lg object-cover shadow-lg ring-1 ring-white/15"
          />
        ) : (
          <div className="h-[68px] w-[120px] rounded-lg bg-white/[0.05] ring-1 ring-white/10" />
        )}
        {/* Play affordance — the card is the control. */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm transition-transform group-hover:scale-110">
            <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4 fill-white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </div>
        {data.duration && (
          <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-px text-[9px] font-medium tabular-nums text-white">
            {data.duration}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[12.5px] font-medium leading-snug text-nimbus-text group-hover:text-nimbus-accent-bright">
          {data.title}
        </div>
        <div className="mt-1 truncate text-[11px] text-nimbus-text-dim">{data.channel}</div>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-nimbus-accent">
          Opened in your browser
        </div>
      </div>
    </button>
  )
}

function SelectionBody({
  data,
  onReplace
}: {
  data: SelectionCardData
  onReplace: (text: string) => void
}) {
  return (
    <div className={panel}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-nimbus-accent">
        {data.actionLabel}
      </div>
      <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-nimbus-text">
        {data.result}
      </p>

      <div className="mt-2.5 flex gap-1.5 border-t border-white/[0.06] pt-2.5">
        {data.canReplace && (
          <button
            onClick={() => onReplace(data.result)}
            className="rounded-lg bg-nimbus-accent/20 px-2.5 py-1 text-[11px] font-medium text-nimbus-accent-bright transition-colors hover:bg-nimbus-accent/30"
          >
            Replace selection
          </button>
        )}
        <button
          onClick={() => navigator.clipboard.writeText(data.result)}
          className="rounded-lg border border-nimbus-border px-2.5 py-1 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
        >
          Copy
        </button>
      </div>
    </div>
  )
}

/** Shows the exact frame the answer was based on. */
function ScreenBody({ data }: { data: ScreenCardData }) {
  return (
    <motion.div {...mediaIn} className="mt-2.5">
      <img
        src={data.thumbnail}
        alt="Captured screen"
        className="w-full rounded-lg object-cover shadow-lg ring-1 ring-white/15"
      />
      <div className="mt-1.5 text-[10px] uppercase tracking-[0.14em] text-nimbus-text-dim">
        Answered from this screenshot
      </div>
    </motion.div>
  )
}

function RadioBody({ data, radio }: { data: RadioCardData; radio: RadioPlayerControls }) {
  const meta = [data.tags.join(' · '), data.bitrate ? `${data.bitrate}kbps` : '', data.country]
    .filter(Boolean)
    .join('  ·  ')

  return (
    <div className={`${panel} flex items-center gap-3.5`}>
      <button
        onClick={radio.toggle}
        aria-label={radio.isPlaying ? 'Pause' : 'Play'}
        className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105"
        style={{
          background: 'linear-gradient(145deg, #ffb067, #ff6a1f)',
          boxShadow: '0 0 20px rgba(255,138,61,0.5)'
        }}
      >
        {radio.isLoading ? (
          <motion.span
            animate={{ rotate: 360 }}
            transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
            className="h-5 w-5 rounded-full border-2 border-black/25 border-t-black/70"
          />
        ) : radio.isPlaying ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-black/80">
            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5 fill-black/80">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-nimbus-text">{data.name}</div>
        {meta && <div className="mt-0.5 truncate text-[10.5px] text-nimbus-text-dim">{meta}</div>}

        <div className="mt-1.5 flex items-center gap-1.5">
          {radio.error ? (
            <span className="text-[10px] text-nimbus-negative">{radio.error}</span>
          ) : radio.isPlaying ? (
            <>
              {/* Animated bars double as a "live" indicator. */}
              <span className="flex h-3 items-end gap-[2px]">
                {[0, 1, 2, 3].map((i) => (
                  <motion.span
                    key={i}
                    className="w-[2px] rounded-full bg-nimbus-accent"
                    animate={{ height: [3, 11, 3] }}
                    transition={{
                      duration: 0.7,
                      repeat: Infinity,
                      delay: i * 0.13,
                      ease: 'easeInOut'
                    }}
                  />
                ))}
              </span>
              <span className="text-[10px] uppercase tracking-[0.14em] text-nimbus-accent">
                Live · playing in Nimbus
              </span>
            </>
          ) : (
            <span className="text-[10px] uppercase tracking-[0.14em] text-nimbus-text-dim">
              {radio.isLoading ? 'Connecting…' : 'Paused'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function EntityBody({ data }: { data: EntityCardData }) {
  return (
    <div className={`${panel} flex gap-3.5`}>
      {data.image && (
        <motion.img
          {...mediaIn}
          src={data.image}
          alt={data.title}
          className="h-[104px] w-[88px] shrink-0 rounded-lg object-cover shadow-lg ring-1 ring-white/15"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold leading-tight text-nimbus-text">{data.title}</div>
        {data.description && (
          <div className="mt-1 text-[11px] capitalize text-nimbus-accent-bright">
            {data.description}
          </div>
        )}
        <p className="mt-1.5 line-clamp-4 text-[11.5px] leading-relaxed text-nimbus-text-dim">
          {data.extract}
        </p>
      </div>
    </div>
  )
}

/** Opens a result in the default browser (validated http(s)-only in main). */
function openLink(url: string): void {
  window.nimbus.openExternal(url)
}

function ListRow({
  primary,
  secondary,
  url
}: {
  primary: string
  secondary: string
  url?: string
}) {
  const content = (
    <>
      <span className="truncate text-[12px] text-nimbus-text group-hover:text-nimbus-accent-bright">
        {primary}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-nimbus-text-dim">
        {secondary}
      </span>
    </>
  )

  if (!url) {
    return <li className="flex items-baseline justify-between gap-3">{content}</li>
  }

  return (
    <li>
      <button
        onClick={() => openLink(url)}
        title={url}
        className="group flex w-full items-baseline justify-between gap-3 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-white/[0.06]"
      >
        {content}
      </button>
    </li>
  )
}

function relativeTime(iso: string): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const hours = Math.round((Date.now() - then) / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function NewsBody({ data }: { data: NewsCardData }) {
  const articles = data.articles.slice(0, 3)
  const hasPerArticleImages = articles.some((a) => a.image)

  return (
    <div className={panel}>
      {/* Shown only when the provider gave images for the topic rather than
          per article — never captioned as belonging to a headline. */}
      {!hasPerArticleImages && data.heroImages.length > 0 && (
        <motion.div {...mediaIn} className="mb-3">
          <ImageCarousel
            images={data.heroImages}
            className="h-40 w-full rounded-lg shadow-lg ring-1 ring-white/15"
          />
        </motion.div>
      )}

      <ul className="space-y-3">
        {articles.map((article) => {
          const when = relativeTime(article.publishedAt)
          return (
            <li key={article.url}>
              <button
                onClick={() => openLink(article.url)}
                title={article.url}
                className="group flex w-full items-center gap-3 rounded-lg p-1 text-left transition-colors hover:bg-white/[0.06]"
              >
              {hasPerArticleImages &&
                (article.image ? (
                  <motion.img
                    {...mediaIn}
                    src={article.image}
                    alt=""
                    className="h-14 w-20 shrink-0 rounded-lg object-cover shadow-md ring-1 ring-white/15"
                  />
                ) : (
                  <div className="h-14 w-20 shrink-0 rounded-lg bg-white/[0.05] ring-1 ring-white/10" />
                ))}
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-[12.5px] leading-snug text-nimbus-text group-hover:text-nimbus-accent-bright">
                    {article.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-nimbus-text-dim">
                    <span className="truncate">{article.source}</span>
                    {when && (
                      <>
                        <span className="opacity-50">·</span>
                        <span className="shrink-0 normal-case">{when}</span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
        {articles.length === 0 && (
          <li className="text-[11px] text-nimbus-text-dim">No articles found.</li>
        )}
      </ul>
    </div>
  )
}

function GithubBody({ data }: { data: GithubCardData }) {
  return (
    <ul className={`${panel} space-y-2`}>
      {data.repos.slice(0, 3).map((repo) => (
        <ListRow
          key={repo.url}
          primary={repo.fullName}
          secondary={`★ ${repo.stars.toLocaleString()}`}
          url={repo.url}
        />
      ))}
      {data.repos.length === 0 && (
        <li className="text-[11px] text-nimbus-text-dim">No trending repos found.</li>
      )}
    </ul>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

function SearchBody({ data }: { data: SearchCardData }) {
  return (
    <ul className={`${panel} space-y-2`}>
      {data.results.slice(0, 3).map((result) => (
        <ListRow
          key={result.url}
          primary={result.title}
          secondary={hostOf(result.url)}
          url={result.url}
        />
      ))}
      {data.results.length === 0 && (
        <li className="text-[11px] text-nimbus-text-dim">No results found.</li>
      )}
    </ul>
  )
}
