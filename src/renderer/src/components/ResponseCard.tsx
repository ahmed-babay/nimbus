import { motion } from 'framer-motion'
import { useState, type RefObject } from 'react'
import type { RadioPlayerControls } from '../hooks/useRadioPlayer'
import { ImageCarousel } from './ImageCarousel'
import { Sparkline } from './Sparkline'
import { PriceChart } from './PriceChart'
import { WeatherGlyph } from './WeatherGlyph'
import { CountUp, Countdown, FillBar, Stagger, StaggerItem, EASE } from './Motion'
import { SpokenText } from './SpokenText'
import type {
  BriefingCardData,
  CalendarEvent,
  CryptoCardData,
  DirectionsCardData,
  EntityCardData,
  EventCardData,
  ExplainerCardData,
  GithubCardData,
  Illustration,
  MemoryCardData,
  MusicCardData,
  NewsCardData,
  NimbusResponse,
  PaperworkCardData,
  RadioCardData,
  OutdoorCardData,
  OutdoorFactor,
  ReminderCardData,
  RenderedMap,
  ResponseCardData,
  ScreenCardData,
  SearchCardData,
  SelectionCardData,
  StockCardData,
  TransitCardData,
  TravelMode,
  CurrencyCardData,
  WatchlistCardData,
  WeatherCardData
} from '@shared/types'

interface ResponseCardProps {
  response: NimbusResponse
  speechProgressRef: RefObject<number>
  radio: RadioPlayerControls
  onReplace: (text: string) => void
  /** Sends a follow-up through the normal pipeline, for card buttons. */
  onAsk: (text: string) => void
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
export function ResponseCard({
  response,
  speechProgressRef,
  radio,
  onReplace,
  onAsk
}: ResponseCardProps) {
  // When the answer was too long to speak in full, show the whole thing —
  // and skip the spoken-word reveal, which only tracks the spoken portion.
  const displayText = response.fullText ?? response.speech
  const wasShortened = Boolean(response.fullText)
  // Plain answers are the ones worth copying (drafted emails, messages,
  // snippets); the structured cards carry their own actions.
  const showCopy = response.card.type === 'text' || wasShortened

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Long answers still get the reveal for the part that's read aloud;
          the tail past the TTS cap stays fully visible. */}
      <SpokenText
        text={displayText}
        progressRef={speechProgressRef}
        spokenRatio={wasShortened ? response.speech.length / displayText.length : 1}
        className="whitespace-pre-wrap text-[13px] leading-relaxed text-nimbus-text"
      />

      <CardBody card={response.card} radio={radio} onReplace={onReplace} onAsk={onAsk} />

      {showCopy && <CopyButton text={displayText} />}
    </motion.div>
  )
}

/** Copies an answer, with a brief confirmation so the click registers. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      onClick={() => {
        window.nimbus.copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
      className="mt-2.5 rounded-lg border border-nimbus-border px-2.5 py-1 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  )
}

function CardBody({
  card,
  radio,
  onReplace,
  onAsk
}: {
  card: ResponseCardData
  radio: RadioPlayerControls
  onReplace: (text: string) => void
  onAsk: (text: string) => void
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
    case 'transit':
      return <TransitBody data={card.data} />
    case 'outdoors':
      return <OutdoorsBody data={card.data} />
    case 'watchlist':
      return <WatchlistBody data={card.data} />
    case 'currency':
      return <CurrencyBody data={card.data} />
    case 'directions':
      return <DirectionsBody data={card.data} />
    case 'memory':
      return <MemoryBody data={card.data} />
    case 'reminder':
      return <ReminderBody data={card.data} />
    case 'briefing':
      return <BriefingBody data={card.data} />
    case 'event':
      return <EventBody data={card.data} />
    case 'explainer':
      return <ExplainerBody data={card.data} />
    case 'paperwork':
      return <PaperworkBody data={card.data} onAsk={onAsk} />
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
      className={`flex shrink-0 items-baseline gap-0.5 text-[11px] font-medium tabular-nums ${
        positive ? 'text-nimbus-positive' : 'text-nimbus-negative'
      }`}
    >
      {/* The arrow nudges the way the price moved — a half-second cue that
          lands before the number is read. */}
      <motion.span
        key={positive ? 'up' : 'down'}
        initial={{ y: positive ? 4 : -4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        {positive ? '▲' : '▼'}
      </motion.span>
      <CountUp value={Math.abs(value)} decimals={2} suffix={suffix} />
    </span>
  )
}

