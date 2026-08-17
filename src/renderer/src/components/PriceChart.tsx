import { motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { STOCK_RANGES, type StockCardData, type StockRange } from '@shared/types'
import { CountUp, EASE } from './Motion'

/** Spelled out, because "1D" next to a percentage is not self-explanatory. */
const RANGE_LABEL: Record<StockRange, string> = {
  '1d': 'today',
  '5d': 'past week',
  '1mo': 'past month',
  '6mo': 'past 6 months',
  '1y': 'past year'
}

/** Percentage move, coloured and with a nudging arrow. */
function Delta({ value }: { value: number }) {
  const positive = value >= 0
  return (
    <span
      className={`flex shrink-0 items-baseline gap-0.5 text-[11px] font-medium tabular-nums ${
        positive ? 'text-nimbus-positive' : 'text-nimbus-negative'
      }`}
    >
      <motion.span
        key={positive ? 'up' : 'down'}
        initial={{ y: positive ? 4 : -4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        {positive ? '▲' : '▼'}
      </motion.span>
      <CountUp value={Math.abs(value)} decimals={2} suffix="%" />
    </span>
  )
}

/**
 * A price chart that draws itself in, switches window, and keeps up.
 *
 * Bigger than a sparkline because it has a job a sparkline doesn't: the line
 * is the answer, not decoration next to it. It fills under the curve, marks
 * the open with a dashed baseline so "up or down today" is readable without
 * axes, and animates the stroke on so a range switch reads as a change rather
 * than a flicker.
 *
 * **Live only while the exchange is open.** Polling a closed market re-fetches
 * an identical number every ten seconds, which costs Yahoo bandwidth and tells
 * the user nothing, so `data.live` gates the timer.
 */

/** Fast enough to feel live, slow enough to be polite to an unofficial API. */
const POLL_MS = 15_000

function pathFor(values: number[], width: number, height: number, pad: number): string {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  // A flat line would divide by zero; give it a hair of range so it draws
  // through the middle rather than vanishing.
  const span = max - min || Math.abs(max) * 0.001 || 1

  return values
    .map((value, i) => {
      const x = pad + (i / (values.length - 1)) * (width - pad * 2)
      const y = pad + (1 - (value - min) / span) * (height - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

export function PriceChart({
  initial,
  compact = false
}: {
  initial: StockCardData
  compact?: boolean
}) {
  // NOTE: the price and percentage are rendered *here*, from the same state
  // the chart draws from. They used to live in the parent card, reading the
  // original prop, so switching to 1W redrew the chart while the percentage
  // stayed on the day's move — and the "live" poll updated a number nobody
  // could see. One owner, one truth.
  const [data, setData] = useState(initial)
  const [range, setRange] = useState<StockRange>(initial.range)
  const [loading, setLoading] = useState(false)

  // A new card for a different symbol must not keep showing the old one.
  useEffect(() => {
    setData(initial)
    setRange(initial.range)
  }, [initial])

  useEffect(() => {
    if (range === data.range) return
    let cancelled = false
    setLoading(true)
    void window.nimbus
      .getQuote(initial.symbol, range)
      .then((fresh) => {
        if (!cancelled) setData(fresh)
      })
      .catch(() => {
        // Leave the previous window on screen; an empty chart is worse than a
        // slightly stale one.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range, initial.symbol, data.range])

  useEffect(() => {
    if (!data.live) return
    const timer = setInterval(() => {
      void window.nimbus
        .getQuote(initial.symbol, range)
        .then(setData)
        .catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [data.live, initial.symbol, range])

  const width = 300
  const height = compact ? 44 : 92
  const positive = data.changePercent >= 0
  const stroke = positive ? 'var(--color-nimbus-positive)' : 'var(--color-nimbus-negative)'

  const line = useMemo(() => pathFor(data.history, width, height, 4), [data.history, height])
  const area = useMemo(() => {
    if (!line) return ''
    return `${line} L${width - 4},${height - 4} L4,${height - 4} Z`
  }, [line, height])

  // The price the window opened at — the reference the percentage is measured
  // against, so the dashed line is literally "flat on the day".
  const openY = useMemo(() => {
    if (data.history.length < 2) return null
    const min = Math.min(...data.history)
    const max = Math.max(...data.history)
    const span = max - min || 1
    const open = data.history[0]
    return 4 + (1 - (open - min) / span) * (height - 8)
  }, [data.history, height])

  const gradientId = `fill-${data.symbol}-${compact ? 'c' : 'f'}`

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span
          className={`font-semibold tracking-wide text-nimbus-text ${compact ? 'text-[12px]' : 'text-sm'}`}
        >
          {data.symbol}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-nimbus-text-dim">{data.name}</span>
        <span
          className={`shrink-0 font-semibold tabular-nums text-nimbus-text ${compact ? 'text-[13px]' : 'text-lg'}`}
        >
          <CountUp value={data.price} decimals={2} />
        </span>
        <Delta value={data.changePercent} />
      </div>
      <div className="mt-0.5 text-[9px] text-nimbus-text-dim">
        {/* Says which window the percentage describes, so "down 10%" can never
            be read as today when it is the month. */}
        {RANGE_LABEL[data.range]} · {data.currency}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height, opacity: loading ? 0.45 : 1, transition: 'opacity 140ms' }}
        preserveAspectRatio="none"
        aria-label={`${data.symbol} price over ${range}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {openY !== null && (
          <line
            x1="4"
            y1={openY}
            x2={width - 4}
            y2={openY}
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="3 4"
            className="text-nimbus-text-dim"
            opacity="0.35"
          />
        )}

        {area && <motion.path d={area} fill={`url(#${gradientId})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} />}

        {line && (
          <motion.path
            // Keyed on the window so switching range replays the draw-on
            // rather than morphing between two unrelated shapes.
            key={`${data.symbol}-${range}-${data.history.length}`}
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 0.5 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        )}
      </svg>

      <div className="mt-1.5 flex items-center gap-1">
        {STOCK_RANGES.map((option) => (
          <button
            key={option.id}
            onClick={() => setRange(option.id)}
            className={`rounded px-1.5 py-0.5 text-[9.5px] tabular-nums transition-colors ${
              option.id === range
                ? 'bg-white/[0.12] text-nimbus-text'
                : 'text-nimbus-text-dim hover:bg-white/[0.06] hover:text-nimbus-text'
            }`}
          >
            {option.label}
          </button>
        ))}
        {data.live && (
          <span className="ml-auto flex items-center gap-1 text-[9px] text-nimbus-positive">
            {/* A pulsing dot is the cheapest honest signal that the number is
                still moving; it disappears entirely when the market closes. */}
            <motion.span
              className="h-1.5 w-1.5 rounded-full bg-nimbus-positive"
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            />
            live
          </span>
        )}
      </div>
    </div>
  )
}
