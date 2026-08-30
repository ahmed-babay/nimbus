import { useEffect, useRef, type RefObject } from 'react'
import type { NimbusState } from '@shared/types'
import { STATE_THEME, orbModeFor, type OrbMode } from '../lib/state-theme'
import { createStormOrb, stormPalette, type OrbPalette, type StormOrb } from '../lib/storm-orb'

interface OrbProps {
  state: NimbusState
  /**
   * Increments whenever Nimbus answers.
   *
   * The discharge used to key off entering the 'speaking' state, which never
   * happens when spoken answers are muted — so turning the voice off silently
   * removed the animation too. Answering is the event worth marking; saying it
   * aloud is only one way of doing it.
   */
  answerSeq?: number
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
  /**
   * Crop to the sphere and drop the outer atmosphere. The idle corner chip is
   * a tiny square window; without this the halo is clipped into a square and
   * the sphere sits in a ring inside it.
   */
  tight?: boolean
}

/**
 * The voice orb: a contained storm.
 *
 * The same object as the core on the Nimbus website, and for the same reason —
 * a product whose whole surface is one glowing sphere cannot afford for the
 * sphere in the app to be a different sphere. The storm itself lives in
 * `lib/storm-orb.ts`; everything here is about what Nimbus is *doing*.
 *
 * **Driven outside React.** The microphone level updates ~60 times a second;
 * routing that through state would re-render the whole card every frame, which
 * is why the level arrives as a ref and this drives the canvas directly.
 */

/** How far the sphere swells at full voice. Small: this is a meter, not a toy. */
const VOICE_SWELL = 0.16

/**
 * The sphere arrives rather than appearing.
 *
 * Over this window it swells past its resting size and settles back, and the
 * storm runs hot and calms down — like something being switched on. It matters
 * because the overlay is summoned: appearing fully-formed reads as a
 * screenshot, and a beat of settling reads as a thing waking up.
 */
const ENTRANCE_MS = 900

/** How long light takes to gather. Long enough to read, short enough to not gate the answer. */
const CHARGE_MS = 900

/** The discharge: flash, then the wave crossing the panel. */
const RELEASE_MS = 1600

/**
 * How hard the storm runs in each state.
 *
 * Idle is banked rather than dead — a still orb reads as broken — and the two
 * working states are the loud ones, with searching hottest because reaching
 * out over the network is the more urgent of the two. The states that follow a
 * voice get most of their energy from the voice instead, so the number here is
 * only the floor they sit at while nothing is being said.
 */
const ENERGY: Record<OrbMode, number> = {
  idle: 0.44,
  listening: 0.56,
  thinking: 0.78,
  searching: 0.98,
  speaking: 0.6,
  playing: 0.66
}

/** Which states take their energy from `levelRef` rather than sitting at a floor. */
function followsVoice(state: NimbusState): boolean {
  return state === 'listening' || state === 'speaking'
}

/** Eased overshoot: fast out of the gate, settling into rest. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Colours move between states rather than cutting, so a change of mode reads as one thing turning into another. */
function approachPalette(current: OrbPalette, target: OrbPalette, t: number): void {
  const keys = ['beam', 'arc', 'core', 'shell'] as const
  for (const key of keys) {
    const c = current[key]
    const n = target[key]
    c[0] = lerp(c[0], n[0], t)
    c[1] = lerp(c[1], n[1], t)
    c[2] = lerp(c[2], n[2], t)
  }
}

function cloneOrbPalette(p: OrbPalette): OrbPalette {
  return {
    beam: [...p.beam],
    arc: [...p.arc],
    core: [...p.core],
    shell: [...p.shell]
  }
}

