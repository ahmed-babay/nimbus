import { useEffect, useRef, type RefObject } from 'react'
import type { NimbusState } from '@shared/types'

interface OrbProps {
  state: NimbusState
  levelRef: RefObject<number>
}

const BLOCK_COUNT = 12
const RING_RADIUS = 24
const BLOCK = 5

/** Positions for the pixel blocks arranged around the ring. */
const BLOCKS = Array.from({ length: BLOCK_COUNT }, (_, i) => {
  const angle = (i / BLOCK_COUNT) * Math.PI * 2 - Math.PI / 2
  return {
    x: 32 + Math.cos(angle) * RING_RADIUS - BLOCK / 2,
    y: 32 + Math.sin(angle) * RING_RADIUS - BLOCK / 2
  }
})

/**
 * Arcade-cabinet indicator: a ring of pixel blocks with a light chasing round
 * it, and a chunky core that pulses. Everything is driven by direct style
 * writes on an animation frame — the chase and the mic-reactive core would
 * otherwise re-render React 60 times a second.
 */
export function Orb({ state, levelRef }: OrbProps) {
  const blocksRef = useRef<SVGRectElement[]>([])
  const coreRef = useRef<SVGRectElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const blocks = blocksRef.current.filter(Boolean)
    if (blocks.length === 0) return

    let frame = 0
    let smoothed = 0
    const startedAt = performance.now()

    // Steps rather than a smooth sweep — the chase should tick like a cabinet
    // light, not glide.
    const speedMs = state === 'thinking' ? 55 : state === 'listening' ? 95 : 150

    const tick = (now: number): void => {
      const elapsed = now - startedAt
      smoothed += (levelRef.current - smoothed) * 0.2

      if (state === 'idle') {
        blocks.forEach((b) => {
          b.style.opacity = '0.22'
          b.setAttribute('fill', 'var(--color-nimbus-accent-deep)')
        })
      } else {
        const head = Math.floor(elapsed / speedMs) % BLOCK_COUNT
        blocks.forEach((b, i) => {
          // Distance behind the chase head, wrapped.
          const behind = (head - i + BLOCK_COUNT) % BLOCK_COUNT
          if (behind === 0) {
            b.style.opacity = '1'
            b.setAttribute('fill', 'var(--color-nimbus-cyan)')
          } else if (behind <= 3) {
            b.style.opacity = String(0.75 - behind * 0.18)
            b.setAttribute('fill', 'var(--color-nimbus-accent)')
          } else {
            b.style.opacity = '0.2'
            b.setAttribute('fill', 'var(--color-nimbus-accent-deep)')
          }
        })
      }

      // Core reacts to the mic while listening, otherwise beats steadily.
      const beat =
        state === 'listening'
          ? 1 + smoothed * 0.55
          : state === 'speaking'
            ? 1 + Math.abs(Math.sin(elapsed / 130)) * 0.22
            : state === 'thinking'
              ? 1 + Math.abs(Math.sin(elapsed / 220)) * 0.12
              : 1

      if (coreRef.current) {
        const size = 14 * beat
        coreRef.current.setAttribute('x', String(32 - size / 2))
        coreRef.current.setAttribute('y', String(32 - size / 2))
        coreRef.current.setAttribute('width', String(size))
        coreRef.current.setAttribute('height', String(size))
      }
      if (glowRef.current) {
        glowRef.current.style.opacity = String(0.35 + (beat - 1) * 1.2)
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state, levelRef])

  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      {/* Neon bloom behind the core */}
      <div
        ref={glowRef}
        className="pointer-events-none absolute h-9 w-9 blur-md"
        style={{
          background:
            'radial-gradient(circle, rgba(34,232,255,0.9), rgba(255,62,165,0.45) 55%, transparent 75%)',
          opacity: 0.35
        }}
      />

      <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full">
        {BLOCKS.map((b, i) => (
          <rect
            key={i}
            ref={(el) => {
              if (el) blocksRef.current[i] = el
            }}
            x={b.x}
            y={b.y}
            width={BLOCK}
            height={BLOCK}
            fill="var(--color-nimbus-accent-deep)"
            opacity={0.22}
          />
        ))}

        {/* Chunky square core — deliberately not a circle */}
        <rect
          ref={coreRef}
          x={25}
          y={25}
          width={14}
          height={14}
          fill="var(--color-nimbus-accent)"
          style={{ filter: 'drop-shadow(0 0 5px rgba(255,62,165,0.9))' }}
        />
        {/* Highlight pixel, like a specular block on a sprite */}
        <rect x={27} y={27} width={3} height={3} fill="var(--color-nimbus-accent-bright)" />
      </svg>
    </div>
  )
}
