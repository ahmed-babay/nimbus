import { motion } from 'framer-motion'

/**
 * Weather as a moving picture rather than a word.
 *
 * Drawn as inline SVG instead of an emoji or a bitmap for two reasons: the
 * overlay's CSP blocks remote images, and a glyph that *moves the way the
 * weather moves* is read faster than one that doesn't — rain falls, clouds
 * drift, the sun turns. That is the whole point; a static icon would be no
 * better than the word already next to it.
 *
 * Motion is deliberately slow and looping. This sits on screen for as long as
 * the card does, and anything quick becomes a distraction on the second
 * viewing.
 */

/** OpenWeather's icon codes end in `d` or `n`; the prefix is the condition. */
export type WeatherKind =
  | 'clear'
  | 'partly'
  | 'cloudy'
  | 'rain'
  | 'drizzle'
  | 'storm'
  | 'snow'
  | 'mist'

/** Maps OpenWeather's icon code to something we can draw. */
export function weatherKind(icon: string): WeatherKind {
  const code = icon.slice(0, 2)
  switch (code) {
    case '01':
      return 'clear'
    case '02':
      return 'partly'
    case '03':
    case '04':
      return 'cloudy'
    case '09':
      return 'drizzle'
    case '10':
      return 'rain'
    case '11':
      return 'storm'
    case '13':
      return 'snow'
    default:
      return 'mist'
  }
}

const SUN = 'var(--color-nimbus-yellow)'
const CLOUD = 'rgba(255,255,255,0.82)'
const RAIN = 'var(--color-nimbus-cyan)'

/** Slow rotation, so the rays read as a sun rather than a gear. */
function Sun({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <g>
      <motion.g
        animate={{ rotate: 360 }}
        transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}
        style={{ originX: `${cx}px`, originY: `${cy}px` }}
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <line
            key={i}
            x1={cx}
            y1={cy - r - 3}
            x2={cx}
            y2={cy - r - 7}
            stroke={SUN}
            strokeWidth="2"
            strokeLinecap="round"
            transform={`rotate(${i * 45} ${cx} ${cy})`}
          />
        ))}
      </motion.g>
      <motion.circle
        cx={cx}
        cy={cy}
        r={r}
        fill={SUN}
        animate={{ opacity: [0.85, 1, 0.85] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
    </g>
  )
}

/** Drifts sideways a few pixels — the motion that reads as "cloud". */
function Cloud({ x, y, scale = 1, opacity = 1 }: { x: number; y: number; scale?: number; opacity?: number }) {
  return (
    <motion.g
      animate={{ x: [x - 2, x + 2, x - 2] }}
      transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
      style={{ scale, originX: '32px', originY: '32px' }}
      opacity={opacity}
    >
      <path
        d={`M${y === 0 ? 14 : 14},34 a9,9 0 0,1 3,-17 a12,12 0 0,1 23,-2 a8,8 0 0,1 2,19 z`}
        fill={CLOUD}
        transform={`translate(0 ${y})`}
      />
    </motion.g>
  )
}

/** Falling drops, staggered so they don't march in lockstep. */
function Drops({ count, y, colour = RAIN }: { count: number; y: number; colour?: string }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <motion.line
          key={i}
          x1={19 + i * 9}
          y1={y}
          x2={17 + i * 9}
          y2={y + 6}
          stroke={colour}
          strokeWidth="2"
          strokeLinecap="round"
          animate={{ y: [0, 10], opacity: [0, 1, 0] }}
          transition={{
            duration: 1.1,
            repeat: Infinity,
            ease: 'easeIn',
            delay: i * 0.28
          }}
        />
      ))}
    </>
  )
}

function Flakes({ count, y }: { count: number; y: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <motion.circle
          key={i}
          cx={19 + i * 9}
          cy={y}
          r="2"
          fill="rgba(255,255,255,0.95)"
          // Drifting sideways as they fall is what separates snow from rain
          // at a glance.
          animate={{ y: [0, 11], x: [0, i % 2 ? 2.5 : -2.5, 0], opacity: [0, 1, 0] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'linear', delay: i * 0.5 }}
        />
      ))}
    </>
  )
}

export function WeatherGlyph({ icon, size = 56 }: { icon: string; size?: number }) {
  const kind = weatherKind(icon)

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {kind === 'clear' && <Sun cx={32} cy={32} r={11} />}

      {kind === 'partly' && (
        <>
          <Sun cx={24} cy={24} r={9} />
          <Cloud x={0} y={6} scale={0.92} />
        </>
      )}

      {kind === 'cloudy' && (
        <>
          <Cloud x={0} y={2} opacity={0.55} scale={0.82} />
          <Cloud x={0} y={8} />
        </>
      )}

      {(kind === 'rain' || kind === 'drizzle') && (
        <>
          <Cloud x={0} y={0} />
          <Drops count={kind === 'rain' ? 4 : 3} y={40} />
        </>
      )}

      {kind === 'storm' && (
        <>
          <Cloud x={0} y={0} />
          <motion.path
            d="M32,38 L27,48 L31,48 L28,57 L37,45 L32,45 L36,38 Z"
            fill={SUN}
            // A flash, not a fade: lightning is the one weather that is
            // genuinely sudden, and easing it would misrepresent it.
            animate={{ opacity: [0, 0, 1, 0.2, 1, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, times: [0, 0.6, 0.66, 0.72, 0.78, 0.9] }}
          />
        </>
      )}

      {kind === 'snow' && (
        <>
          <Cloud x={0} y={0} />
          <Flakes count={4} y={42} />
        </>
      )}

      {kind === 'mist' && (
        <g>
          {[0, 1, 2, 3].map((i) => (
            <motion.line
              key={i}
              x1="14"
              y1={22 + i * 7}
              x2="50"
              y2={22 + i * 7}
              stroke={CLOUD}
              strokeWidth="3"
              strokeLinecap="round"
              opacity={0.7}
              animate={{ x: [-3, 3, -3] }}
              transition={{ duration: 6 + i, repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 }}
            />
          ))}
        </g>
      )}
    </svg>
  )
}
