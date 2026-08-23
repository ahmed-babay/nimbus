import { useEffect, useRef, type RefObject } from 'react'
import type { NimbusState } from '@shared/types'
import { STATE_THEME, orbModeFor } from '../lib/state-theme'

interface OrbProps {
  state: NimbusState
  /**
   * Increments whenever Nimbus answers.
   *
   * The swell used to key off entering the 'speaking' state, which never
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
   * Crop to the glass sphere and drop the outer bloom. The idle corner chip
   * is a tiny square window; without this the bloom is clipped into a square
   * and the sphere sits in a ring inside it.
   */
  tight?: boolean
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
 * Per-state hues, as [core, mid, rim] — dark to bright.
 *
 * Shared with the panel chrome rather than kept here, so the card and the
 * sphere cannot end up disagreeing about what state Nimbus is in.
 */
const PALETTE = STATE_THEME

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

/**
 * The turn, as the orb tells it.
 *
 * A question does not "load". It is taken in, held, and answered, and the orb
 * is meant to be the place that happens rather than a widget reporting on it:
 *
 *   ACCUMULATING  light is drawn in from outside and gathers in the core
 *   HOLDING       the charge sits there under tension while Nimbus works
 *   RELEASING     the core lets go and the energy leaves as expanding waves
 *   RESPONDING    back to the living resting state, now reacting to the voice
 *
 * Accumulation is deliberately not a spinner, a ring, or a pulse of opacity.
 * All three say "wait"; none of them say "I have your message". What says it
 * is matter arriving from off-screen and going *in*, because inward motion is
 * something only a receiver does.
 */

/** How long light takes to gather. Long enough to read, short enough to not gate the answer. */
const CHARGE_MS = 900

/** The release: flash, then the waves crossing the panel. */
const RELEASE_MS = 1600

/**
 * Motes of light falling into the sphere.
 *
 * They spiral rather than fall straight. A straight radial line reads as a
 * diagram of convergence; a path that curls as it accelerates reads as
 * something being *pulled*, which is the difference between showing the idea
 * and giving the feeling of it. Staggered starts so they arrive as a shower
 * rather than a synchronised ring, which would just be a closing iris.
 */
const SPARKS = [
  { angle: 0.4, delay: 0.0, curl: 1.5, reach: 165, len: 34 },
  { angle: 1.9, delay: 0.08, curl: -1.2, reach: 150, len: 28 },
  { angle: 3.1, delay: 0.04, curl: 1.8, reach: 172, len: 38 },
  { angle: 4.4, delay: 0.16, curl: -1.6, reach: 158, len: 31 },
  { angle: 5.6, delay: 0.1, curl: 1.3, reach: 143, len: 26 },
  { angle: 2.5, delay: 0.22, curl: -1.9, reach: 180, len: 42 },
  { angle: 0.9, delay: 0.3, curl: 1.1, reach: 136, len: 24 },
  { angle: 4.9, delay: 0.26, curl: -1.4, reach: 162, len: 33 },
  { angle: 3.7, delay: 0.36, curl: 1.7, reach: 147, len: 29 }
]

/**
 * The waves that leave on release.
 *
 * Three, staggered, so it reads as one event propagating rather than three
 * separate rings — and drawn with the same harmonic machinery as the void, so
 * their outlines breathe instead of being perfect circles. That is the whole
 * reason they do not look like a radar sweep: a sonar ping is a circle, and
 * nothing alive is.
 */
const RING_DELAYS = [0, 0.13, 0.27]

/**
 * How far the waves travel, in viewBox units.
 *
 * Large, because the viewBox is 100 across and renders into 52 pixels — so a
 * unit is about half a pixel, and a reach that looked generous at 190 covered
 * a fifth of the card and stopped. The release is supposed to reach the
 * interface, so it has to be sized against the panel, not the sphere.
 */
const RING_REACH = 780

/** Enough segments that the curve reads as smooth at this size, and no more. */
const OUTLINE_POINTS = 56

/**
 * How hard the surface shakes with the sound, at full level.
 *
 * Well under the release wave's 13: the wave is an event and is allowed to be
 * violent, whereas this runs for the whole of a spoken answer and has to sit
 * behind reading the text without pulling the eye off it.
 */
const VOICE_RIPPLE = 4.5

/**
 * A finer, tighter field than the release wave's.
 *
 * Sound shakes a surface in short ripples; a swell rolls in long ones. Held
 * constant while speaking so the turbulence is generated once and only the
 * displacement strength changes — see the note where this is used.
 */
const VOICE_RIPPLE_FREQUENCY = 0.085

/** How far the ripples have lengthened, 0..1 — long swell rather than chop. */
function spreadFreq(release: number, releasing: boolean): number {
  return releasing ? 1 - Math.pow(1 - release, 2) : 0
}

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
  /**
   * The waves that leave the sphere. Three layers each — wash, band, crest —
   * because a single stroke can only ever look like a line.
   */
  const ringGlowRefs = useRef<SVGPathElement[]>([])
  const ringBandRefs = useRef<SVGPathElement[]>([])
  const ringCrestRefs = useRef<SVGPathElement[]>([])
  /** The turbulence that makes the surface behave like water. */
  const turbRef = useRef<SVGFETurbulenceElement>(null)
  const dispRef = useRef<SVGFEDisplacementMapElement>(null)
  /**
   * The sphere, so the water filter can be taken off it entirely when nothing
   * is disturbing it. feTurbulence is regenerated on every repaint, and the
   * void's outline repaints every frame — leaving it attached would mean
   * paying for noise the whole time the overlay is open, to displace by zero.
   */
  const waterGroupRef = useRef<SVGGElement>(null)
  /** What was last written to the filter, so unchanged values are not rewritten. */
  const lastFreq = useRef(-1)
  const lastSeed = useRef('')
  /** Light falling inward while the question is being taken in. */
  const sparkRefs = useRef<SVGPathElement[]>([])
  const sparkHaloRefs = useRef<SVGPathElement[]>([])
  const sparkGlowRefs = useRef<SVGCircleElement[]>([])
  const sparkHeadRefs = useRef<SVGCircleElement[]>([])
  /** The gathered charge at the centre — bright while held, blinding on release. */
  const coreRef = useRef<SVGCircleElement>(null)
  /** Turned a quarter turn each time so successive waves are not identical. */
  const ringPhase = useRef(0)
  /**
   * When the mode last changed, and what it changed from.
   *
   * The interesting moments in a voice interface are the seams: the instant it
   * stops listening, the instant it starts speaking. Those are exactly the
   * moments the orb was silent about - it simply became a different colour.
   * A ring leaving the sphere marks the transition so it is felt rather than
   * merely noticed.
   */
  const releaseAt = useRef(0)
  const chargeAt = useRef(0)
  const lastMode = useRef(mode)

