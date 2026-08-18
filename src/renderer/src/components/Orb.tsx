import { useEffect, useRef, type RefObject } from 'react'
import type { NimbusState } from '@shared/types'
import { ORB_PALETTE, orbModeFor } from '../lib/orb-palette'

interface OrbProps {
  state: NimbusState
  /**
   * True while a web search is actually in flight. Not a state of its own —
   * Nimbus is still "thinking" as far as the rest of the app is concerned —
   * but reaching out to the network reads differently from turning an
   * answer over, and the orb should show the difference.
   */
  searching?: boolean
  /** Live microphone level, 0..1, updated outside React. */
  levelRef: RefObject<number>
  /** Overrides the default size, in pixels. */
  size?: number
}

/**
 * The voice orb: a glass sphere with a living void inside it.
 *
 * Built to a reference rather than invented — a dark translucent globe, a
 * bright crescent rim where the light catches the edge, luminous blue inside,
 * and a soft bloom spilling onto the background.
 *
 * What actually sells it, in order of how much each matters:
 *
 *  1. **The rim, not the fill.** A glass ball is dark in the middle and bright
 *     only where the surface turns away from you. Lighting the centre is what
 *     makes an orb read as a button.
 *  2. **Additive blending.** The interior uses `screen`, so where things cross
 *     they brighten instead of stacking opaquely, which is how light behaves
 *     and paint does not.
 *  3. **Deformation, not rotation.** Two earlier versions spun the interior and
 *     slid light along fixed arcs. Rotating a soft symmetric blob is nearly
 *     invisible, and a dash travelling a fixed curve reads as something running
 *     on rails. What reads as alive is a shape whose *outline* changes.
 *
 * **Driven outside React.** The microphone level updates ~60 times a second;
 * routing that through state would re-render the whole card every frame, which
 * is why the level arrives as a ref and this writes to the DOM directly.
 */

/** How far the sphere swells at full voice. Small: this is a meter, not a toy. */
const VOICE_SWELL = 0.16

/**
 * The sphere arrives rather than appearing.
 *
 * Over this window it swells past its resting size and settles back, the bloom
 * flares and fades, and the interior churns fast then slows — like something
 * being switched on. It matters because the overlay is summoned: appearing
 * fully-formed reads as a screenshot, and a beat of settling reads as a thing
 * waking up.
 */
const ENTRANCE_MS = 900

/**
 * One lobe of the void's outline: how many bumps around the circle, how deep,
 * how fast they travel, and where they start.
 *
 * Summed together these give a closed curve that never repeats, because the
 * speeds share no common factor. Three harmonics is the useful minimum — two
 * reads as a wobbling ellipse, and above four the shape stops being readable
 * at 52 pixels and just looks noisy.
 */
interface Harmonic {
  lobes: number
  depth: number
  speed: number
  phase: number
}

const VOID_HARMONICS: Harmonic[] = [
  { lobes: 2, depth: 0.13, speed: 0.47, phase: 0 },
  { lobes: 3, depth: 0.09, speed: -0.31, phase: 2.1 },
  { lobes: 5, depth: 0.05, speed: 0.19, phase: 4.3 }
]

/** The halo runs its own harmonics so the two outlines never move together. */
const HALO_HARMONICS: Harmonic[] = [
  { lobes: 2, depth: 0.11, speed: -0.37, phase: 1.4 },
  { lobes: 4, depth: 0.07, speed: 0.23, phase: 3.2 },
  { lobes: 3, depth: 0.05, speed: -0.53, phase: 0.6 }
]

/** Enough segments that the curve reads as smooth at this size, and no more. */
const OUTLINE_POINTS = 56

/**
 * A closed blob whose radius varies with angle and time.
 *
 * This is the whole trick: rather than moving a fixed shape, the shape itself
 * is rebuilt every frame from a sum of travelling waves. Because each harmonic
 * has its own speed and direction, the bumps drift around the outline at
 * different rates and the form appears to be squashed from a different side
 * each time.
 */