function WeatherBody({ data }: { data: WeatherCardData }) {
  return (
    <div className={`${panel} flex items-center justify-between`}>
      <div className="flex items-center gap-2.5">
        {/* Drawn and animated rather than an emoji: the overlay's CSP blocks
            remote images, and rain that falls is read faster than the word. */}
        <WeatherGlyph icon={data.icon} size={52} />
        <div>
          <div className="text-2xl font-semibold tabular-nums text-nimbus-text">
            <CountUp value={data.temp} suffix="°" />
          </div>
          <div className="mt-0.5 text-[11px] capitalize text-nimbus-text-dim">
            {data.condition} · {data.city}
          </div>
        </div>
      </div>
      <Stagger className="space-y-0.5 text-right text-[11px] text-nimbus-text-dim">
        <StaggerItem>Feels {data.feelsLike}°</StaggerItem>
        <StaggerItem>{data.humidity}% humidity</StaggerItem>
        <StaggerItem>{Math.round(data.windSpeed)} m/s wind</StaggerItem>
      </Stagger>
    </div>
  )
}

function StockBody({ data }: { data: StockCardData }) {
  return (
    <div className={panel}>
      <PriceChart initial={data} />
    </div>
  )
}

/** "How are my stocks doing" — one row each, chart included. */
function WatchlistBody({ data }: { data: WatchlistCardData }) {
  if (data.stocks.length === 0) {
    return (
      <div className={panel}>
        <div className="text-[11px] text-nimbus-text-dim">
          No stocks followed yet. Say &ldquo;add Tesla to my stocks&rdquo;.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {data.stocks.map((stock) => (
        <div key={stock.symbol} className={panel}>
          {/* Compact: a list of eight full-height charts is a wall. */}
          <PriceChart initial={stock} compact />
        </div>
      ))}
    </div>
  )
}

function CryptoBody({ data }: { data: CryptoCardData }) {
  const positive = data.change24h >= 0
  return (
    <div className={panel}>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold tracking-wide text-nimbus-text">{data.symbol}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-nimbus-text-dim">
          {data.name}
        </span>
        <span className="shrink-0 text-lg font-semibold tabular-nums text-nimbus-text">
          <CountUp value={data.price} decimals={data.price < 10 ? 4 : 2} prefix="$" />
        </span>
        <Delta value={data.change24h} suffix="% 24h" />
      </div>
      {/* Full-width curve rather than a thumbnail sparkline: the shape of the
          last week is the reason anyone asked. */}
      <div className="mt-1.5">
        <Sparkline values={data.history} positive={positive} width={300} height={56} animate />
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
      <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-nimbus-text">
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
          onClick={() => window.nimbus.copyText(data.result)}
          className="rounded-lg border border-nimbus-border px-2.5 py-1 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
        >
          Copy
        </button>
      </div>
    </div>
  )
}

/** Shows the exact frame the answer was based on. */
/**
 * An official letter, reduced to what you have to act on. The deadline is a
 * button rather than a line of text: a due date you have to re-enter by hand
 * is a due date you forget.
 */
function PaperworkBody({ data, onAsk }: { data: PaperworkCardData; onAsk: (text: string) => void }) {
  const facts: Array<[string, string]> = [
    ['From', data.sender],
    ['Amount', data.amount],
    ['Reference', data.reference]
  ]

  return (
    <div className={panel}>
      <div className="flex items-start gap-2.5">
        <motion.img
          {...mediaIn}
          src={data.thumbnail}
          alt="The document that was read"
          className="h-[62px] w-[46px] shrink-0 rounded object-cover object-top ring-1 ring-white/15"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] font-medium text-nimbus-accent-bright">
            {data.documentType}
          </div>
          {data.actionRequired && (
            <div className="mt-0.5 text-[12px] leading-snug text-nimbus-text">
              {data.actionRequired}
            </div>
          )}
          {data.deadlineLabel && (
            <div className="mt-1 inline-block rounded bg-nimbus-yellow/15 px-1.5 py-0.5 text-[10px] text-nimbus-yellow">
              {data.deadlineLabel}
            </div>
          )}
        </div>
      </div>

      {facts.some(([, value]) => value) && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-[10px] text-nimbus-text-dim">{label}</dt>
                <dd className="min-w-0 truncate text-[10.5px] text-nimbus-text">{value}</dd>
              </div>
            ))}
        </dl>
      )}

      {data.keyPoints.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-white/[0.07] pt-2">
          {data.keyPoints.map((point) => (
            <li key={point} className="flex gap-1.5 text-[10.5px] leading-snug text-nimbus-text-dim">
              <span className="shrink-0 text-nimbus-cyan">•</span>
              <span className="min-w-0 flex-1">{point}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5 border-t border-white/[0.07] pt-2">
        {data.deadline && (
          <button
            onClick={() =>
              onAsk(
                `remind me on ${data.deadline} about ${data.documentType}${data.sender ? ` from ${data.sender}` : ''}`
              )
            }
            className="rounded-lg border border-nimbus-yellow/40 px-2 py-1 text-[10px] text-nimbus-yellow transition-colors hover:bg-nimbus-yellow/15"
          >
            Remind me
          </button>
        )}
        <button
          onClick={() => onAsk(`draft a reply to this ${data.documentType.toLowerCase()}`)}
          className="rounded-lg border border-nimbus-border px-2 py-1 text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
        >
          Draft a reply
        </button>
        <button
          onClick={() => onAsk('explain this document to me in more detail')}
          className="rounded-lg border border-nimbus-border px-2 py-1 text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
        >
          More detail
        </button>
      </div>
    </div>
  )
}

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
          background: 'linear-gradient(145deg, var(--color-nimbus-accent-bright), var(--color-nimbus-violet-deep))',
          boxShadow: '0 0 20px rgba(79,214,255,0.5)'
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
  const most = Math.max(1, ...data.repos.slice(0, 3).map((repo) => repo.stars))
  return (
    <ul className={`${panel} space-y-2`}>
      {data.repos.slice(0, 3).map((repo, index) => (
        <motion.li
          key={repo.url}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: EASE, delay: index * 0.06 }}
        >
          <button
            onClick={() => openLink(repo.url)}
            title={repo.url}
            className="w-full text-left"
          >
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-nimbus-text">
                {repo.fullName}
              </span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-nimbus-yellow">
                ★ <CountUp value={repo.stars} />
              </span>
            </div>
            {/* Relative to the most-starred in the list, so the gap between
                first and third is visible rather than arithmetic. */}
            <div className="mt-1">
              <FillBar
                fraction={repo.stars / most}
                className="bg-nimbus-yellow/70"
                delay={index * 0.06}
              />
            </div>
          </button>
        </motion.li>
      ))}
      {data.repos.length === 0 && (
        <li className="text-[11px] text-nimbus-text-dim">No trending repos found.</li>
      )}
    </ul>
  )
}