  useEffect(() => {
    lastMode.current = mode
  }, [mode])

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

  // One release per answer, spoken or not.
  //
  // Keyed to the answer rather than the 'speaking' state, because that state
  // never arrives when the voice is muted - so muting the voice silently
  // removed the animation too.
  useEffect(() => {
    if (answerSeq === 0) return
    releaseAt.current = performance.now()
    chargeAt.current = 0
    // Rotated so the second answer's waves do not land on the first's outline.
    ringPhase.current += 1.7
  }, [answerSeq])

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

      // --- the turn: gather, hold, release --------------------------------
      //
      // `charge` is how much light has been drawn in, 0..1. It runs up over
      // CHARGE_MS and then *stays* at 1 for as long as Nimbus is working, which
      // is the "holding" state — the orb sitting there full rather than
      // cycling. `release` runs 0..1 once the answer lands, and while it does
      // the charge is spent.
      const sinceRelease = releaseAt.current === 0 ? -1 : now - releaseAt.current
      const releasing = sinceRelease >= 0 && sinceRelease <= RELEASE_MS
      const release = releasing ? sinceRelease / RELEASE_MS : 0

      // A charge is only legitimate while Nimbus is actually working on
      // something. Without this a turn that ended in an error — which goes
      // straight back to idle and never increments the answer — would leave
      // the sphere holding a charge it is never going to spend, contracted and
      // lit, forever.
      if (!releasing && state !== 'thinking') chargeAt.current = 0
      const charge = chargeAt.current === 0 ? 0 : Math.min(1, (now - chargeAt.current) / CHARGE_MS)