function blobPath(radius: number, time: number, amplitude: number, waves: Harmonic[]): string {
  let d = ''
  for (let i = 0; i <= OUTLINE_POINTS; i++) {
    const angle = (i / OUTLINE_POINTS) * Math.PI * 2
    let r = radius
    for (const wave of waves) {
      r += radius * wave.depth * amplitude * Math.sin(wave.lobes * angle + wave.speed * time + wave.phase)
    }
    const x = 50 + Math.cos(angle) * r
    const y = 50 + Math.sin(angle) * r
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }
  return `${d}Z`
}

/**
 * Where each mote sits at a given moment.
 *
 * Lissajous figures, not orbits. A circle is the one path where motion looks
 * mechanical, because the speed and the curvature never change — that is what
 * made the previous interior feel like it was running on rails. Giving each
 * mote a different ratio of horizontal to vertical frequency makes each trace
 * a different closed figure (a lens, a figure-eight, a trefoil) while sharing
 * the same underlying tempo, so they drift at one speed along three genuinely
 * different paths.
 */
const MOTES = [
  { fx: 2, fy: 3, phase: 0, reach: 15, radius: 11, opacity: 0.85 },
  { fx: 3, fy: 2, phase: 1.7, reach: 17, radius: 8, opacity: 0.7 },
  { fx: 1, fy: 2, phase: 3.4, reach: 12, radius: 13, opacity: 0.5 }
]