export function Orb({
  state,
  searching = false,
  answerSeq = 0,
  levelRef,
  size = 52,
  tight = false
}: OrbProps) {
  const mode = orbModeFor(state, searching)
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stormRef = useRef<StormOrb | null>(null)

  /**
   * Fixed at mount, not at each effect run. The effect re-runs on every state
   * change, so a local start time replayed the whole arrival on idle ->
   * listening -> thinking -> speaking. The card unmounts when the overlay
   * hides, so mount is exactly "when Nimbus opens".
   */
  const mountedAt = useRef(performance.now())

  /**
   * When the turn last changed hands.
   *
   * A question does not "load". It is taken in, held, and answered:
   *
   *   GATHERING  streamers strike inward and the core fills
   *   HOLDING    the charge sits there under tension while Nimbus works
   *   DISCHARGE  the core blows out and the storm fires outward
   *
   * Gathering is deliberately not a spinner, a ring, or a pulse of opacity.
   * All three say "wait"; none of them say "I have your message". What says it
   * is matter arriving from off-screen and going *in*, because inward motion
   * is something only a receiver does.
   */
  const chargeAt = useRef(0)
  const releaseAt = useRef(0)

  /** Live so the frame loop can read them without being torn down and rebuilt. */
  const stateRef = useRef(state)
  const modeRef = useRef(mode)
  stateRef.current = state
  modeRef.current = mode

  /**
   * The question has been handed over — start drawing light in.
   *
   * Keyed to 'thinking', which is the one thing both routes into a turn have
   * in common: the voice path sets it once a transcript is final, and the text
   * box sets it on submit. Anything keyed to the microphone would have left
   * typed questions with no acknowledgement at all.
   */
  useEffect(() => {
    if (state !== 'thinking') return
    chargeAt.current = performance.now()
    releaseAt.current = 0
  }, [state])

  /**
   * One discharge per answer, spoken or not.
   *
   * Keyed to the answer rather than the 'speaking' state, because that state
   * never arrives when the voice is muted — so muting the voice silently
   * removed the animation too.
   */
  useEffect(() => {
    if (answerSeq === 0) return
    releaseAt.current = performance.now()
    chargeAt.current = 0
  }, [answerSeq])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    // The sphere is sized as a fraction of the canvas because a canvas cannot
    // paint outside itself: when the atmosphere is drawn it needs most of the
    // bitmap, and when it is not the sphere can have nearly all of it.
    const storm = createStormOrb(canvas, { fill: tight ? 0.72 : 0.42, bare: tight })
    if (!storm) return
    stormRef.current = storm
    storm.resize()

    const observer = new ResizeObserver(() => storm.resize())
    observer.observe(canvas)

    const palette = cloneOrbPalette(stormPalette(STATE_THEME[modeRef.current].orb))
    // Recomputed only when the mode actually changes: `stormPalette` allocates,
    // and doing it every frame is four arrays a frame for a value that changes
    // a handful of times a session.
    let target = stormPalette(STATE_THEME[modeRef.current].orb)
    let targetMode = modeRef.current
    const startedAt = mountedAt.current

    let frame = 0
    let last = 0
    // Smoothed: raw level is jittery frame to frame, and following it exactly
    // makes the sphere vibrate instead of breathe.
    let smoothed = 0

    const build = (now: number, dt: number): void => {
      const raw = levelRef.current
      const level = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw as number)) : 0
      smoothed += (level - smoothed) * 0.16
      // Exponential smoothing carries state forward frame to frame, so one
      // non-finite reading here (a stalled AudioContext, a device hiccup)
      // would otherwise poison every frame after it rather than just the one
      // it happened on.
      if (!Number.isFinite(smoothed)) smoothed = 0

      const seconds = (now - startedAt) / 1000
      // A slow sine keeps it alive when nothing is being said, so it never
      // looks frozen or broken.
      const breath = 0.5 + 0.5 * Math.sin(seconds * 0.9)

      // 0 -> 1 across the entrance, then pinned at 1 forever after.
      const intro = Math.min(1, (now - startedAt) / ENTRANCE_MS)
      const eased = easeOut(intro)
      // Swells past resting size at the midpoint and comes back down.
      const arrival = Math.sin(intro * Math.PI) * 0.22

      const current = stateRef.current

      // --- the turn: gather, hold, discharge ------------------------------
      const sinceRelease = releaseAt.current === 0 ? -1 : now - releaseAt.current
      const releasing = sinceRelease >= 0 && sinceRelease <= RELEASE_MS
      const release = releasing ? sinceRelease / RELEASE_MS : 0

      // A charge is only legitimate while Nimbus is actually working on
      // something. Without this a turn that ended in an error — which goes
      // straight back to idle and never increments the answer — would leave
      // the sphere holding a charge it is never going to spend, contracted and
      // lit, forever.
      if (!releasing && current !== 'thinking') chargeAt.current = 0
      const charge =
        chargeAt.current === 0 ? 0 : Math.min(1, (now - chargeAt.current) / CHARGE_MS)

      // The flash. Very short and very bright, front-loaded into the first
      // eighth of the discharge — a discharge is not a fade-in.
      const flash = releasing ? Math.pow(Math.max(0, 1 - release / 0.12), 2) : 0

      // The sphere reacts to whichever is speaking — the microphone while
      // listening, and its own voice while talking, both through levelRef.
      const voice = followsVoice(current) ? smoothed : 0
      const swell = voice * VOICE_SWELL

      if (targetMode !== modeRef.current) {
        targetMode = modeRef.current
        target = stormPalette(STATE_THEME[targetMode].orb)
      }
      approachPalette(palette, target, Math.min(1, dt / 260))

      storm.frame(
        {
          palette,
          // The entrance runs hot and calms into place, so switching on looks
          // like a surge rather than a fade.
          intensity:
            ENERGY[modeRef.current] +
            voice * 0.5 +
            charge * 0.22 +
            (1 - eased) * 0.5 +
            breath * 0.04,
          charge,
          release,
          flash,
          level: smoothed,
          scale: (0.72 + eased * 0.28 + arrival) * (1 + swell + breath * 0.015)
        },
        dt,
        now
      )
    }

    const publishShock = (now: number): void => {
      // What the discharge does to the rest of the panel.
      //
      // Published on the document element rather than on this component,
      // because a custom property only reaches descendants and the card is
      // this orb's *parent* — everything the wave should cross is a sibling.
      // `--orb-shock` is how hard it is hitting, `--orb-wave` is how far it has
      // got, and the card uses both to sweep a band of real distortion over
      // its own contents.
      const sinceRelease = releaseAt.current === 0 ? -1 : now - releaseAt.current
      const releasing = sinceRelease >= 0 && sinceRelease <= RELEASE_MS
      const release = releasing ? sinceRelease / RELEASE_MS : 0
      const shove = releasing ? Math.sin(Math.pow(release, 0.7) * Math.PI) * (1 - release) : 0
      const root = document.documentElement.style
      root.setProperty('--orb-shock', shove.toFixed(4))
      root.setProperty('--orb-wave', releasing ? release.toFixed(4) : '0')
    }

    const tick = (now: number): void => {
      // Scheduled first, before this frame's work runs, so the loop survives
      // a bad frame. It used to run last: if `build` threw, the sphere and the
      // response-wave effect (`publishShock`, further down) both froze at
      // whatever they last drew, because the next `requestAnimationFrame` call
      // never happened.
      frame = requestAnimationFrame(tick)

      if (!last) last = now
      // Clamped so a stall does not advance the storm by a whole second at once.
      const dt = Math.min(64, now - last)
      last = now

      try {
        build(now, dt)
        publishShock(now)
        if (rootRef.current) {
          rootRef.current.style.opacity = `${Math.min(1, ((now - startedAt) / ENTRANCE_MS) * 2.2)}`
        }
      } catch (err) {
        // The storm engine sanitizes its own inputs, so this should not fire —
        // but a canvas gradient throws hard on a non-finite value, and this is
        // the backstop for anything that finds a gap in that sanitizing.
        // Skipping one frame is a flicker; freezing forever is what this
        // exists to rule out.
        console.warn('[orb] frame failed, skipping', err)
      }
    }

    if (calm) {
      // One considered frame, redrawn only when the mode changes.
      if (rootRef.current) rootRef.current.style.opacity = '1'
      storm.still({
        palette,
        intensity: ENERGY[modeRef.current],
        charge: 0,
        release: 0,
        flash: 0,
        level: 0,
        scale: 1
      })
    } else {
      frame = requestAnimationFrame(tick)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      stormRef.current = null
    }
    // Deliberately not keyed to the mode. The storm is a running simulation:
    // rebuilding it on every state change would reset every filament and bolt
    // mid-flight, and the colour is followed frame by frame instead.
  }, [levelRef, tight])

  /**
   * With motion reduced there is no loop to pick the new colour up, so the one
   * frame is drawn again whenever the mode changes.
   */
  useEffect(() => {
    const storm = stormRef.current
    if (!storm) return
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    storm.still({
      palette: stormPalette(STATE_THEME[mode].orb),
      intensity: ENERGY[mode],
      charge: 0,
      release: 0,
      flash: 0,
      level: 0,
      scale: 1
    })
  }, [mode])

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/*
        The canvas is larger than the orb's own box when the atmosphere is
        drawn, because a canvas cannot paint outside its bitmap and the halo
        reaches about twice the sphere's radius. The wrapper keeps its nominal
        size in the layout; only the bitmap overhangs.
      */}
      <div
        ref={rootRef}
        className={`pointer-events-none absolute ${tight ? 'inset-0 overflow-hidden rounded-full' : '-inset-[45%]'}`}
        style={{ opacity: 0 }}
      >
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
    </div>
  )
}
