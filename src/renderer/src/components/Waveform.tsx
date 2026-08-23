import { useEffect, useRef, type RefObject } from 'react'

interface WaveformProps {
  levelRef: RefObject<number>
  /** Samples across the strip. More is smoother and costs one path segment each. */
  barCount?: number
}

/** The drawing surface, in its own units. Scaled to fit by the viewBox. */
const WIDTH = 220
const HEIGHT = 28
const MID = HEIGHT / 2

/** Resting amplitude, so silence is a living line rather than a dead one. */
const MIN_AMPLITUDE = 0.6
const MAX_AMPLITUDE = MID - 1.5

/**
 * Your voice, drawn as a body of water rather than a row of bars.
 *
 * The bars this replaced were a VU meter: discrete, quantised, and lit in a
 * fixed indigo that took no notice of what Nimbus was doing. Next to a glass
 * orb that ripples and throws waves across the panel, a cabinet display was
 * the one element still speaking a different language.
 *
 * So it is one continuous surface now, mirrored about its centre line and
 * closed into a filled shape, with a bright crest along the top edge — the
 * same crest-over-body construction the release wave uses, at a small size.
 * Two things make it read as liquid rather than as a graph:
 *
 *  1. **Smoothing between samples.** The outline is built from quadratic
 *     segments through midpoints, so there are no corners anywhere. A polyline
 *     through the same samples looks like a chart of the sound; a curve looks
 *     like the sound moving something.
 *  2. **A travelling ripple under the level.** Even at a steady volume the
 *     surface is never flat, because still water under a voice is not a thing
 *     anyone has seen.
 *
 * Colour comes from the accent custom property, so the strip follows the orb
 * through listening, thinking and speaking instead of being permanently the
 * colour of one of them.
 *
 * Driven entirely by requestAnimationFrame and direct attribute writes —
 * deliberately not React state, which would re-render the overlay ~60 times a
 * second.
 */
export function Waveform({ levelRef, barCount = 44 }: WaveformProps) {
  const bodyRef = useRef<SVGPathElement>(null)
  const crestRef = useRef<SVGPathElement>(null)

  useEffect(() => {
    // Oldest sample at the left, newest at the right, so the trace scrolls the
    // way the sound arrived.
    const history = new Array<number>(barCount).fill(0)
    let smoothed = 0
    let frame = 0
    let last = 0
    let phase = 0

    /** A smooth outline through the sampled heights, left to right. */
    const outline = (seconds: number): number[] => {
      const ys: number[] = []
      for (let i = 0; i < barCount; i++) {
        const t = i / (barCount - 1)
        // Fades into the strip at both ends rather than being sliced off.
        const edge = Math.sin(t * Math.PI) * 0.35 + 0.65
        // Two ripples of different lengths travelling along the strip, so the
        // surface is alive even while the level holds steady.
        const ripple =
          Math.sin(t * 11 - seconds * 3.1) * 0.16 + Math.sin(t * 5 - seconds * 1.7) * 0.1
        // Square root, not linear: loudness is perceived logarithmically, so a
        // linear mapping leaves ordinary speech near the floor.
        const loud = Math.sqrt(Math.min(1, history[i]))
        // Clamped before scaling. The ripple rides *on* the level, so at
        // full volume adding it on top pushed the outline past the half
        // height and the wave spilled out of its own strip.
        const shape = Math.min(1, loud * (1 + ripple) + ripple * 0.25)
        const amplitude = MIN_AMPLITUDE + shape * MAX_AMPLITUDE * edge
        ys.push(Math.max(MIN_AMPLITUDE, amplitude))
      }
      return ys
    }

    /** Quadratic segments through midpoints — a curve with no corners in it. */
    const curve = (points: Array<[number, number]>): string => {
      if (points.length === 0) return ''
      let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(2)}`
      for (let i = 1; i < points.length; i++) {
        const [px, py] = points[i - 1]
        const [x, y] = points[i]
        d += `Q${px.toFixed(1)},${py.toFixed(2)} ${((px + x) / 2).toFixed(1)},${((py + y) / 2).toFixed(2)}`
      }
      const [lx, ly] = points[points.length - 1]
      return `${d}L${lx.toFixed(1)},${ly.toFixed(2)}`
    }

    const tick = (time: number): void => {
      // Sampled at ~30fps; the underlying level only updates every 60ms.
      if (time - last > 33) {
        const dt = last === 0 ? 0.033 : (time - last) / 1000
        last = time
        phase += dt
        smoothed += ((levelRef.current ?? 0) - smoothed) * 0.35
        history.push(smoothed)
        history.shift()

        const ys = outline(phase)
        const step = WIDTH / (barCount - 1)
        const upper: Array<[number, number]> = ys.map((y, i) => [i * step, MID - y] as [number, number])
        const lower: Array<[number, number]> = ys
          .map((y, i) => [i * step, MID + y] as [number, number])
          .reverse()

        // Closed shape: along the top, back along the mirrored bottom.
        bodyRef.current?.setAttribute('d', `${curve(upper)}${curve(lower).replace('M', 'L')}Z`)
        crestRef.current?.setAttribute('d', curve(upper))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef, barCount])

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-7 w-full overflow-visible"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        {/* Densest along the centre line and thinning outward, the way a body
            of water is darkest where it is deepest. */}
        <linearGradient id="wave-body" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="var(--color-nimbus-accent)" stopOpacity="0.05" />
          <stop offset="50%" stopColor="var(--color-nimbus-accent-bright)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--color-nimbus-accent)" stopOpacity="0.05" />
        </linearGradient>
        <filter id="wave-glow" x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
      </defs>

      {/* The body, blurred and wide — the light the surface carries. */}
      <path ref={bodyRef} fill="url(#wave-body)" filter="url(#wave-glow)" />
      {/* The lit edge, sharp, the way the top of a wave catches the light. */}
      <path
        ref={crestRef}
        fill="none"
        stroke="var(--color-nimbus-accent-bright)"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeOpacity="0.9"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