      // Tension while the charge is held: a fast, shallow tremor that only
      // exists once gathering has finished. Nothing is travelling, but the
      // thing is visibly not at rest — which is what "working on it" looks
      // like without a single rotating element.
      const held = charge >= 1 && !releasing ? 1 : 0
      const tremor = held * Math.sin(seconds * 11) * 0.5 + held * Math.sin(seconds * 17) * 0.3

      // The flash. Very short and very bright, front-loaded into the first
      // eighth of the release — a discharge is not a fade-in.
      const flash = releasing ? Math.pow(Math.max(0, 1 - release / 0.12), 2) : 0

      if (rootRef.current) {
        rootRef.current.style.transform = `scale(${(0.72 + eased * 0.28 + arrival) * (1 + swell + breath * 0.015)})`
        rootRef.current.style.opacity = `${Math.min(1, intro * 2.2)}`
      }
      if (bloomRef.current) {
        // Flares during the entrance, then settles to the resting breath.
        // Charge lifts it steadily as light accumulates; the release blows it
        // out for an instant, which is what makes the discharge feel like it
        // happened to the room and not only to the sphere.
        bloomRef.current.style.opacity = `${0.34 + breath * 0.14 + smoothed * 0.45 + arrival * 1.6 + ping * 0.2 + charge * 0.5 + flash * 1.1}`
        bloomRef.current.style.transform = `scale(${1.1 + swell * 1.6 + breath * 0.05 + arrival + ping * 0.25 + charge * 0.18 + flash * 0.7})`
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
      // Charge smooths the outline as it compresses — the void is being packed
      // in rather than sloshing about — and the tremor puts a fine edge on it
      // while the charge is held.
      const distortion =
        (0.55 + breath * 0.2 + smoothed * 1.1 + ping * 0.5) * (1 - charge * 0.45) +
        Math.abs(tremor) * 0.12 +
        flash * 0.8
      // It swells as it talks, so it grows into the glass and pulls back.
      // The ping also reaches the bloom, not just the void, so the pulse
      // feels like it leaves the sphere rather than churning inside it.
      //
      // Gathering pulls it *in*: the dark mass contracts around the growing
      // core, which is what gives the charge somewhere to go and reads as
      // pressure building. The release lets it fly back out.
      const voidRadius =
        19 + smoothed * 4.5 + breath * 0.8 + ping * 1.5 - charge * 7 + tremor * 0.4 + flash * 6

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

      // Light falling in.
      //
      // Each mote spirals from outside the panel to the core: the radius eases
      // in hard so it *accelerates* as it arrives, and the angle winds forward
      // with the square of progress so the curl tightens near the centre. Both
      // together are what make it read as capture rather than as a line being
      // drawn inward.
      sparkRefs.current.forEach((spark, i) => {
        if (!spark) return
        const { angle, delay, curl, reach, len } = SPARKS[i]
        // Each mote has its own slice of the window, so they shower in.
        const local = charge <= 0 ? -1 : (charge - delay) / (1 - delay)
        if (local <= 0 || local >= 1) {
          spark.style.opacity = '0'
          return
        }
        // Cubic: slow while distant, quick at the end.
        const eased = Math.pow(local, 2.6)
        const r = reach * (1 - eased)
        const a = angle + curl * eased * eased + seconds * 0.15
        // The trail is where the mote just came from, so it lies along its own
        // path rather than pointing at the centre.
        // *Behind* the head — where it has just come from, which is further
        // out — and on the same easing, or the streak stops lying along the
        // curve it is supposed to have travelled.
        const tail = Math.max(0, local - len / reach)
        const easedTail = Math.pow(tail, 2.6)
        const rt = reach * (1 - easedTail)
        const at = angle + curl * easedTail * easedTail + seconds * 0.15
        const x = 50 + Math.cos(a) * r
        const y = 50 + Math.sin(a) * r
        const xt = 50 + Math.cos(at) * rt
        const yt = 50 + Math.sin(at) * rt
        // Curved through a control point offset along the sweep, so the streak
        // bends the way the path does.
        const cx = 50 + Math.cos((a + at) / 2) * ((r + rt) / 2) * 1.06
        const cy = 50 + Math.sin((a + at) / 2) * ((r + rt) / 2) * 1.06
        spark.setAttribute(
          'd',
          `M${xt.toFixed(1)},${yt.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`
        )
        // Fades in from nothing and dims as it enters the glass, so it looks
        // absorbed rather than stopping dead at the rim.
        const near = Math.max(0, 1 - r / 42)
        const alpha = Math.min(1, local * 5) * (1 - near * 0.75)
        // Brightens as it accelerates inward, so the last stretch before it is
        // swallowed is the most intense part of the journey.
        const heat = 0.35 + local * 0.65
        spark.style.opacity = `${(alpha * heat * 0.9).toFixed(3)}`

        // The halo shares the geometry and just sits wider and softer, which
        // is what gives the filament something to be bright against.
        const halo = sparkHaloRefs.current[i]
        if (halo) {
          halo.setAttribute('d', spark.getAttribute('d') ?? '')
          halo.style.opacity = `${(alpha * heat * 0.3).toFixed(3)}`
        }

        // The bright head, as its own dot.
        //
        // A gradient along the streak would have said which way it is going
        // for free, but an SVG linear gradient runs across the shape's
        // bounding box rather than along the path — so the bright end lands on
        // whichever tip happens to be further right, which on a curve that
        // sweeps around the sphere is the wrong one half the time. A separate
        // dot at the leading point is unambiguous and costs one more element.
        const glow = sparkGlowRefs.current[i]
        if (glow) {
          glow.setAttribute('cx', x.toFixed(1))
          glow.setAttribute('cy', y.toFixed(1))
          glow.setAttribute('r', (3 + local * 4).toFixed(2))
          glow.style.opacity = (alpha * heat * 0.75).toFixed(3)
        }
        const head = sparkHeadRefs.current[i]
        if (head) {
          head.setAttribute('cx', x.toFixed(1))
          head.setAttribute('cy', y.toFixed(1))
          // Small and white-hot. The halo around it does the size; a big white
          // disc just reads as a dot travelling, which was the cheap version.
          head.setAttribute('r', (0.9 + local * 0.9).toFixed(2))
          head.style.opacity = (alpha * heat).toFixed(3)
        }
      })

      // The gathered charge, sitting where the void's darkness normally is.
      // It grows as light arrives, trembles while held, and blows out on
      // release before collapsing to nothing.
      if (coreRef.current) {
        const gathered = Math.pow(charge, 1.6)
        const radius = releasing
          ? 6 + flash * 26 + release * 8
          : 2 + gathered * 7 + tremor * 0.6
        const alpha = Math.min(1, releasing ? flash * 0.95 + (1 - release) * 0.12 : gathered * 0.75)
        coreRef.current.setAttribute('r', Math.max(0.1, radius).toFixed(2))
        coreRef.current.style.opacity = alpha.toFixed(3)
      }

      // The waves.
      //
      // Each one is three paths sharing an outline, not a single stroke: a
      // wide blurred wash underneath, a mid band, and a thin bright crest on
      // top. That layering is the whole difference between a line moving
      // outward and a body of water with a lit edge — one stroke, however
      // carefully tuned, can only ever be a line.
      RING_DELAYS.forEach((delay, i) => {
        const glow = ringGlowRefs.current[i]
        const band = ringBandRefs.current[i]
        const crest = ringCrestRefs.current[i]
        const local = releasing ? (release - delay) / (1 - delay) : -1
        if (local <= 0 || local >= 1) {
          if (glow) glow.style.opacity = '0'
          if (band) band.style.opacity = '0'
          if (crest) crest.style.opacity = '0'
          return
        }
        // Fast out of the sphere, slowing as it spreads — energy losing itself
        // to the room rather than a shape being scaled.
        const spread = 1 - Math.pow(1 - local, 2.4)
        const radius = 20 + spread * RING_REACH
        // The outline relaxes toward round as it expands, the way a swell
        // forgets the shape of whatever made it.
        const wobble = (1 - spread) * 0.5
        const d = blobPath(radius, churn + ringPhase.current, wobble, VOID_HARMONICS)
        const fade = (1 - local) * (1 - local)

        // The wash sits behind and slightly wider, and keeps its width as it
        // travels: water carries a body behind the crest.
        if (glow) {
          glow.setAttribute('d', d)
          glow.setAttribute('stroke-width', (26 * (1 - spread * 0.3)).toFixed(2))
          glow.style.opacity = (fade * 0.2).toFixed(3)
        }
        if (band) {
          band.setAttribute('d', d)
          band.setAttribute('stroke-width', (9 * (1 - spread * 0.45)).toFixed(2))
          band.style.opacity = (fade * 0.34).toFixed(3)
        }
        // The lit edge. Thin, near-white, and the last thing to fade.
        if (crest) {
          crest.setAttribute('d', d)
          crest.setAttribute('stroke-width', (2.4 * (1 - spread * 0.5)).toFixed(2))
          crest.style.opacity = (fade * 0.85).toFixed(3)
        }
      })

      // Water, not a ring of light.
      //
      // The surface is displaced by turbulence whose strength rides the wave:
      // strongest as the front leaves, dying out as it spreads. Driving the
      // filter rather than the geometry is what makes the glass itself look
      // like it is being disturbed — the highlights and the rim smear with the
      // ripple instead of sitting still behind it, which is the thing that was
      // missing when this was outlines on top of a static sphere.
      if (turbRef.current && dispRef.current) {
        const churnWave = releasing ? Math.sin(release * Math.PI) * (1 - release * 0.5) : 0

        // The surface trembling with the voice.
        //
        // Same displacement that carries the release wave, driven by the live
        // audio level instead of by the wave's own clock — so the glass shakes
        // to what is being said rather than only when an answer lands. The
        // floor keeps a trace of movement through the gaps between words,
        // because a surface that goes perfectly still between syllables reads
        // as dropped audio.
        //
        // Speech only, deliberately, not 'playing'. Radio runs through a plain
        // <audio> element with no analyser, so there is no level to shake to —
        // and measuring one would mean routing the stream through an
        // AudioContext, which silences any station that does not send CORS
        // headers. Measured across three: SomaFM and SRG allow it, laut.fm
        // does not. Including 'playing' here would therefore buy a constant
        // static distortion and the cost of an attached turbulence filter, in
        // exchange for no vibration at all.
        const voice = state === 'speaking' ? (0.12 + smoothed * 0.88) * VOICE_RIPPLE : 0

        // Also disturbed, faintly, while a charge is being gathered — the
        // surface tightening as pressure builds.
        const agitation = churnWave * 13 + charge * 1.6 + flash * 9 + voice

        // Attached only while there is something to disturb the surface, and
        // taken off the moment there isn't. Turbulence is regenerated on every
        // repaint and the void repaints every frame, so leaving it on would be
        // a permanent cost for a displacement of zero.
        const water = waterGroupRef.current
        if (water) {
          const wanted = agitation > 0.05 ? `url(#${id}-water)` : ''
          if (water.getAttribute('filter') !== (wanted || null)) {
            if (wanted) water.setAttribute('filter', wanted)
            else water.removeAttribute('filter')
          }
        }
        // Only written while the filter is actually attached — setting filter
        // primitives invalidates the whole chain, so touching them at rest
        // would undo the point of detaching it.
        if (agitation > 0.05) {
          // `scale` is the cheap one: it re-runs the displacement but reuses
          // the noise. Safe to write every frame, and it is what carries both
          // the wave and the voice.
          dispRef.current.setAttribute('scale', agitation.toFixed(2))

          // `baseFrequency` is the expensive one — changing it regenerates the
          // whole turbulence field. During a release that is worth paying for,
          // because the ripples lengthening as the wave spreads is most of
          // what makes it read as water. While talking it is not: a spoken
          // answer runs for many seconds, and regenerating noise sixty times a
          // second for the whole of it would be the single most expensive
          // thing this component does. So speech holds one fixed, finer field
          // and only shakes it harder or softer.
          const freq = releasing
            ? 0.055 - spreadFreq(release, releasing) * 0.03
            : VOICE_RIPPLE_FREQUENCY
          if (Math.abs(freq - lastFreq.current) > 0.0015) {
            lastFreq.current = freq
            turbRef.current.setAttribute(
              'baseFrequency',
              `${freq.toFixed(4)} ${(freq * 1.6).toFixed(4)}`
            )
          }
          // Re-seeded per turn so no two disturbances are the same water.
          const seed = String(1 + (ringPhase.current | 0))
          if (lastSeed.current !== seed) {
            lastSeed.current = seed
            turbRef.current.setAttribute('seed', seed)
          }
        }
      }

      // What the wave does to the rest of the panel.
      //
      // Published on the document element rather than on this component,
      // because a custom property only reaches descendants and the card is
      // this orb's *parent* — everything the wave should cross is a sibling.
      // `--orb-shock` is how hard it is hitting, `--orb-wave` is how far it has
      // got, and the card uses both to sweep a band of real distortion over
      // its own contents.
      const shove = releasing ? Math.sin(Math.pow(release, 0.7) * Math.PI) * (1 - release) : 0
      const root = document.documentElement.style
      root.setProperty('--orb-shock', shove.toFixed(4))
      root.setProperty('--orb-wave', releasing ? release.toFixed(4) : '0')

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef, state, searching])

  const [core, mid, rim] = PALETTE[mode].orb
  const id = `orb-${mode}`

  return (
    <div
      className={`relative shrink-0 ${tight ? 'overflow-hidden rounded-full' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* Bloom spilling onto whatever is behind the card. Sits outside the
          sphere's bounds on purpose — light does not stop at the object.
          Hidden when tight: a 48px window would clip it into a square. */}
      {!tight && (
        <div
          ref={bloomRef}
          className="pointer-events-none absolute -inset-[45%] rounded-full blur-xl will-change-transform"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${rim} 0%, transparent 68%)`,
            transition: 'background 500ms ease'
          }}
        />
      )}

      <div ref={rootRef} className="absolute inset-0 will-change-transform">
        <svg
          viewBox={tight ? '13 13 74 74' : '0 0 100 100'}
          className="h-full w-full overflow-visible"
        >
          <defs>
            {/* Glass body: dark at the centre, lifting toward the edge. */}
            {/* The body. Held near-black through most of the radius and lifted
                only in the last fifth: a glass sphere is dark almost all the way
                out and bright only where the surface turns away. The earlier
                gradient lifted from 62% and the result read as a shaded ball
                rather than something you could see into. */}
            <radialGradient id={`${id}-glass`} cx="38%" cy="32%" r="78%">
              <stop offset="0%" stopColor={core} stopOpacity="0.96" />
              <stop offset="55%" stopColor={core} />
              <stop offset="82%" stopColor={core} />
              <stop offset="94%" stopColor={mid} stopOpacity="0.85" />
              <stop offset="100%" stopColor={rim} stopOpacity="0.5" />
            </radialGradient>

            {/* Caustic: light that passed through the glass and focused on the
                far side from the source. It is the single detail that reads as
                "solid transparent object" rather than "dark disc", and nothing
                else in here does that job. */}
            <radialGradient id={`${id}-caustic`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
              <stop offset="45%" stopColor={rim} stopOpacity="0.28" />
              <stop offset="100%" stopColor={rim} stopOpacity="0" />
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

            {/* The charge: white-hot at the middle falling off to the state's
                own colour, so a full core reads as heat rather than as a
                brighter dot of the same paint. */}
            <radialGradient id={`${id}-core`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="30%" stopColor="#ffffff" stopOpacity="0.72" />
              <stop offset="62%" stopColor={rim} stopOpacity="0.5" />
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

            {/* Water.
                Turbulence used as a displacement map, which is the only way to
                get a surface that genuinely bends what is drawn on it rather
                than having a ripple pasted over the top. `scale` is driven per
                frame and sits at 0 at rest, so this costs nothing until a wave
                is actually running. The region is deliberately enormous: the
                waves travel far outside the sphere, and a filter clips to its
                own box, so a tight one would cut the crests off mid-flight. */}
            <filter id={`${id}-water`} x="-25%" y="-25%" width="150%" height="150%">
              <feTurbulence
                ref={turbRef}
                type="fractalNoise"
                baseFrequency="0.055 0.088"
                numOctaves="2"
                seed="1"
                result="churn"
              />
              <feDisplacementMap
                ref={dispRef}
                in="SourceGraphic"
                in2="churn"
                scale="0"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>

            <clipPath id={`${id}-clip`}>
              <circle cx="50" cy="50" r="37" />
            </clipPath>
          </defs>

          {/* The waves. Drawn before the glass so they read as passing behind
              and around the sphere rather than being painted over it, and
              outside the viewBox on purpose — this SVG overflows, so the card
              is what clips them as they cross the panel. */}
          <g>
            {RING_DELAYS.map((_, i) => (
              <path
                key={`wash-${i}`}
                ref={(node) => {
                  if (node) ringGlowRefs.current[i] = node
                }}
                fill="none"
                stroke={mid}
                strokeWidth="26"
                strokeLinecap="round"
                opacity="0"
                filter={`url(#${id}-soft)`}
                style={{ transition: 'stroke 500ms ease', willChange: 'opacity' }}
              />
            ))}
            {RING_DELAYS.map((_, i) => (
              <path
                key={`band-${i}`}
                ref={(node) => {
                  if (node) ringBandRefs.current[i] = node
                }}
                fill="none"
                stroke={rim}
                strokeWidth="9"
                opacity="0"
                filter={`url(#${id}-edge)`}
                style={{ transition: 'stroke 500ms ease', willChange: 'opacity' }}
              />
            ))}
            {RING_DELAYS.map((_, i) => (
              <path
                key={`crest-${i}`}
                ref={(node) => {
                  if (node) ringCrestRefs.current[i] = node
                }}
                fill="none"
                stroke="#ffffff"
                strokeWidth="2.4"
                opacity="0"
                style={{ willChange: 'opacity' }}
              />
            ))}
          </g>

          {/* The sphere itself, disturbed by the same water. Putting the glass
              inside the filter is what makes the rim and the highlights smear
              as the wave passes, rather than the ripple sliding over a surface
              that is plainly still underneath it. */}
          <g ref={waterGroupRef}>
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

          {/* The gathered charge. Inside the glass and additive, so it lights
              the void from within instead of sitting on top of it — the
              question ends up *in* the sphere, which is the whole idea. */}
          <g clipPath={`url(#${id}-clip)`} style={{ mixBlendMode: 'screen' }}>
            <circle
              ref={coreRef}
              cx="50"
              cy="50"
              r="0.1"
              fill={`url(#${id}-core)`}
              opacity="0"
              filter={`url(#${id}-soft)`}
              style={{ willChange: 'opacity' }}
            />
          </g>

          {/* The focused light, opposite the highlight, inside the glass. */}
          <g clipPath={`url(#${id}-clip)`} style={{ mixBlendMode: 'screen' }}>
            <ellipse cx="62" cy="66" rx="17" ry="13" fill={`url(#${id}-caustic)`} />
          </g>

          {/* Rim last, over the interior — the edge is the brightest thing. */}
          <circle cx="50" cy="50" r="37" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="1.15" />
          {/* Fresnel: every sphere is brighter right at its silhouette, all the
              way round, not only where the key light hits. Faint, but its
              absence is why the edge looked drawn on. */}
          <circle
            cx="50"
            cy="50"
            r="36.6"
            fill="none"
            stroke={rim}
            strokeOpacity="0.22"
            strokeWidth="0.8"
          />

          {/* Specular highlight. A small, *sharp*, filled shape rather than a
              soft stroke: gloss is defined by how crisp the reflection is, and
              a blurred highlight is what makes a render look plastic. Two
              parts, as on any polished sphere — a bright core and the faint
              wider bloom around it. */}
          <ellipse cx="35" cy="27" rx="9" ry="6.5" fill="#ffffff" opacity="0.10" transform="rotate(-32 35 27)" />
          <ellipse cx="34" cy="26" rx="4.6" ry="3" fill="#ffffff" opacity="0.55" transform="rotate(-32 34 26)" />
          {/* The thin catch of light along the top edge, where the surface is
              nearly parallel to the viewer. */}
          <path
            d="M26,28 A 30 30 0 0 1 50,14"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.4"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          </g>

          {/* Light falling in, drawn last and *outside* the water filter.
              These arrive from beyond the sphere and have to cross the rim to
              get in, so clipping them to the glass would hide the whole
              journey — and rippling them along with the surface would make
              them look like part of it rather than something reaching it.
              Three layers each: a wide halo, a bright filament, and a hot
              head, which is what stops a travelling line reading as a scratch
              on the screen. */}
          <g style={{ mixBlendMode: 'screen' }}>
            {SPARKS.map((_, i) => (
              <path
                key={`halo-${i}`}
                ref={(node) => {
                  if (node) sparkHaloRefs.current[i] = node
                }}
                fill="none"
                stroke={mid}
                strokeWidth="7"
                strokeLinecap="round"
                opacity="0"
                filter={`url(#${id}-soft)`}
                style={{ transition: 'stroke 500ms ease', willChange: 'opacity' }}
              />
            ))}
            {SPARKS.map((_, i) => (
              <path
                key={`trail-${i}`}
                ref={(node) => {
                  if (node) sparkRefs.current[i] = node
                }}
                fill="none"
                stroke={rim}
                strokeWidth="2.2"
                strokeLinecap="round"
                opacity="0"
                filter={`url(#${id}-edge)`}
                style={{ transition: 'stroke 500ms ease', willChange: 'opacity' }}
              />
            ))}
            {SPARKS.map((_, i) => (
              <circle
                key={`glow-${i}`}
                ref={(node) => {
                  if (node) sparkGlowRefs.current[i] = node
                }}
                r="4"
                fill={`url(#${id}-mote)`}
                opacity="0"
                filter={`url(#${id}-soft)`}
                style={{ willChange: 'opacity' }}
              />
            ))}
            {SPARKS.map((_, i) => (
              <circle
                key={`head-${i}`}
                ref={(node) => {
                  if (node) sparkHeadRefs.current[i] = node
                }}
                r="1.5"
                fill="#ffffff"
                opacity="0"
                style={{ willChange: 'opacity' }}
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
