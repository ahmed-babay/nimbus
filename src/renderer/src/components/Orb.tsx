import { useEffect, useRef, type RefObject } from 'react'
import type { NimbusState } from '@shared/types'

interface OrbProps {
  state: NimbusState
  /** Live microphone level, 0..1, updated outside React. */
  levelRef: RefObject<number>
}

/**
 * The voice orb — the one thing on screen that should feel alive.
 *
 * It replaces a blocky equaliser of stacked rectangles, which read as a
 * cassette deck. This is the element people look at while talking, so it is
 * the element that decides whether the app feels like a tool or a toy.
 *
 * Three layers, each doing one job:
 *
 *  1. A soft halo that breathes slowly at rest and swells with your voice.
 *  2. A ring that traces the orb and rotates while thinking — the only motion
 *     that says "working" without a spinner.
 *  3. A core whose brightness follows the microphone.
 *
 * **Driven outside React.** The level updates ~60 times a second; routing that
 * through state would re-render the whole card on every frame. The animation
 * writes to the DOM directly, which is also why the level arrives as a ref.
 */

const IDLE_SCALE = 1
/** How far the halo swells at full voice. Restraint on purpose — a pulse that
 *  doubles in size reads as a game, not an input meter. */
const VOICE_SWELL = 0.28

const STATE_COLOR: Record<NimbusState, string> = {
  idle: 'var(--color-nimbus-text-dim)',
  listening: 'var(--color-nimbus-accent)',
  thinking: 'var(--color-nimbus-accent-bright)',
  speaking: 'var(--color-nimbus-cyan)',
  playing: 'var(--color-nimbus-positive)'
}

export function Orb({ state, levelRef }: OrbProps) {
  const haloRef = useRef<HTMLDivElement>(null)
  const coreRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    let frame = 0
    // Smoothed rather than raw: microphone level is jittery frame to frame,
    // and following it exactly makes the orb vibrate instead of breathe.
    let smoothed = 0
    const startedAt = performance.now()

    const tick = (now: number): void => {
      const level = Math.max(0, Math.min(1, levelRef.current ?? 0))
      smoothed += (level - smoothed) * 0.18

      const seconds = (now - startedAt) / 1000
      // A slow sine keeps it alive when nothing is being said, so the orb
      // never looks frozen or broken.
      const breath = 0.5 + 0.5 * Math.sin(seconds * 1.1)
      const active = state === 'listening' || state === 'speaking'
      const swell = active ? smoothed * VOICE_SWELL : 0

      if (haloRef.current) {
        haloRef.current.style.transform = `scale(${IDLE_SCALE + swell + breath * 0.06})`
        haloRef.current.style.opacity = `${0.28 + breath * 0.12 + smoothed * 0.4}`
      }
      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${1 + swell * 0.5})`
        coreRef.current.style.opacity = `${0.75 + smoothed * 0.25}`
      }
      if (ringRef.current && state === 'thinking') {
        ringRef.current.style.transform = `rotate(${seconds * 120}deg)`
      } else if (ringRef.current) {
        ringRef.current.style.transform = 'rotate(0deg)'
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef, state])

  const color = STATE_COLOR[state]

  return (
    <div className="relative h-12 w-12 shrink-0 self-start" aria-hidden="true">
      {/* Halo */}
      <div
        ref={haloRef}
        className="absolute inset-0 rounded-full blur-md will-change-transform"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${color} 0%, transparent 70%)`,
          transition: 'background 400ms ease'
        }}
      />

      {/* Ring: a gap in the stroke is what makes rotation visible at all. */}
      <svg
        ref={ringRef}
        viewBox="0 0 48 48"
        className="absolute inset-0 h-full w-full will-change-transform"
        style={{ transition: 'transform 200ms linear' }}
      >
        <circle
          cx="24"
          cy="24"
          r="19"
          fill="none"
          stroke={color}
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeDasharray={state === 'thinking' ? '54 66' : '120 0'}
          opacity={state === 'idle' ? 0.35 : 0.75}
          style={{ transition: 'stroke-dasharray 300ms ease, opacity 300ms ease' }}
        />
      </svg>

      {/* Core */}
      <div className="absolute inset-0 grid place-items-center">
        <div
          ref={coreRef}
          className="h-4 w-4 rounded-full will-change-transform"
          style={{
            background: `radial-gradient(circle at 35% 30%, #ffffff 0%, ${color} 55%, ${color} 100%)`,
            boxShadow: `0 0 12px -2px ${color}`,
            transition: 'background 400ms ease, box-shadow 400ms ease'
          }}
        />
      </div>
    </div>
  )
}
