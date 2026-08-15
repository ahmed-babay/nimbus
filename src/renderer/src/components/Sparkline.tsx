import { useId } from 'react'

interface SparklineProps {
  values: number[]
  /** Colour follows the trend: up is green, down is red. */
  positive?: boolean
  width?: number
  height?: number
}

/**
 * Minimal price chart drawn as inline SVG — no charting library, so it adds
 * nothing to the bundle and inherits the overlay's palette directly.
 * Deliberately axis-free: at this size the shape is the information, and
 * exact values are already shown as text beside it.
 */
export function Sparkline({ values, positive = true, width = 108, height = 34 }: SparklineProps) {
  const gradientId = useId()

  if (values.length < 2) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const stepX = width / (values.length - 1)
  // Inset vertically so the stroke isn't clipped at the extremes.
  const pad = 3
  const usableHeight = height - pad * 2

  const points = values.map((value, i) => {
    const x = i * stepX
    const y = pad + (1 - (value - min) / span) * usableHeight
    return [x, y] as const
  })

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`

  const stroke = positive ? 'var(--color-nimbus-positive)' : 'var(--color-nimbus-negative)'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      role="img"
      aria-label={positive ? 'Upward price trend' : 'Downward price trend'}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.32" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Mark the latest value so the eye lands on "now". */}
      <circle
        cx={points[points.length - 1][0]}
        cy={points[points.length - 1][1]}
        r="2.2"
        fill={stroke}
      />
    </svg>
  )
}