/**
 * Colour-codes the line badge the way the operators do, so an S-Bahn reads as
 * an S-Bahn at a glance rather than as one more grey pill.
 */
function lineTone(line: string): string {
  const code = line.trim().toUpperCase()
  if (/^S\d/.test(code)) return 'bg-nimbus-green/20 text-nimbus-green ring-nimbus-green/40'
  if (/^(U|TRAM|STR)/.test(code)) return 'bg-nimbus-cyan/20 text-nimbus-cyan ring-nimbus-cyan/40'
  if (/^(ICE|IC|EC)/.test(code)) return 'bg-nimbus-accent/25 text-nimbus-accent-bright ring-nimbus-accent/45'
  if (/^(RB|RE)/.test(code)) return 'bg-nimbus-yellow/20 text-nimbus-yellow ring-nimbus-yellow/40'
  return 'bg-white/10 text-nimbus-text ring-white/20'
}

/** `bare` drops the panel chrome when this is nested inside another card. */
function TransitBody({ data, bare = false }: { data: TransitCardData; bare?: boolean }) {
  return (
    <div className={bare ? '' : panel}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-nimbus-text-dim">
        <span className="truncate">{data.from}</span>
        <span className="shrink-0 text-nimbus-accent">→</span>
        <span className="truncate">{data.to}</span>
      </div>

      <ul className="mt-2 divide-y divide-white/[0.06]">
        {data.journeys.slice(0, 4).map((journey, index) => {
          const first = journey.legs[0]
          const platform = first?.platform
          return (
            <motion.li
              key={`${journey.departsAt}-${index}`}
              className="flex items-center gap-3 py-2 first:pt-0.5 last:pb-0.5"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, ease: EASE, delay: index * 0.07 }}
            >
              {/* Departure reads like a platform board: big, monospaced, lit. */}
              <div className="w-[52px] shrink-0">
                <div className="font-mono text-[15px] font-semibold leading-none tabular-nums text-nimbus-yellow">
                  {journey.departs}
                </div>
                {/* Ticks every second: a departure card is only as useful as
                    how fresh "in 6 min" is, and it was frozen at open. */}
                <Countdown
                  to={journey.departsAt}
                  className="mt-1 block text-[9.5px] text-nimbus-text-dim"
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1">
                  {journey.legs.map((leg, legIndex) => (
                    <span key={`${leg.line}-${legIndex}`} className="flex items-center gap-1">
                      {legIndex > 0 && <span className="text-[9px] text-nimbus-text-dim">›</span>}
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none ring-1 ${lineTone(leg.line)}`}
                      >
                        {leg.line}
                      </span>
                    </span>
                  ))}
                  {journey.legs.length === 0 && (
                    <span className="text-[10px] text-nimbus-text-dim">Walk</span>
                  )}
                </div>
                <div className="mt-1 truncate text-[10px] text-nimbus-text-dim">
                  {first?.direction || first?.to || ''}
                  {first?.number && <span className="opacity-60"> · #{first.number}</span>}
                  {platform && <span className="text-nimbus-cyan"> · Pl. {platform}</span>}
                </div>
              </div>

              <div className="shrink-0 text-right">
                <div className="font-mono text-[11px] tabular-nums text-nimbus-text">
                  {journey.arrives}
                </div>
                <div className="mt-1 text-[9.5px] text-nimbus-text-dim">
                  {journey.durationMinutes} min
                  {journey.changes > 0 && ` · ${journey.changes}×`}
                </div>
              </div>
            </motion.li>
          )
        })}
        {data.journeys.length === 0 && (
          <li className="text-[11px] text-nimbus-text-dim">No connections found.</li>
        )}
      </ul>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

const MODE_LABEL: Record<TravelMode, string> = {
  driving: 'Drive',
  cycling: 'Bike',
  walking: 'Walk',
  transit: 'Transit'
}

/** Simple glyphs rather than an icon dependency — these are 14px tall. */
function ModeIcon({ mode }: { mode: TravelMode }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (mode) {
    case 'driving':
      return (
        <svg {...common}>
          <path d="M5 17h14M4 17v-4l2-5h12l2 5v4" />
          <circle cx="7.5" cy="17.5" r="1.5" />
          <circle cx="16.5" cy="17.5" r="1.5" />
        </svg>
      )
    case 'cycling':
      return (
        <svg {...common}>
          <circle cx="6" cy="17" r="3.5" />
          <circle cx="18" cy="17" r="3.5" />
          <path d="M6 17l4-8h5l3 8M9 9h4" />
        </svg>
      )
    case 'walking':
      return (
        <svg {...common}>
          <circle cx="13" cy="4" r="1.6" />
          <path d="M11 21l2-6-3-3 1-5 3 3 2 1M10 12l-2 4" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <rect x="6" y="3" width="12" height="13" rx="2.5" />
          <path d="M6 10h12M9 20l-2 2M15 20l2 2" />
          <circle cx="9" cy="13" r="0.8" fill="currentColor" />
          <circle cx="15" cy="13" r="0.8" fill="currentColor" />
        </svg>
      )
  }
}

function duration(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/**
 * The map is a still: tiles were downloaded and projected in the main process,
 * so this only places them and draws the line. Tiles are shown in their own
 * colours — an earlier version inverted them to match the dark overlay, which
 * made the map unreadable.
 */
function RouteMap({ map, mode }: { map: RenderedMap; mode: TravelMode }) {
  const points = map.routes[mode]
  const path = points?.map(([x, y]) => `${x},${y}`).join(' ')

  return (
    <div
      className="relative overflow-hidden rounded-lg ring-1 ring-black/25"
      style={{ width: map.width, height: map.height }}
    >
      <div className="absolute inset-0">
        {map.tiles.map((tile) => (
          <img
            key={`${tile.x}-${tile.y}`}
            src={tile.image}
            alt=""
            draggable={false}
            className="absolute max-w-none"
            style={{ left: tile.x, top: tile.y, width: 256, height: 256 }}
          />
        ))}
      </div>

      <svg
        className="absolute inset-0"
        width={map.width}
        height={map.height}
        aria-label={`Route by ${MODE_LABEL[mode]}`}
      >
        {path && (
          <>
            {/* Dark casing under the line, so it reads over any terrain. */}
            <polyline
              points={path}
              fill="none"
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <motion.polyline
              key={mode}
              points={path}
              fill="none"
              stroke="var(--color-nimbus-accent)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0, opacity: 0.4 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            />
          </>
        )}
        {/* Public transport has no road geometry — the endpoints still do. */}
        <circle cx={map.start[0]} cy={map.start[1]} r={5} fill="var(--color-nimbus-cyan)" stroke="rgba(0,0,0,0.6)" strokeWidth={2} />
        <circle cx={map.end[0]} cy={map.end[1]} r={5} fill="var(--color-nimbus-yellow)" stroke="rgba(0,0,0,0.6)" strokeWidth={2} />
      </svg>
    </div>
  )
}

function DirectionsBody({ data }: { data: DirectionsCardData }) {
  const [mode, setMode] = useState<TravelMode>(data.selected)
  const active = data.options.find((option) => option.mode === mode)

  return (
    <div className={panel}>
      <RouteMap map={data.map} mode={mode} />

      {/* Every mode was costed up front, so switching is instant. */}
      <div className="mt-2 flex gap-1">
        {data.options.map((option) => {
          const selected = option.mode === mode
          return (
            <button
              key={option.mode}
              onClick={() => setMode(option.mode)}
              className={`flex flex-1 flex-col items-center gap-1 rounded-lg border px-1 py-1.5 transition-colors ${
                selected
                  ? 'border-nimbus-accent/60 bg-nimbus-accent/15 text-nimbus-text'
                  : 'border-white/[0.07] text-nimbus-text-dim hover:bg-white/[0.05]'
              }`}
            >
              <span className={selected ? 'text-nimbus-accent-bright' : ''}>
                <ModeIcon mode={option.mode} />
              </span>
              <span className="text-[11px] font-medium tabular-nums leading-none">
                {duration(option.durationMinutes)}
              </span>
              <span className="text-[9px] uppercase tracking-wide leading-none opacity-70">
                {MODE_LABEL[option.mode]}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-nimbus-text-dim">
        <span className="truncate">{data.from}</span>
        <span className="shrink-0 text-nimbus-accent">→</span>
        <span className="truncate">{data.to}</span>
        {active?.distanceKm != null && (
          <span className="ml-auto shrink-0 tabular-nums">{active.distanceKm} km</span>
        )}
      </div>

      {/* Picking public transport should answer "which service", not just
          "how long" — so the real departures come with it. */}
      {mode === 'transit' && data.transit && (
        <div className="mt-2 border-t border-white/[0.07] pt-2">
          <TransitBody data={data.transit} bare />
        </div>
      )}
    </div>
  )
}

/**
 * Pictures that illustrate an explanation. The lead image is shown large
 * because it's the one that does the explaining; the rest are supporting
 * thumbnails. Diagrams sit whole on a light plate — a labelled cutaway is
 * useless cropped, and Wikipedia's line art is dark ink on transparency,
 * invisible against this theme without one.
 */
function Illustrations({ items }: { items: Illustration[] }) {
  const [lead, ...rest] = items
  if (!lead) return null

  return (
    <div className="mb-3">
      <motion.button
        {...mediaIn}
        onClick={() => openLink(lead.url)}
        title={lead.caption}
        className="group block w-full overflow-hidden rounded-lg shadow-lg ring-1 ring-white/15 transition-shadow hover:ring-nimbus-accent/50"
      >
        <img
          src={lead.image}
          alt={lead.caption}
          className={`h-40 w-full ${
            lead.diagram ? 'bg-white/95 object-contain p-1.5' : 'object-cover'
          }`}
        />
        <div className="truncate bg-black/40 px-2 py-1 text-left text-[10px] text-nimbus-text-dim group-hover:text-nimbus-accent-bright">
          {lead.caption}
        </div>
      </motion.button>

      {rest.length > 0 && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {rest.slice(0, 2).map((item) => (
            <motion.button
              {...mediaIn}
              key={item.url}
              onClick={() => openLink(item.url)}
              title={item.caption}
              className="group overflow-hidden rounded-lg ring-1 ring-white/10 transition-shadow hover:ring-nimbus-accent/50"
            >
              <img
                src={item.image}
                alt={item.caption}
                className={`h-16 w-full ${
                  item.diagram ? 'bg-white/95 object-contain p-1' : 'object-cover'
                }`}
              />
              <div className="truncate bg-black/40 px-1.5 py-0.5 text-left text-[9px] text-nimbus-text-dim group-hover:text-nimbus-accent-bright">
                {item.caption}
              </div>
            </motion.button>
          ))}
        </div>
      )}
    </div>
  )
}

/** "24–27 Aug" / "Mon 18 Aug" — an event's days, compactly. */
function eventDates(event: CalendarEvent): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  const start = new Date(`${event.startDate}T12:00:00`)
  if (!event.endDate || event.endDate === event.startDate) {
    return start.toLocaleDateString('en-GB', { weekday: 'short', ...opts })
  }
  const end = new Date(`${event.endDate}T12:00:00`)
  return `${start.toLocaleDateString('en-GB', { day: 'numeric' })}–${end.toLocaleDateString('en-GB', opts)}`
}

function EventRow({ event, running }: { event: CalendarEvent; running?: boolean }) {
  return (
    <li className="flex items-baseline gap-2 text-[11px]">
      <span
        className={`shrink-0 tabular-nums ${running ? 'text-nimbus-accent-bright' : 'text-nimbus-text-dim'}`}
      >
        {running ? 'today' : eventDates(event)}
      </span>
      <span className="min-w-0 flex-1 truncate text-nimbus-text">{event.title}</span>
      {event.location && (
        <span className="shrink-0 text-[10px] text-nimbus-cyan">{event.location}</span>
      )}
    </li>
  )
}

function EventBody({ data }: { data: EventCardData }) {
  const { created } = data
  const rest = data.upcoming.filter((event) => event.id !== created?.id)
  return (
    <div className={panel}>
      {created && (
        <div className="mb-2 flex items-baseline gap-2 border-l-2 border-nimbus-accent/50 pl-2">
          <span className="min-w-0 flex-1 text-[12.5px] text-nimbus-text">{created.title}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-nimbus-accent-bright">
            {eventDates(created)}
          </span>
        </div>
      )}
      {rest.length > 0 && (
        <>
          <div className="text-[9.5px] uppercase tracking-wider text-nimbus-text-dim">
            {created ? 'Also coming up' : 'Coming up'}
          </div>
          <ul className="mt-1 space-y-1">
            {rest.slice(0, 6).map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        </>
      )}
      {!created && rest.length === 0 && (
        <div className="text-[11px] text-nimbus-text-dim">Nothing coming up.</div>
      )}
    </div>
  )
}

/** Small titled band, so the briefing's sections read as one card not four. */
function BriefingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-white/[0.07] pt-2 first:border-0 first:pt-0">
      <div className="text-[9.5px] uppercase tracking-wider text-nimbus-accent/80">{title}</div>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function BriefingBody({ data }: { data: BriefingCardData }) {
  return (
    <div className={`${panel} space-y-2`}>
      {data.weather && (
        <BriefingSection title="Weather">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums text-nimbus-text">
              {data.weather.temp}°
            </span>
            <span className="text-[11px] capitalize text-nimbus-text-dim">
              {data.weather.condition} · {data.weather.city}
            </span>
            <span className="ml-auto text-[10px] text-nimbus-text-dim">
              feels {data.weather.feelsLike}°
            </span>
          </div>
        </BriefingSection>
      )}

      {(data.today.length > 0 || data.upcoming.length > 0) && (
        <BriefingSection title={data.today.length > 0 ? 'Today' : 'Coming up'}>
          <ul className="space-y-1">
            {data.today.map((event) => (
              <EventRow key={event.id} event={event} running />
            ))}
            {data.upcoming.slice(0, 4).map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        </BriefingSection>
      )}

      {data.commute && (
        <BriefingSection title={`Getting to ${data.commute.to.split(',')[0]}`}>
          <ul className="space-y-1">
            {data.commute.journeys.slice(0, 3).map((journey, index) => (
              <li
                key={`${journey.departsAt}-${index}`}
                className="flex items-baseline gap-2 text-[11px]"
              >
                <span className="shrink-0 font-mono tabular-nums text-nimbus-yellow">
                  {journey.departs}
                </span>
                <span
                  className={`shrink-0 rounded px-1 py-px font-mono text-[9.5px] leading-none ring-1 ${lineTone(journey.legs[0]?.line ?? '')}`}
                >
                  {journey.legs[0]?.line || 'Walk'}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-nimbus-text-dim">
                  {journey.durationMinutes} min
                  {journey.changes > 0 && ` · ${journey.changes}×`}
                </span>
              </li>
            ))}
          </ul>
        </BriefingSection>
      )}

      {data.reminders.length > 0 && (
        <BriefingSection title="Coming up">
          <ul className="space-y-1">
            {data.reminders.slice(0, 4).map((reminder) => (
              <li key={reminder.id} className="flex items-baseline gap-2 text-[11px]">
                <span className="shrink-0 tabular-nums text-nimbus-text-dim">
                  {new Date(reminder.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
                <span className="min-w-0 flex-1 truncate text-nimbus-text">{reminder.text}</span>
              </li>
            ))}
          </ul>
        </BriefingSection>
      )}

      {data.news && (
        <BriefingSection title="Headlines">
          <ul className="space-y-1.5">
            {data.news.articles.map((article) => (
              <li key={article.url}>
                <button
                  onClick={() => openLink(article.url)}
                  title={article.url}
                  className="group flex w-full items-start gap-2 text-left"
                >
                  {article.image && (
                    <img
                      src={article.image}
                      alt=""
                      className="h-8 w-12 shrink-0 rounded object-cover ring-1 ring-white/10"
                    />
                  )}
                  <span className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-snug text-nimbus-text group-hover:text-nimbus-accent-bright">
                    {article.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </BriefingSection>
      )}
    </div>
  )
}

/** Drops a reminder from the list without waiting for a reload. */
function CancelReminder({ id, onGone }: { id: string; onGone: (id: string) => void }) {
  return (
    <button
      onClick={() => {
        // Removed from the list as soon as the store confirms it, so the row
        // doesn't linger looking like the click missed.
        void window.nimbus.cancelReminder(id).then((removed) => {
          if (removed) onGone(id)
        })
      }}
      // Named for screen readers; the glyph alone says nothing out loud.
      aria-label="Cancel this reminder"
      title="Cancel this reminder"
      className="shrink-0 rounded px-1 text-[11px] leading-none text-nimbus-text-dim transition-colors hover:bg-white/[0.08] hover:text-nimbus-negative"
    >
      ×
    </button>
  )
}

/** Traffic-light colours: the verdict has to be readable without reading. */
const OUTDOOR_LEVEL: Record<OutdoorFactor['level'], string> = {
  good: 'text-nimbus-positive',
  ok: 'text-nimbus-cyan',
  poor: 'text-nimbus-yellow',
  bad: 'text-nimbus-negative'
}

const OUTDOOR_VERDICT: Record<
  OutdoorCardData['verdict'],
  { label: string; dot: string; ring: string }
> = {
  great: { label: 'Great time to go', dot: 'bg-nimbus-positive', ring: 'text-nimbus-positive' },
  fine: { label: 'Fine to head out', dot: 'bg-nimbus-cyan', ring: 'text-nimbus-cyan' },
  caution: { label: 'Not ideal', dot: 'bg-nimbus-yellow', ring: 'text-nimbus-yellow' },
  no: { label: 'Better to wait', dot: 'bg-nimbus-negative', ring: 'text-nimbus-negative' }
}

/** How many ticks to fill: worse conditions light more of them. */
const OUTDOOR_RANK: Record<OutdoorFactor['level'], number> = { good: 0, ok: 1, poor: 2, bad: 3 }

/** A short glyph per factor, so the row scans without reading the label. */
const OUTDOOR_ICON: Record<OutdoorFactor['kind'], string> = {
  feel: '🌡',
  rain: '🌧',
  air: '💨',
  pollen: '🌾',
  uv: '☀',
  light: '🌗'
}

function OutdoorsBody({ data }: { data: OutdoorCardData }) {
  const verdict = OUTDOOR_VERDICT[data.verdict]

  return (
    <div className={panel}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${verdict.dot}`} />
        <span className={`text-[12.5px] font-medium ${verdict.ring}`}>{verdict.label}</span>
        <span className="ml-auto truncate text-[10px] text-nimbus-text-dim">{data.place}</span>
      </div>

      <Stagger className="mt-2 space-y-1">
        {data.factors.map((factor) => (
          <StaggerItem key={factor.kind}>
            <div className="flex items-baseline gap-2 text-[11px]">
              <span className="w-3.5 shrink-0 text-center opacity-70">
                {OUTDOOR_ICON[factor.kind]}
              </span>
              <span className={`min-w-0 flex-1 truncate ${OUTDOOR_LEVEL[factor.level]}`}>
                {factor.text}
              </span>
              {/* Four ticks, filled to the level — "poor" is visible as a
                  quantity before the sentence is read. */}
              <span className="flex shrink-0 gap-0.5">
                {[0, 1, 2, 3].map((step) => (
                  <motion.span
                    key={step}
                    className={`h-1 w-1.5 rounded-full ${
                      step <= OUTDOOR_RANK[factor.level]
                        ? OUTDOOR_LEVEL[factor.level].replace('text-', 'bg-')
                        : 'bg-white/10'
                    }`}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.25, delay: 0.1 + step * 0.04, ease: EASE }}
                  />
                ))}
              </span>
            </div>
          </StaggerItem>
        ))}
      </Stagger>

      {(data.temperature !== null || data.windSpeed !== null) && (
        <div className="mt-2 flex items-center gap-2 border-t border-white/[0.07] pt-1.5 text-[10px] text-nimbus-text-dim">
          {data.temperature !== null && <span>{Math.round(data.temperature)}°C</span>}
          {data.windSpeed !== null && (
            <>
              <span className="opacity-50">·</span>
              <span>{Math.round(data.windSpeed)} km/h wind</span>
            </>
          )}
          <span className="opacity-50">·</span>
          <span>{data.rainChance}% rain risk</span>
        </div>
      )}
    </div>
  )
}

function CurrencyBody({ data }: { data: CurrencyCardData }) {
  // Small amounts need real precision; large ones look absurd with it.
  const places = data.result >= 100 ? 2 : data.result >= 1 ? 2 : 4

  return (
    <div className={panel}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] tabular-nums text-nimbus-text-dim">
          {data.amount.toLocaleString()} {data.from}
        </div>
        <motion.span
          className="text-nimbus-text-dim"
          initial={{ x: -4, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          →
        </motion.span>
        <div className="text-xl font-semibold tabular-nums text-nimbus-accent-bright">
          <CountUp value={data.result} decimals={places} suffix={` ${data.to}`} />
        </div>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2 border-t border-white/[0.07] pt-1.5 text-[9.5px] text-nimbus-text-dim">
        <span className="tabular-nums">
          1 {data.from} = {data.rate.toFixed(4)} {data.to}
        </span>
        {/* The ECB publishes once a working day; saying which day is the
            difference between "a rate" and "today's rate". */}
        {data.asOf && (
          <>
            <span className="opacity-50">·</span>
            <span>ECB rate, {data.asOf}</span>
          </>
        )}
      </div>
    </div>
  )
}

function ReminderBody({ data }: { data: ReminderCardData }) {
  const { created } = data
  // Cancelled rows are tracked here rather than by refetching: the card is
  // handed a snapshot, and asking the main process for a fresh list would
  // rebuild the whole response for one deletion.
  const [cancelled, setCancelled] = useState<string[]>([])
  const forget = (id: string): void => setCancelled((current) => [...current, id])

  // A fired reminder arrives with only `created` set; a "what's pending"
  // question arrives with only the list.
  const others = data.pending.filter(
    (item) => item.id !== created?.id && !cancelled.includes(item.id)
  )
  const createdCancelled = created ? cancelled.includes(created.id) : false

  return (
    <div className={panel}>
      {created && !createdCancelled && (
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0 text-nimbus-yellow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="13" r="8" />
              <path d="M12 9v4l2.5 2M5 3L2.5 5.5M19 3l2.5 2.5" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-snug text-nimbus-text">{created.text}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-nimbus-text-dim">
              <span className="tabular-nums text-nimbus-yellow">
                {new Date(created.at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
              {/* Showing the working: the alarm is a departure minus the walk,
                  so it's worth saying which train it came from. */}
              {created.departure && (
                <>
                  <span className="opacity-50">·</span>
                  <span>
                    {created.departure.line} at {created.departure.departs} to{' '}
                    {created.departure.to}
                  </span>
                  {created.departure.travelMinutes > 0 && (
                    <>
                      <span className="opacity-50">·</span>
                      <span>{created.departure.travelMinutes} min to the stop</span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <CancelReminder id={created.id} onGone={forget} />
        </div>
      )}

      {others.length > 0 && (
        <ul
          className={
            created && !createdCancelled
              ? 'mt-2.5 space-y-1 border-t border-white/[0.07] pt-2'
              : 'space-y-1'
          }
        >
          {others.slice(0, 5).map((item) => (
            <li key={item.id} className="flex items-baseline gap-2 text-[11px]">
              <span className="shrink-0 tabular-nums text-nimbus-text-dim">
                {new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="min-w-0 flex-1 truncate text-nimbus-text">{item.text}</span>
              <CancelReminder id={item.id} onGone={forget} />
            </li>
          ))}
        </ul>
      )}

      {(!created || createdCancelled) && others.length === 0 && (
        <div className="text-[11px] text-nimbus-text-dim">No reminders set.</div>
      )}
    </div>
  )
}

/** "3 days ago" / "just now" — when an archived answer was given. */
function whenAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function MemoryBody({ data }: { data: MemoryCardData }) {
  const hasAnswers = data.answers.length > 0
  return (
    <div className={panel}>
      {hasAnswers && (
        <>
          <div className="text-[10px] uppercase tracking-wide text-nimbus-text-dim">
            {data.query ? `Earlier: ${data.query}` : 'Recently'}
          </div>
          <ul className="mt-1.5 space-y-2">
            {data.answers.map((entry) => (
              <li key={entry.id} className="border-l-2 border-nimbus-accent/40 pl-2">
                <div className="flex items-baseline gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-nimbus-text">
                    {entry.question}
                  </span>
                  <span className="shrink-0 text-[9.5px] text-nimbus-text-dim">
                    {whenAgo(entry.at)}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-nimbus-text-dim">
                  {entry.answer}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* After "remember that…" there are no search results — the useful
          feedback is the profile as it now stands. */}
      {data.facts.length > 0 && (
        <div className={hasAnswers ? 'mt-2.5 border-t border-white/[0.07] pt-2' : ''}>
          <div className="text-[10px] uppercase tracking-wide text-nimbus-text-dim">
            What I know about you
          </div>
          <ul className="mt-1 space-y-1">
            {data.facts.slice(-6).map((fact) => (
              <li key={fact.id} className="flex gap-1.5 text-[11px] text-nimbus-text">
                <span className="text-nimbus-cyan">•</span>
                <span className="min-w-0 flex-1">{fact.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hasAnswers && data.facts.length === 0 && (
        <div className="text-[11px] text-nimbus-text-dim">Nothing saved yet.</div>
      )}
    </div>
  )
}

function ExplainerBody({ data }: { data: ExplainerCardData }) {
  return (
    <div className={panel}>
      <Illustrations items={data.illustrations} />
      <div className="text-[10px] uppercase tracking-wide text-nimbus-text-dim">{data.topic}</div>
    </div>
  )
}

function SearchBody({ data }: { data: SearchCardData }) {
  const illustrations = data.illustrations ?? []
  return (
    <div className={panel}>
      {illustrations.length > 0 && <Illustrations items={illustrations} />}
      <ul className="space-y-2">
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
    </div>
  )
}
