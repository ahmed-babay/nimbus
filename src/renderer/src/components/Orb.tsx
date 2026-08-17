import { useEffect, useRef, type RefObject } from 'react'
import type { NimbusState } from '@shared/types'

interface OrbProps {
  state: NimbusState
  /** Live microphone level, 0..1, updated outside React. */
  levelRef: RefObject<number>
  /** Overrides the default size, in pixels. */
  size?: number
}

/**
 * The voice orb: a glass sphere with light moving inside it.
 *
 * Built to a reference rather than invented — a dark translucent globe, a
 * bright crescent rim where the light catches the edge, ribbons of blue
 * curling through the interior, and a soft bloom spilling onto the background.
 * The two attempts before this were a blocky equaliser and then a dot with a
 * ring around it, and both failed the same way: they looked *drawn* rather
 * than lit.
 *
 * What actually sells it, in order of how much each matters:
 *
 *  1. **The rim, not the fill.** A glass ball is dark in the middle and bright
 *     only where the surface turns away from you. Lighting the centre is what
 *     makes an orb read as a button.
 *  2. **Additive blending.** The ribbons use `screen`, so where they cross
 *     they brighten instead of stacking opaquely, which is how light behaves
 *     and paint does not.
 *  3. **Different speeds.** Three ribbons at 1x, -0.62x and 0.38x never repeat
 *     the same arrangement, so it looks like motion rather than a loop.
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
 * flares and fades, and the interior spins fast then slows — like something
 * being switched on. It matters because the overlay is summoned: appearing
 * fully-formed reads as a screenshot, and a beat of settling reads as a thing
 * waking up.
 */
const ENTRANCE_MS = 900

/** Per-state hues, as [core, mid, rim] — dark to bright. */
const PALETTE: Record<NimbusState, [string, string, string]> = {
  idle: ['#101426', '#2a3355', '#6e7bff'],
  listening: ['#0d1a33', '#1e4c8a', '#7fb2ff'],
  thinking: ['#141029', '#3b2f7a', '#a5aeff'],
  speaking: ['#08202b', '#136a86', '#63d8f5'],
  playing: ['#0b2418', '#166b4a', '#4ec99a']
}

export function Orb({ state, levelRef, size = 52 }: OrbProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const bloomRef = useRef<HTMLDivElement>(null)
  const ribbonsRef = useRef<SVGGElement[]>([])
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
      // Thinking spins the interior up without needing a spinner; the entrance
      // spins faster still and slows into place.
      const rate = (state === 'thinking' ? 42 : 13) + (1 - eased) * 220

      if (rootRef.current) {
        rootRef.current.style.transform = `scale(${(0.72 + eased * 0.28 + arrival) * (1 + swell + breath * 0.015)})`
        rootRef.current.style.opacity = `${Math.min(1, intro * 2.2)}`
      }
      if (bloomRef.current) {
        // Flares during the entrance, then settles to the resting breath.
        bloomRef.current.style.opacity = `${0.34 + breath * 0.14 + smoothed * 0.45 + arrival * 1.6}`
        bloomRef.current.style.transform = `scale(${1.1 + swell * 1.6 + breath * 0.05 + arrival})`
      }

      // Incommensurate speeds, one reversed: the three never line up twice, so
      // the interior reads as flowing rather than as a rotating image.
      const speeds = [1, -0.62, 0.38]
      ribbonsRef.current.forEach((group, i) => {
        if (!group) return
        group.style.transform = `rotate(${seconds * rate * speeds[i]}deg)`
      })

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef, state])

  const [core, mid, rim] = PALETTE[state]
  const id = `orb-${state}`

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

            <linearGradient id={`${id}-ribbon-a`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={rim} stopOpacity="0" />
              <stop offset="50%" stopColor="#ffffff" stopOpacity="0.85" />
              <stop offset="100%" stopColor={rim} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${id}-ribbon-b`} x1="100%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={rim} stopOpacity="0" />
              <stop offset="55%" stopColor={rim} stopOpacity="0.9" />
              <stop offset="100%" stopColor={rim} stopOpacity="0" />
            </linearGradient>

            {/* Softens the ribbons so they read as light inside glass rather
                than as lines drawn on top of it. */}
            <filter id={`${id}-soft`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.6" />
            </filter>

            <clipPath id={`${id}-clip`}>
              <circle cx="50" cy="50" r="37" />
            </clipPath>
          </defs>

          <circle cx="50" cy="50" r="37" fill={`url(#${id}-glass)`} />

          {/* Interior. Blended additively so crossings brighten. */}
          <g clipPath={`url(#${id}-clip)`} style={{ mixBlendMode: 'screen' }}>
            <g
              ref={(node) => {
                if (node) ribbonsRef.current[0] = node
              }}
              style={{ transformOrigin: '50px 50px' }}
            >
              <path
                d="M14,58 C30,34 60,26 84,42 C66,54 42,68 14,58 Z"
                fill={`url(#${id}-ribbon-a)`}
                filter={`url(#${id}-soft)`}
                opacity="0.75"
              />
            </g>
            <g
              ref={(node) => {
                if (node) ribbonsRef.current[1] = node
              }}
              style={{ transformOrigin: '50px 50px' }}
            >
              <path
                d="M18,66 C36,50 64,46 86,58 C68,74 40,80 18,66 Z"
                fill={`url(#${id}-ribbon-b)`}
                filter={`url(#${id}-soft)`}
                opacity="0.6"
              />
            </g>
            <g
              ref={(node) => {
                if (node) ribbonsRef.current[2] = node
              }}
              style={{ transformOrigin: '50px 50px' }}
            >
              <path
                d="M22,44 C40,28 62,32 80,50"
                fill="none"
                stroke={`url(#${id}-ribbon-a)`}
                strokeWidth="7"
                strokeLinecap="round"
                filter={`url(#${id}-soft)`}
                opacity="0.55"
              />
            </g>
          </g>

          {/* Rim last, over the interior — the edge is the brightest thing. */}
          <circle
            cx="50"
            cy="50"
            r="37"
            fill="none"
            stroke={`url(#${id}-rim)`}
            strokeWidth="1.6"
          />

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
