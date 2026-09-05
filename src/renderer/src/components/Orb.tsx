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
}

const ENERGY: Record<OrbMode, number> = {
  idle: .38, listening: .48, thinking: .58, searching: .65, speaking: .5, playing: .48
}

/** A fixed-size shell with a tiny voice-driven sway, never an expanding burst. */
export function Orb({ state, searching = false, answerSeq = 0, levelRef, size = 52 }: OrbProps) {
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
    let frame = 0
    let lastDraw = 0

    const drive = (now: number) => ({
      palette,
      intensity: ENERGY[live.current.mode] + level * .18 +
        (motion.matches ? 0 : Math.max(0, 1 - (now - answeredAt.current) / 1000) * .1),
      charge: 0, release: 0, flash: 0, level, scale: 1
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
        if (changed) { palette = target; level = 0; storm.still(drive(now)) }
        return
      }
      const raw = live.current.state === 'listening' || live.current.state === 'speaking' ? levelRef.current : 0
      const safe = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
      level += (safe - level) * Math.min(1, dt / 120)
      // A smooth, sub-two-pixel sway follows the voice envelope. Smaller
      // dock orbs move proportionally less; silence settles back to center.
      const amplitude = Math.sqrt(Math.max(0, level - .025)) * 1.6 * Math.min(1, live.current.size / 72)
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