export function Orb({ state, searching = false, levelRef, size = 52 }: OrbProps) {
  const mode = orbModeFor(state, searching)
  const rootRef = useRef<HTMLDivElement>(null)
  const bloomRef = useRef<HTMLDivElement>(null)
  const voidRef = useRef<SVGPathElement>(null)
  const haloRef = useRef<SVGPathElement>(null)
  const moteRefs = useRef<SVGGElement[]>([])
  /**
   * Fixed at mount, not at each effect run. The effect re-runs on every state
   * change, so a local start time replayed the whole arrival on idle ->
   * listening -> thinking -> speaking. The card unmounts when the overlay
   * hides, so mount is exactly "when Nimbus opens".
   */
  const mountedAt = useRef(performance.now())

  useEffect(() => {
    let frame = 0
    // Smoothed: raw level is jittery frame to frame, and following it exactly
    // makes the sphere vibrate instead of breathe.
    let smoothed = 0
    const startedAt = mountedAt.current

    /** Overshoot then settle: fast out of the gate, easing into rest. */
    const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)

    const tick = (now: number): void => {
      const level = Math.max(0, Math.min(1, levelRef.current ?? 0))
      smoothed += (level - smoothed) * 0.16

      const seconds = (now - startedAt) / 1000
      // A slow sine keeps it alive when nothing is being said, so it never
      // looks frozen or broken.
      const breath = 0.5 + 0.5 * Math.sin(seconds * 0.9)

      // 0 -> 1 across the entrance, then pinned at 1 forever after.
      const intro = Math.min(1, (now - startedAt) / ENTRANCE_MS)
      const eased = easeOut(intro)
      // Swells past resting size at the midpoint and comes back down.
      const arrival = Math.sin(intro * Math.PI) * 0.22

      // The sphere reacts to whichever is speaking — the microphone while
      // listening, and its own voice while talking, both through levelRef.
      const active = state === 'listening' || state === 'speaking'
      const swell = active ? smoothed * VOICE_SWELL : 0

      // A radar ping while searching: a sharp pulse that reaches out and
      // recedes. Squaring the sine keeps it resting near zero between pings
      // instead of oscillating symmetrically, which is what makes it read as
      // a beat rather than a wobble.
      const ping = searching ? Math.pow(Math.max(0, Math.sin(seconds * 2.4)), 3) : 0

      if (rootRef.current) {
        rootRef.current.style.transform = `scale(${(0.72 + eased * 0.28 + arrival) * (1 + swell + breath * 0.015)})`
        rootRef.current.style.opacity = `${Math.min(1, intro * 2.2)}`
      }
      if (bloomRef.current) {
        // Flares during the entrance, then settles to the resting breath.
        bloomRef.current.style.opacity = `${0.34 + breath * 0.14 + smoothed * 0.45 + arrival * 1.6 + ping * 0.2}`
        bloomRef.current.style.transform = `scale(${1.1 + swell * 1.6 + breath * 0.05 + arrival + ping * 0.25})`
      }

      // The interior's clock. Thinking churns it faster without needing a
      // spinner, searching faster again — reaching out reads as more urgent
      // than turning an answer over — and the entrance runs fast and slows
      // into place.
      const churnRate = searching ? 3.6 : state === 'thinking' ? 2.6 : 1
      const churn = seconds * churnRate + (1 - eased) * 9

      // How far from round the void is allowed to get. It is never perfectly
      // round — a still shape would look broken — but a voice pushes it much
      // further out of shape, which is what makes it look like it is speaking
      // rather than merely lit.
      // Bounded so the outline stays inside the glass at full voice: the
      // harmonics sum to 0.27, so peak radius is radius * (1 + 0.27 * this),
      // and r=37 is the clip.
      const distortion = 0.55 + breath * 0.2 + smoothed * 1.1 + ping * 0.5
      // It swells as it talks, so it grows into the glass and pulls back.
      // The ping also reaches the bloom, not just the void, so the pulse
      // feels like it leaves the sphere rather than churning inside it.
      const voidRadius = 19 + smoothed * 4.5 + breath * 0.8 + ping * 1.5

      voidRef.current?.setAttribute('d', blobPath(voidRadius, churn, distortion, VOID_HARMONICS))
      haloRef.current?.setAttribute(
        'd',
        // Slightly larger and on its own harmonics, so the glowing edge
        // separates from the dark mass instead of tracing it. Kept deliberately
        // rounder and tighter than the void: at full voice a wider one runs
        // past r=37 and the glow disappears behind the rim exactly when the
        // orb is at its liveliest.
        blobPath(voidRadius + 4 + smoothed, churn, distortion * 0.6, HALO_HARMONICS)
      )

      moteRefs.current.forEach((mote, i) => {
        if (!mote) return
        const { fx, fy, phase, reach } = MOTES[i]
        // Same `churn` for every mote — one tempo — but different frequency
        // ratios, so each traces a different figure.
        const x = Math.sin(fx * churn * 0.6 + phase) * reach * (1 + smoothed * 0.35)
        const y = Math.sin(fy * churn * 0.6 + phase * 1.3) * reach * 0.8 * (1 + smoothed * 0.35)
        // Brightest as it crosses the middle, faint at the edges, which sells
        // it as something moving through the glass rather than across it.
        const depth = 0.55 + 0.45 * Math.cos(fx * churn * 0.6 + phase)
        mote.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${(0.75 + depth * 0.5 + smoothed * 0.3).toFixed(3)})`
        mote.style.opacity = `${(MOTES[i].opacity * depth).toFixed(3)}`
      })

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef, state, searching])

  const [core, mid, rim] = ORB_PALETTE[mode]
  const id = `orb-${mode}`

  return (
    <div
      className="relative shrink-0 self-start"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* Bloom spilling onto whatever is behind the card. Sits outside the
          sphere's bounds on purpose — light does not stop at the object. */}
      <div
        ref={bloomRef}
        className="pointer-events-none absolute -inset-[45%] rounded-full blur-xl will-change-transform"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${rim} 0%, transparent 68%)`,
          transition: 'background 500ms ease'
        }}
      />

      <div ref={rootRef} className="absolute inset-0 will-change-transform">
        <svg viewBox="0 0 100 100" className="h-full w-full overflow-visible">
          <defs>
            {/* Glass body: dark at the centre, lifting toward the edge. */}
            <radialGradient id={`${id}-glass`} cx="42%" cy="36%" r="72%">
              <stop offset="0%" stopColor={core} />
              <stop offset="62%" stopColor={core} />
              <stop offset="100%" stopColor={mid} />
            </radialGradient>

            {/* Rim: bright through the lower-right arc, fading to nothing at
                the top-left, which is where a single light source puts it. */}
            <linearGradient id={`${id}-rim`} x1="12%" y1="8%" x2="88%" y2="94%">
              <stop offset="0%" stopColor={rim} stopOpacity="0.15" />
              <stop offset="45%" stopColor={rim} stopOpacity="0.55" />
              <stop offset="72%" stopColor="#ffffff" stopOpacity="0.95" />
              <stop offset="100%" stopColor={rim} stopOpacity="0.5" />
            </linearGradient>

            {/* The void itself: near-black at the centre so it reads as an
                absence, lifting only at its own edge. */}
            <radialGradient id={`${id}-void`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#000000" stopOpacity="0.92" />
              <stop offset="55%" stopColor={core} stopOpacity="0.8" />
              <stop offset="100%" stopColor={mid} stopOpacity="0.35" />
            </radialGradient>

            <radialGradient id={`${id}-mote`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
              <stop offset="35%" stopColor={rim} stopOpacity="0.65" />
              <stop offset="100%" stopColor={rim} stopOpacity="0" />
            </radialGradient>

            {/* Softens the motes so they read as light inside glass rather
                than as circles drawn on top of it. */}
            <filter id={`${id}-soft`} x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.2" />
            </filter>
            {/* Gentler: enough to make the void's edge glow without losing the
                outline that all the movement lives in. */}
            <filter id={`${id}-edge`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.1" />
            </filter>

            <clipPath id={`${id}-clip`}>
              <circle cx="50" cy="50" r="37" />
            </clipPath>
          </defs>

          <circle cx="50" cy="50" r="37" fill={`url(#${id}-glass)`} />

          {/* Interior. Blended additively so crossings brighten. */}
          <g clipPath={`url(#${id}-clip)`} style={{ mixBlendMode: 'screen' }}>
            {MOTES.map((mote, i) => (
              <g
                key={i}
                ref={(node) => {
                  if (node) moteRefs.current[i] = node
                }}
                style={{ transformOrigin: '50px 50px', willChange: 'transform, opacity' }}
              >
                <circle
                  cx="50"
                  cy="50"
                  r={mote.radius}
                  fill={`url(#${id}-mote)`}
                  filter={`url(#${id}-soft)`}
                />
              </g>
            ))}

            {/* The halo: the void's glowing edge, on its own harmonics so it
                breathes against the dark mass rather than with it. */}
            <path
              ref={haloRef}
              fill="none"
              stroke={rim}
              strokeWidth="1.5"
              strokeOpacity="0.55"
              filter={`url(#${id}-edge)`}
              style={{ transition: 'stroke 500ms ease' }}
            />
          </g>

          {/* The void, drawn over the glass but under the rim. Not blended:
              it has to actually darken what is behind it, or it is a glow
              rather than an absence. */}
          <g clipPath={`url(#${id}-clip)`}>
            <path
              ref={voidRef}
              fill={`url(#${id}-void)`}
              stroke={rim}
              strokeWidth="0.9"
              strokeOpacity="0.85"
              filter={`url(#${id}-edge)`}
              style={{ transition: 'stroke 500ms ease' }}
            />
          </g>

          {/* Rim last, over the interior — the edge is the brightest thing. */}
          <circle cx="50" cy="50" r="37" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="1.6" />

          {/* A short specular clip where the light source hits, which is what
              makes the surface read as glass rather than as a hole. */}
          <path
            d="M28,26 A 32 32 0 0 1 52,15"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.5"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  )
}
