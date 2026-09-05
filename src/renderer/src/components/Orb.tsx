import { useEffect, useRef, type RefObject } from 'react'
import type { NimbusState } from '@shared/types'
import { STATE_THEME, orbModeFor, type OrbMode } from '../lib/state-theme'
import { createStormOrb, stormPalette, type OrbPalette } from '../lib/storm-orb'

interface OrbProps {
  state: NimbusState
  answerSeq?: number
  searching?: boolean
  levelRef: RefObject<number>
  size?: number
  tight?: boolean
  /**
   * Changes whenever the orb arrives somewhere new — a different window size,
   * a return to the main view. Each change rings the rim once, so shrinking to
   * the dock and coming back are both acknowledged by the orb rather than
   * happening silently to it.
   */
  pulseKey?: string | number
}

const ENERGY: Record<OrbMode, number> = {
  idle: .38, listening: .48, thinking: .58, searching: .65, speaking: .5, playing: .48
}

/** How long a layout tremor rings for before it has fully died away. */
const PULSE_MS = 620

/**
 * A fixed-size shell.
 *
 * Two different motions, deliberately not the same one: **your** voice sways
 * the whole orb a sub-two-pixel amount, because it is being moved by something
 * outside it; **Nimbus's** voice rings the rim in place, because the sound is
 * coming from inside. The shell never travels while it speaks — a talking
 * object that drifts around the layout reads as a glitch, and it nudges the
 * text beside it.
 */
export function Orb({ state, searching = false, answerSeq = 0, levelRef, size = 52, pulseKey }: OrbProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mode = orbModeFor(state, searching)
  const live = useRef({ state, mode, size })
  live.current = { state, mode, size }
  // Mounting an existing answer in another layout is not a new answer.
  const previousAnswer = useRef(answerSeq)
  const answeredAt = useRef(-Infinity)
  useEffect(() => {
    if (answerSeq !== previousAnswer.current) answeredAt.current = performance.now()
    previousAnswer.current = answerSeq
  }, [answerSeq])

  // Rings on mount and on every layout change. Mount counts: the three window
  // sizes are separate subtrees, so shrinking to the dock and expanding back
  // both arrive here as a fresh orb rather than as a prop change.
  const pulsedAt = useRef(-Infinity)
  useEffect(() => { pulsedAt.current = performance.now() }, [pulseKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const storm = createStormOrb(canvas, { fill: .94, bare: true, contained: true })
    if (!storm) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let palette: OrbPalette = stormPalette(STATE_THEME[live.current.mode].orb)
    let targetMode = live.current.mode
    let target = palette
    let level = 0
    let tremor = 0
    let frame = 0
    let lastDraw = 0

    /**
     * How hard the rim should be ringing right now.
     *
     * Speaking holds a floor the whole time it speaks, so the rim keeps
     * vibrating through the gaps between words rather than stopping dead on
     * every pause and looking like the audio dropped out. It stops when the
     * speech does, and not before.
     */
    const tremorTarget = (now: number): number => {
      if (motion.matches) return 0
      const pulse = Math.max(0, 1 - (now - pulsedAt.current) / PULSE_MS)
      // Eased so a layout tremor lands hard and fades, rather than ramping
      // linearly down like a slider being dragged.
      const settling = pulse * pulse * 0.72
      const speaking = live.current.state === 'speaking' ? Math.min(1, 0.75 + level * 1.1) : 0
      return Math.min(1, Math.max(settling, speaking))
    }

    const drive = (now: number) => ({
      palette,
      intensity: ENERGY[live.current.mode] + level * .18 +
        (motion.matches ? 0 : Math.max(0, 1 - (now - answeredAt.current) / 1000) * .1),
      charge: 0, release: 0, flash: 0, level, scale: 1, tremor
    })
    const resize = () => {
      storm.resize()
      if (motion.matches) storm.still(drive(performance.now()))
      else storm.frame(drive(performance.now()), 0, performance.now())
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (document.hidden || now - lastDraw < 33) return
      const dt = Math.min(64, lastDraw ? now - lastDraw : 33)
      lastDraw = now
      const changed = targetMode !== live.current.mode
      if (changed) {
        targetMode = live.current.mode
        target = stormPalette(STATE_THEME[targetMode].orb)
      }
      if (motion.matches) {
        if (changed) { palette = target; level = 0; tremor = 0; storm.still(drive(now)) }
        return
      }
      const raw = live.current.state === 'listening' || live.current.state === 'speaking' ? levelRef.current : 0
      const safe = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
      level += (safe - level) * Math.min(1, dt / 120)
      // Quick to start ringing, slower to go quiet — an edge that stopped as
      // abruptly as it started would look switched off rather than damped.
      const wanted = tremorTarget(now)
      tremor += (wanted - tremor) * Math.min(1, dt / (wanted > tremor ? 70 : 190))
      if (tremor < .004) tremor = 0
      // A smooth, sub-two-pixel sway follows *your* voice only. Smaller dock
      // orbs move proportionally less; silence settles back to center. While
      // Nimbus speaks the shell stays put and the rim does the work instead.
      const amplitude = live.current.state === 'listening'
        ? Math.sqrt(Math.max(0, level - .025)) * 1.6 * Math.min(1, live.current.size / 72)
        : 0
      if (rootRef.current) {
        const seconds = now / 1000
        const x = Math.sin(seconds * 16) * amplitude
        const y = Math.sin(seconds * 11 + .7) * amplitude * .45
        rootRef.current.style.transform = amplitude < .015 ? 'none' : `translate3d(${x.toFixed(3)}px, ${y.toFixed(3)}px, 0)`
      }
      // Each channel eases together so the shell stays one continuous object.
      for (const key of ['beam', 'arc', 'core', 'shell'] as const) {
        for (let i = 0; i < 3; i++) palette[key][i] += (target[key][i] - palette[key][i]) * Math.min(1, dt / 320)
      }
      storm.frame(drive(now), dt, now)
    }
    const onMotionChange = () => {
      level = 0
      tremor = 0
      if (rootRef.current) rootRef.current.style.transform = 'none'
      palette = stormPalette(STATE_THEME[live.current.mode].orb); target = palette; resize()
    }
    motion.addEventListener('change', onMotionChange)
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); observer.disconnect(); motion.removeEventListener('change', onMotionChange) }
  }, [levelRef])

  return <div ref={rootRef} className="nimbus-orb nimbus-orb-contained relative shrink-0" data-state={state} style={{ width: size, height: size }} aria-hidden="true">
    <canvas ref={canvasRef} className="h-full w-full" />
  </div>
}
