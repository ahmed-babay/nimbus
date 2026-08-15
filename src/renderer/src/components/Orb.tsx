import { useEffect, useRef, type RefObject } from 'react'
import { motion } from 'framer-motion'
import type { NimbusState } from '@shared/types'

interface OrbProps {
  state: NimbusState
  levelRef: RefObject<number>
}

/**
 * Listening / thinking / speaking indicator. While listening the glow tracks
 * the real mic level via requestAnimationFrame reading a ref, so it reacts to
 * the user's actual voice without re-rendering React on every audio frame.
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
      // Ease toward the target so the orb breathes instead of jittering.
      smoothed += (levelRef.current - smoothed) * 0.2
      if (glowRef.current) {
        glowRef.current.style.transform = `scale(${1 + smoothed * 0.85})`
        glowRef.current.style.opacity = `${0.35 + smoothed * 0.5}`
      }
      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${1 + smoothed * 0.28})`
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state, levelRef])

  const isActive = state === 'listening' || state === 'speaking'

  return (
    <div className="relative flex h-14 w-14 shrink-0 items-center justify-center">
      {/* Outer conic sweep — subtle "system running" cue */}
      {isActive && (
        <div className="nimbus-rotate-slow absolute inset-0 rounded-full opacity-70">
          <div
            className="h-full w-full rounded-full"
            style={{
              background:
                'conic-gradient(from 0deg, transparent 0deg, rgba(255,138,61,0.55) 90deg, transparent 200deg)',
              maskImage: 'radial-gradient(circle, transparent 58%, black 62%)',
              WebkitMaskImage: 'radial-gradient(circle, transparent 58%, black 62%)'
            }}
          />
        </div>
      )}

      {state === 'thinking' && (
        <div className="nimbus-rotate-reverse absolute inset-1 rounded-full opacity-80">
          <div
            className="h-full w-full rounded-full"
            style={{
              background:
                'conic-gradient(from 0deg, transparent 0deg, rgba(255,176,103,0.8) 60deg, transparent 140deg)',
              maskImage: 'radial-gradient(circle, transparent 62%, black 66%)',
              WebkitMaskImage: 'radial-gradient(circle, transparent 62%, black 66%)'
            }}
          />
        </div>
      )}

      {/* Reactive glow */}
      <div
        ref={glowRef}
        className="absolute h-9 w-9 rounded-full blur-md will-change-transform"
        style={{
          background: 'radial-gradient(circle, rgba(255,138,61,0.9), rgba(255,106,31,0) 70%)',
          opacity: 0.4
        }}
      />

      {/* Core */}
      <motion.div
        ref={coreRef}
        className="relative h-6 w-6 rounded-full will-change-transform"
        style={{
          background: 'linear-gradient(145deg, #ffb067, #ff6a1f)',
          boxShadow: '0 0 18px rgba(255,138,61,0.65), inset 0 1px 2px rgba(255,255,255,0.4)'
        }}
        animate={
          state === 'speaking'
            ? { scale: [1, 1.14, 1] }
            : state === 'thinking'
              ? { opacity: [0.65, 1, 0.65] }
              : { scale: 1, opacity: 1 }
        }
        transition={{
          duration: state === 'speaking' ? 0.62 : 1.1,
          repeat: state === 'speaking' || state === 'thinking' ? Infinity : 0,
          ease: 'easeInOut'
        }}
      />
    </div>
  )
}
