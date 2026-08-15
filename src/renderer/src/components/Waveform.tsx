import { useEffect, useRef, type RefObject } from 'react'

interface WaveformProps {
  levelRef: RefObject<number>
  barCount?: number
}

/**
 * Scrolling bar visualiser fed by the live mic level. Driven entirely by
 * requestAnimationFrame + direct style writes — deliberately not React state,
 * which would re-render the overlay ~60 times a second.
 */
export function Waveform({ levelRef, barCount = 28 }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null)

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
      // Sample at ~30fps; the underlying level only updates every 100ms.
      if (time - last > 33) {
        last = time
        smoothed += (levelRef.current - smoothed) * 0.35
        history.push(smoothed)
        history.shift()

        for (let i = 0; i < bars.length; i++) {
          const value = history[i]
          // Taper the edges so the waveform fades out rather than clipping.
          const edgeFade = Math.sin((i / (bars.length - 1)) * Math.PI) * 0.35 + 0.65
          // Quantise to whole blocks — a smooth bar reads as a modern meter,
          // stepped blocks read as a cabinet VU display.
          const steps = Math.max(1, Math.round((value * 26 * edgeFade) / 4))
          bars[i].style.height = `${steps * 4}px`
          bars[i].style.opacity = `${0.3 + Math.min(1, value * 2) * 0.7}`
          // Colour by level, like an arcade level meter topping out.
          bars[i].style.background =
            steps >= 5
              ? 'var(--color-nimbus-yellow)'
              : steps >= 3
                ? 'var(--color-nimbus-accent)'
                : 'var(--color-nimbus-cyan)'
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef])

  return (
    <div ref={containerRef} className="flex h-7 items-center gap-[2px]">
      {Array.from({ length: barCount }).map((_, i) => (
        <span
          key={i}
          className="w-[3px] bg-nimbus-cyan"
          style={{ height: 4, opacity: 0.3 }}
        />
      ))}
    </div>
  )
}
