import { useEffect, useMemo, useRef, type RefObject } from 'react'

interface WaveformProps {
  levelRef: RefObject<number>
  barCount?: number
}

/** Resting height, so silence reads as a fine line rather than nothing at all. */
const MIN_HEIGHT = 2
const MAX_HEIGHT = 22

/**
 * The strip runs from the oldest sample on the left to the newest on the
 * right, and the colour runs with it — deep indigo behind, brightening to the
 * live edge. It gives the scroll a direction, so the eye lands on the moment
 * being spoken rather than on whichever bar happens to be tallest.
 */
const OLDEST = [70, 80, 200] // accent-deep
const NEWEST = [150, 200, 240] // toward cyan, at the live edge

function gradient(t: number): string {
  const channel = (i: number): number => Math.round(OLDEST[i] + (NEWEST[i] - OLDEST[i]) * t)
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`
}

/**
 * Live microphone level, drawn as a symmetric waveform.
 *
 * Mirrored around the centre line rather than sitting on a floor: a signal
 * that grows in both directions is how an audio tool draws sound, whereas
 * bars rising from a baseline is how a games console draws a level meter.
 * Heights are continuous and the caps are round, for the same reason — the
 * previous version quantised to whole 4px blocks specifically to look like a
 * cabinet VU display.
 *
 * Driven entirely by requestAnimationFrame and direct style writes —
 * deliberately not React state, which would re-render the overlay ~60 times a
 * second.
 */
export function Waveform({ levelRef, barCount = 28 }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Colour depends only on position, so it is set once at mount and never
  // touched again by the animation loop.
  const colours = useMemo(
    () => Array.from({ length: barCount }, (_, i) => gradient(i / Math.max(1, barCount - 1))),
    [barCount]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const bars = Array.from(container.children) as HTMLElement[]
    // History buffer scrolls right-to-left so the newest sample is at the edge.
    const history = new Array<number>(bars.length).fill(0)
    let smoothed = 0
    let frame = 0
    let last = 0

    const tick = (time: number): void => {
      // Sample at ~30fps; the underlying level only updates every 60ms.
      if (time - last > 33) {
        last = time
        smoothed += (levelRef.current - smoothed) * 0.35
        history.push(smoothed)
        history.shift()

        for (let i = 0; i < bars.length; i++) {
          const value = history[i]
          // Taper the ends so the trace fades into the strip instead of being
          // sliced off at the edge.
          const edgeFade = Math.sin((i / (bars.length - 1)) * Math.PI) * 0.3 + 0.7
          // Square root, not linear: loudness is perceived logarithmically, so
          // a linear mapping leaves normal speech sitting near the floor and
          // only shouting fills the strip.
          const height = MIN_HEIGHT + Math.sqrt(Math.min(1, value)) * MAX_HEIGHT * edgeFade
          bars[i].style.height = `${height.toFixed(1)}px`
          bars[i].style.opacity = `${(0.22 + Math.min(1, value * 1.6) * 0.78).toFixed(2)}`
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef])

  return (
    <div ref={containerRef} className="flex h-7 items-center gap-[2px]">
      {colours.map((colour, i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-full"
          style={{
            height: MIN_HEIGHT,
            opacity: 0.22,
            background: colour,
            // A soft bloom in the bar's own colour, so the trace glows at the
            // bright end without a second element per bar.
            boxShadow: `0 0 6px -1px ${colour}`
          }}
        />
      ))}
    </div>
  )
}
