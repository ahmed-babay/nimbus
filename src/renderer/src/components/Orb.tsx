import { useEffect, useRef, type RefObject } from 'react'
import { motion } from 'framer-motion'
import type { NimbusState } from '@shared/types'

interface OrbProps {
  state: NimbusState
  levelRef: RefObject<number>
}

/** Evenly spaced tick marks around a ring, drawn as an SVG dash pattern. */
function runeDashes(radius: number, count: number): string {
  const circumference = 2 * Math.PI * radius
  const segment = circumference / count
  return `${segment * 0.34} ${segment * 0.66}`
}

/**
 * Hextech-style indicator: counter-rotating runic rings around a charged core,
 * with motes drifting off it. While listening the glow tracks the real mic
 * level via requestAnimationFrame reading a ref, so the orb reacts to the
 * user's actual voice without re-rendering React on every audio frame.
 */
export function Orb({ state, levelRef }: OrbProps) {
  const glowRef = useRef<HTMLDivElement>(null)
  const coreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state !== 'listening') {
      if (glowRef.current) glowRef.current.style.transform = 'scale(1)'
      if (coreRef.current) coreRef.current.style.transform = 'scale(1)'
      return
    }

    let frame = 0
    let smoothed = 0
    const tick = (): void => {
      smoothed += (levelRef.current - smoothed) * 0.2
      if (glowRef.current) {
        glowRef.current.style.transform = `scale(${1 + smoothed * 0.95})`
        glowRef.current.style.opacity = `${0.4 + smoothed * 0.55}`
      }
      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${1 + smoothed * 0.3})`
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state, levelRef])

  const isActive = state !== 'idle'
  const isThinking = state === 'thinking'

  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      {/* Runic rings */}
      <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="nimbus-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-nimbus-accent-bright)" />
            <stop offset="55%" stopColor="var(--color-nimbus-accent)" />
            <stop offset="100%" stopColor="var(--color-nimbus-violet)" />
          </linearGradient>
        </defs>

        <g
          className={isActive ? 'nimbus-rotate-slow' : undefined}
          style={{ transformOrigin: '32px 32px' }}
        >
          <circle
            cx="32"
            cy="32"
            r="29"
            fill="none"
            stroke="url(#nimbus-ring)"
            strokeWidth="1.2"
            strokeDasharray={runeDashes(29, 16)}
            opacity={isActive ? 0.85 : 0.3}
          />
        </g>

        <g
          className={isActive ? 'nimbus-rotate-reverse' : undefined}
          style={{ transformOrigin: '32px 32px' }}
        >
          <circle
            cx="32"
            cy="32"
            r="23"
            fill="none"
            stroke="url(#nimbus-ring)"
            strokeWidth="0.9"
            strokeDasharray={runeDashes(23, 9)}
            opacity={isActive ? 0.6 : 0.22}
          />
        </g>

        {/* Thinking: a bright arc races the outer ring. */}
        {isThinking && (
          <g className="nimbus-rotate-slow" style={{ transformOrigin: '32px 32px' }}>
            <circle
              cx="32"
              cy="32"
              r="26"
              fill="none"
              stroke="var(--color-nimbus-accent-bright)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeDasharray="20 143"
            />
          </g>
        )}
      </svg>

      {/* Reactive glow */}
      <div
        ref={glowRef}
        className="absolute h-10 w-10 rounded-full blur-md will-change-transform"
        style={{
          background:
            'radial-gradient(circle, rgba(79,214,255,0.95), rgba(169,123,255,0.35) 55%, rgba(109,75,214,0) 75%)',
          opacity: 0.45
        }}
      />

      {/* Charged core */}
      <motion.div
        ref={coreRef}
        className="relative h-[22px] w-[22px] rounded-full will-change-transform"
        style={{
          background:
            'radial-gradient(circle at 35% 30%, #eafcff, var(--color-nimbus-accent) 45%, var(--color-nimbus-violet-deep) 100%)',
          boxShadow:
            '0 0 18px rgba(79,214,255,0.7), 0 0 34px rgba(169,123,255,0.35), inset 0 1px 2px rgba(255,255,255,0.55)'
        }}
        animate={
          state === 'speaking'
            ? { scale: [1, 1.16, 1] }
            : isThinking
              ? { opacity: [0.6, 1, 0.6] }
              : { scale: 1, opacity: 1 }
        }
        transition={{
          duration: state === 'speaking' ? 0.6 : 1.2,
          repeat: state === 'speaking' || isThinking ? Infinity : 0,
          ease: 'easeInOut'
        }}
      />

      {/* Motes lifting off the core while it's doing something */}
      {isActive &&
        [0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="pointer-events-none absolute h-[3px] w-[3px] rounded-full bg-nimbus-accent-bright"
            style={{
              left: `${28 + (i % 2 === 0 ? -9 : 9) + i * 2}px`,
              bottom: '20px',
              boxShadow: '0 0 6px var(--color-nimbus-accent)',
              animation: `nimbus-float ${2.2 + i * 0.35}s ease-out ${i * 0.5}s infinite`
            }}
          />
        ))}
    </div>
  )
}
