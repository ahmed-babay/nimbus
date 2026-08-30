/**
 * Nimbus, the core — a contained storm drawn on a 2D canvas.
 *
 * Ported from the orb on the Nimbus website so the app and the site are
 * recognisably the same object. Nothing here is a video or a sprite sheet:
 * every arc is generated per frame.
 *
 * How it works
 * ------------
 * Everything lives on a unit sphere in 3D. Filaments and bolts are built as 3D
 * polylines, then rotated around Y (the slow continuous spin) and X (a fixed
 * tilt) and projected orthographically. A point's z says whether it is on the
 * near or the far side, which drives its brightness — so the core genuinely
 * reads as rotating rather than as a flat swirl.
 *
 * Bolts are fractal: take two points on the sphere, displace the midpoint,
 * recurse. Each generation halves the displacement, which is what gives
 * lightning its self-similar kink.
 *
 * Glow is two strokes — a wide dim pass and a narrow bright one — under
 * `lighter` compositing. Far cheaper than shadowBlur, and it looks better.
 *
 * What this adds over the website's version
 * -----------------------------------------
 * The site's orb only ever idles. This one has a turn to tell, so the same
 * machinery is used for the rest of it rather than bolting a second visual
 * language onto the side:
 *
 *   - **Inbound streamers.** While a question is being taken in, bolts strike
 *     *inward* from outside the shell and are swallowed by it. Same fractal,
 *     run from the outside in.
 *   - **Indrawn motes.** The dust orbiting the core is pulled down onto the
 *     shell as the charge builds, so the space around the orb empties into it.
 *   - **The discharge.** The core blows out and the storm fires outward — no
 *     new geometry, just the existing bolts spawned hot and biased outward.
 *
 * The engine owns the storm; the caller owns the clock. `frame()` is handed
 * everything that varies (palette, energy, charge, release, voice level) and
 * draws exactly one frame, which keeps every decision about *what Nimbus is
 * doing* in the component and every decision about *how a storm looks* here.
 */

const TAU = Math.PI * 2

export type RGB = [number, number, number]

/**
 * The four colours a storm needs, derived from a state's [core, mid, rim].
 *
 * `beam` is the atmosphere and the wide dim glow pass, `arc` is the lightning
 * itself, `core` is the white-hot centre, and `shell` tints the dark body the
 * storm is held inside — which is what keeps an idle ember orb warm all the
 * way through rather than a warm rim around a blue void.
 */
export interface OrbPalette {
  beam: RGB
  arc: RGB
  core: RGB
  shell: RGB
}

/** Everything that varies frame to frame, decided by the component. */
export interface OrbDrive {
  palette: OrbPalette
  /** Base energy, 0..1: how hard the storm is running. */
  intensity: number
  /** Light being drawn in, 0..1. Contracts the storm and empties the space around it. */
  charge: number
  /** The discharge, 0..1, or 0 when not releasing. */
  release: number
  /** The blinding instant at the front of a discharge, 0..1. */
  flash: number
  /** Smoothed voice level, 0..1 — the mic while listening, its own voice while speaking. */
  level: number
  /** Whole-orb size multiplier: the entrance, the breath, and the voice swell. */
  scale: number
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Uniform point on the unit sphere. */
function onSphere(): number[] {
  const u = Math.random() * 2 - 1
  const t = Math.random() * TAU
  const s = Math.sqrt(1 - u * u)
  return [s * Math.cos(t), s * Math.sin(t), u]
}

function scaleTo(p: number[], r: number): number[] {
  const m = Math.hypot(p[0], p[1], p[2]) || 1
  const k = r / m
  p[0] *= k
  p[1] *= k
  p[2] *= k
  return p
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16
  )
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

const WHITE: RGB = [255, 255, 255]

/**
 * A state's three orb colours, retuned for a storm.
 *
 * The states are authored as [core, mid, rim] — a near-black body, a mid tone,
 * and one bright accent — which is the palette for a lit glass sphere and not
 * for lightning. The storm needs a saturated atmosphere and a white-hot centre
 * that the source palette has no entry for, so both are derived from the rim
 * rather than introduced: every state keeps exactly the hue it had.
 */
export function stormPalette(orb: readonly [string, string, string]): OrbPalette {
  const core = hexToRgb(orb[0])
  const mid = hexToRgb(orb[1])
  const rim = hexToRgb(orb[2])
  return {
    // Pulled well toward the rim: the mid tone alone is too dark to read as
    // atmosphere once it is spread over two radii at low alpha.
    beam: mix(mid, rim, 0.55),
    arc: rim,
    // Hot, but never pure white — a white centre loses the state colour at
    // exactly the moment the orb is brightest and most looked at.
    core: mix(rim, WHITE, 0.66),
    shell: core
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Recursive midpoint displacement between two points, with each vertex pushed
 * back onto a shell so the bolt stays inside the sphere instead of ballooning
 * out of it.
 */
function fracture(a: number[], b: number[], depth: number, amp: number, out: number[][]): void {
  if (depth <= 0) {
    out.push(b)
    return
  }
  const m = [
    (a[0] + b[0]) / 2 + rand(-amp, amp),
    (a[1] + b[1]) / 2 + rand(-amp, amp),
    (a[2] + b[2]) / 2 + rand(-amp, amp)
  ]
  const shell = clamp(
    (Math.hypot(a[0], a[1], a[2]) + Math.hypot(b[0], b[1], b[2])) / 2 + rand(-0.14, 0.1),
    0.24,
    0.99
  )
  scaleTo(m, shell)
  fracture(a, m, depth - 1, amp * 0.54, out)
  fracture(m, b, depth - 1, amp * 0.54, out)
}

interface Bolt {
  pts: number[][]
  born: number
  life: number
  width: number
  hot: boolean
  branch: number[][] | null
}

function makeBranch(pts: number[][]): number[][] {
  const i = 2 + ((Math.random() * (pts.length - 4)) | 0)
  const a = pts[i].slice()
  const b = onSphere()
  scaleTo(b, rand(0.5, 0.98))
  const out = [a]
  fracture(a, b, 4, 0.22, out)
  return out
}

function makeBolt(nearBias: boolean): Bolt {
  const a = onSphere()
  const b = onSphere()

  // Keep the two ends within a sensible arc of each other, or the bolt just
  // cuts straight through the middle every time.
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  if (dot < -0.15) {
    b[0] = -b[0]
    b[1] = -b[1]
    b[2] = -b[2]
  }

  // Most storms happen where you can see them.
  if (nearBias && a[2] + b[2] < 0) {
    a[2] = -a[2]
    b[2] = -b[2]
  }

  // Spread the endpoints through the volume, not just near the shell, or every
  // strike reads as a ring around the equator.
  scaleTo(a, rand(0.34, 0.98))
  scaleTo(b, rand(0.34, 0.98))

  const pts = [a]
  fracture(a, b, 5, rand(0.2, 0.38), pts)

  return {
    pts,
    born: 0,
    life: rand(110, 290),
    width: rand(0.9, 2.3),
    hot: Math.random() < 0.34,
    branch: Math.random() < 0.42 ? makeBranch(pts) : null
  }
}

interface Filament {
  pts: number[][]
  spin: number
  phase: number
  pulse: number
  life: number
  born: number
  width: number
}

/**
 * Long-lived glowing strands. Same fractal, gentler, and they drift on their
 * own axis so the interior never settles.
 */
function makeFilament(): Filament {
  const a = onSphere()
  const b = onSphere()
  scaleTo(a, rand(0.45, 0.94))
  scaleTo(b, rand(0.45, 0.94))
  const pts = [a]
  fracture(a, b, 4, rand(0.16, 0.3), pts)
  return {
    pts,
    spin: rand(-0.16, 0.16),
    phase: rand(0, TAU),
    pulse: rand(0.5, 1.5),
    life: rand(2600, 6200),
    born: 0,
    width: rand(0.7, 1.8)
  }
}

interface Streamer {
  pts: number[][]
  born: number
  life: number
  width: number
}

/**
 * A strike arriving from outside.
 *
 * Built outward-in: it starts well clear of the shell and ends just inside it,
 * so when the head reaches the end it has visibly been swallowed rather than
 * having stopped at the surface. The fractal is the same one the bolts use, so
 * an incoming strike is made of the same stuff as the storm it feeds.
 */
function makeStreamer(): Streamer {
  // Kept inside the bitmap. The canvas reaches about 2.2 radii, so a streamer
  // starting further out than this spends its bright approach cropped and only
  // appears for the instant before it lands.
  const outer = scaleTo(onSphere(), rand(1.45, 1.95))
  // Land on the near hemisphere most of the time: a streamer absorbed round
  // the back is technically correct and completely invisible.
  const inner = onSphere()
  if (outer[2] > 0 && inner[2] < 0) inner[2] = -inner[2]
  scaleTo(inner, rand(0.55, 0.9))

  const pts = [outer]
  fracture(outer, inner, 4, rand(0.28, 0.5), pts)
  return { pts, born: 0, life: rand(340, 620), width: rand(0.8, 1.9) }
}

interface Mote {
  p: number[]
  /** Resting distance from the centre, so the charge can pull it in and let go. */
  rest: number
  s: number
  a: number
  tw: number
  ph: number
}

function makeMote(): Mote {
  const rest = rand(1.08, 2.5)
  return {
    p: scaleTo(onSphere(), rest),
    rest,
    s: rand(0.5, 1.7),
    a: rand(0.12, 0.7),
    tw: rand(0.4, 2.2),
    ph: rand(0, TAU)
  }
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export interface StormOrb {
  /** Re-reads the element's box. Call on mount and on resize. */
  resize(): void
  /** Draws exactly one frame. `dt` and `now` are milliseconds. */
  frame(drive: OrbDrive, dt: number, now: number): void
  /** One considered frame for people who asked for less motion. */
  still(drive: OrbDrive): void
}

export interface StormOptions {
  /**
   * Fraction of the canvas half-size the sphere occupies.
   *
   * Well under 1 when the atmosphere has to fit inside the bitmap too — a
   * canvas cannot paint outside itself, so the halo's room has to be bought
   * here rather than with `overflow: visible`.
   */
  fill: number
  /** Drop the outer atmosphere. For the tiny chip, where it would only clip. */
  bare: boolean
}

export function createStormOrb(canvas: HTMLCanvasElement, options: StormOptions): StormOrb | null {
  const context = canvas.getContext('2d')
  if (!context) return null
  // Bound to a non-nullable type rather than relying on narrowing: every draw
  // helper below is a closure, and the narrowing does not reliably survive
  // into all of them.
  const ctx: CanvasRenderingContext2D = context

  let W = 0
  let H = 0
  let dpr = 1
  let cx = 0
  let cy = 0
  /** The resting radius. `frame` scales this per-frame; layout does not. */
  let baseR = 0

  let spin = 0
  const tilt = -0.3

  const bolts: Bolt[] = []
  const streamers: Streamer[] = []
  let filaments: Filament[] = []
  let motes: Mote[] = []
  let spawnDebt = 0
  let streamerDebt = 0
  /** Rises on release so the discharge fires outward for a moment after it. */
  let burst = 0
  let lastCharge = 0

  /**
   * Populations sized to the sphere.
   *
   * The website's counts are tuned for a hero three hundred pixels across. At
   * the 52px this usually renders into, the same numbers put a filament every
   * two pixels and the storm turns into a solid disc — the individual arcs are
   * the whole point, so there have to be few enough to see one.
   */
  function populate(): void {
    const filamentCount = Math.round(clamp(baseR / 4.5, 8, 24))
    const moteCount = Math.round(clamp(baseR * 1.5, 22, 90))

    filaments = []
    for (let i = 0; i < filamentCount; i++) filaments.push(makeFilament())
    motes = []
    for (let i = 0; i < moteCount; i++) motes.push(makeMote())
  }

  function maxBolts(): number {
    return Math.round(clamp(baseR / 2.4, 10, 40))
  }

  /** Stroke widths are authored against a large orb; bring them down with it. */
  function unit(): number {
    return clamp(baseR / 130, 0.3, 1.5)
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect()
    W = Math.max(1, Math.round(rect.width))
    H = Math.max(1, Math.round(rect.height))
    dpr = Math.min(window.devicePixelRatio || 1, 2)

    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    cx = W / 2
    cy = H / 2
    const next = (Math.min(W, H) / 2) * options.fill
    const changed = Math.abs(next - baseR) > 0.5
    baseR = next
    if (changed || filaments.length === 0) populate()
  }

  // --- projection: rotate around Y (spin), then X (tilt), then drop z -------

  let sinY = 0
  let cosY = 1
  let sinX = 0
  let cosX = 1

  function refreshRotation(): void {
    sinY = Math.sin(spin)
    cosY = Math.cos(spin)
    sinX = Math.sin(tilt)
    cosX = Math.cos(tilt)
  }

  let px = 0
  let py = 0
  let pz = 0

  function project(p: number[], extraSpin: number): void {
    let sy = sinY
    let cyy = cosY
    if (extraSpin) {
      sy = Math.sin(spin + extraSpin)
      cyy = Math.cos(spin + extraSpin)
    }
    const x = p[0] * cyy + p[2] * sy
    const z = -p[0] * sy + p[2] * cyy
    const y = p[1]
    py = y * cosX - z * sinX
    pz = y * sinX + z * cosX
    px = x
  }

  /** Builds the path and returns the mean depth, for the near/far fade. */
  function strokePath(pts: number[][], extraSpin: number, R: number): number {
    let zsum = 0
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
      project(pts[i], extraSpin)
      zsum += pz
      const sx = cx + px * R
      const sy = cy + py * R
      if (i === 0) ctx.moveTo(sx, sy)
      else ctx.lineTo(sx, sy)
    }
    return zsum / pts.length
  }

  /**
   * The part of a polyline between two fractions of its length.
   *
   * Streamers are drawn as a moving window rather than all at once: the head
   * advances and a short tail follows it, so the light is travelling along the
   * path instead of the whole path switching on. Measured in projected screen
   * space, because that is the length the eye actually reads.
   */
  function strokeWindow(pts: number[][], from: number, to: number, R: number): number {
    const xs: number[] = []
    const ys: number[] = []
    let zsum = 0
    for (let i = 0; i < pts.length; i++) {
      project(pts[i], 0)
      zsum += pz
      xs.push(cx + px * R)
      ys.push(cy + py * R)
    }

    const seg: number[] = []
    let total = 0
    for (let i = 1; i < xs.length; i++) {
      const d = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
      seg.push(d)
      total += d
    }
    if (total <= 0) return zsum / pts.length

    const a = clamp(from, 0, 1) * total
    const b = clamp(to, 0, 1) * total

    ctx.beginPath()
    let walked = 0
    let started = false
    for (let i = 0; i < seg.length; i++) {
      const s0 = walked
      const s1 = walked + seg[i]
      walked = s1
      if (s1 < a || s0 > b) continue

      const t0 = seg[i] === 0 ? 0 : clamp((a - s0) / seg[i], 0, 1)
      const t1 = seg[i] === 0 ? 1 : clamp((b - s0) / seg[i], 0, 1)
      const x0 = xs[i] + (xs[i + 1] - xs[i]) * t0
      const y0 = ys[i] + (ys[i + 1] - ys[i]) * t0
      const x1 = xs[i] + (xs[i + 1] - xs[i]) * t1
      const y1 = ys[i] + (ys[i + 1] - ys[i]) * t1
      if (!started) {
        ctx.moveTo(x0, y0)
        started = true
      }
      ctx.lineTo(x1, y1)
    }
    return zsum / pts.length
  }

  /** Depth: 1 on the near face, ~0.18 on the far side. */
  function depthFade(z: number): number {
    return 0.18 + 0.82 * clamp((z + 1) / 2, 0, 1)
  }

  // --- the frame -----------------------------------------------------------

  function draw(drive: OrbDrive, dt: number, now: number): void {
    const pal = drive.palette
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    refreshRotation()

    const u = unit()
    const power = clamp(drive.intensity + burst + drive.flash * 0.5, 0, 1.35)
    // Gathering packs the storm down; the discharge throws it back out past
    // where it rests, which is what gives the release somewhere to travel.
    // Clamped to the bitmap: the swell and the entrance overshoot both scale
    // this up, and a sphere wider than the canvas is cropped to a square.
    const R = clamp(
      baseR * drive.scale * (1 - drive.charge * 0.12 + drive.flash * 0.16 + drive.release * 0.05),
      6,
      (Math.min(W, H) / 2) * 0.98
    )

    // ---- outer atmosphere ----
    ctx.globalCompositeOperation = 'lighter'
    if (!options.bare) {
      const halo = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 2.05)
      halo.addColorStop(0, rgba(pal.beam, 0.21 + power * 0.17))
      halo.addColorStop(0.38, rgba(pal.beam, 0.07 + power * 0.06))
      halo.addColorStop(1, rgba(pal.beam, 0))
      ctx.fillStyle = halo
      ctx.fillRect(cx - R * 2.05, cy - R * 2.05, R * 4.1, R * 4.1)
    }

    // ---- motes drifting around the core ----
    //
    // Drawn in the same place they always are, except that the charge reels
    // them in: the space around the orb visibly empties into it while a
    // question is being taken in, which is most of why the gathering reads as
    // gathering rather than as the orb simply getting brighter.
    for (let i = 0; i < motes.length; i++) {
      const mo = motes[i]
      const pull = 1 - drive.charge * 0.62
      const target = 0.98 + (mo.rest - 0.98) * pull
      scaleTo(mo.p, target)
      project(mo.p, 0)
      const tw = 0.55 + 0.45 * Math.sin(now * 0.001 * mo.tw + mo.ph)
      const a = mo.a * tw * depthFade(pz) * (0.4 + power * 0.6) * (1 - drive.charge * 0.3)
      ctx.fillStyle = rgba(pal.arc, a)
      const s = mo.s * clamp(u * 1.6, 0.5, 1.4)
      ctx.fillRect(cx + px * R - s / 2, cy + py * R - s / 2, s, s)
    }

    // ---- inbound streamers ----
    //
    // Outside the shell, so they are drawn before it is clipped over.
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let i = streamers.length - 1; i >= 0; i--) {
      const st = streamers[i]
      st.born += dt
      if (st.born > st.life) {
        streamers.splice(i, 1)
        continue
      }
      const t = st.born / st.life
      // The head accelerates: slow while it is still out in the dark, quick
      // over the last stretch, so arriving is the emphatic part.
      const head = Math.pow(t, 0.62)
      const tail = Math.max(0, head - 0.34)
      const z = strokeWindow(st.pts, tail, head, R)
      // Brightest just before it lands, then gone — absorbed, not stopped.
      const env = Math.min(1, t * 4) * (1 - Math.pow(t, 3))
      const a = env * depthFade(z) * (0.5 + power * 0.5)

      ctx.strokeStyle = rgba(pal.beam, a * 0.4)
      ctx.lineWidth = st.width * 6 * u
      ctx.stroke()
      ctx.strokeStyle = rgba(pal.arc, a * 0.9)
      ctx.lineWidth = Math.max(0.6, st.width * 1.7 * u)
      ctx.stroke()
      ctx.strokeStyle = rgba(pal.core, a)
      ctx.lineWidth = Math.max(0.4, st.width * 0.6 * u)
      ctx.stroke()
    }

    // ---- the sphere body: a dark shell so the plasma is contained ----
    ctx.globalCompositeOperation = 'source-over'
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, TAU)
    ctx.clip()

    // Tinted with the state's darkest colour rather than a fixed navy, so an
    // idle ember orb is warm all the way through instead of being a warm rim
    // around a blue interior.
    const body = ctx.createRadialGradient(cx - R * 0.22, cy - R * 0.26, R * 0.05, cx, cy, R)
    body.addColorStop(0, rgba(mix(pal.shell, WHITE, 0.06), 0.34))
    body.addColorStop(0.58, rgba(pal.shell, 0.6))
    body.addColorStop(1, rgba(mix(pal.shell, [0, 0, 0], 0.45), 0.85))
    ctx.fillStyle = body
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2)

    // ---- filaments ----
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (let i = filaments.length - 1; i >= 0; i--) {
      const fl = filaments[i]
      fl.born += dt
      if (fl.born > fl.life) {
        filaments[i] = makeFilament()
        continue
      }

      const age = fl.born / fl.life
      const fade = Math.sin(age * Math.PI)
      const beat = 0.6 + 0.4 * Math.sin(now * 0.0016 * fl.pulse + fl.phase)
      const extra = fl.spin * (now * 0.0004)
      const z = strokePath(fl.pts, extra, R)
      const d = depthFade(z)
      const a = 0.92 * fade * beat * d * (0.35 + power * 0.75)

      ctx.strokeStyle = rgba(pal.beam, a * 0.34)
      ctx.lineWidth = fl.width * 5.5 * u
      ctx.stroke()

      ctx.strokeStyle = rgba(pal.arc, a)
      ctx.lineWidth = Math.max(0.5, fl.width * u)
      ctx.stroke()
    }

    // ---- bolts ----
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i]
      b.born += dt
      if (b.born > b.life) {
        bolts.splice(i, 1)
        continue
      }

      // Sharp attack, longer decay — lightning does not fade in.
      const t = b.born / b.life
      const env = t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 1.7)
      const flicker = 0.72 + 0.28 * Math.sin(b.born * 0.09 + b.width * 9)

      const zb = strokePath(b.pts, 0, R)
      const db = depthFade(zb)
      const ab = env * flicker * db * (0.62 + power * 0.62)
      const hot = b.hot ? pal.core : pal.arc

      ctx.strokeStyle = rgba(pal.beam, ab * 0.42)
      ctx.lineWidth = b.width * 7 * u
      ctx.stroke()

      ctx.strokeStyle = rgba(pal.arc, ab * 0.75)
      ctx.lineWidth = b.width * 2.6 * u
      ctx.stroke()

      ctx.strokeStyle = rgba(hot, Math.min(1, ab * 1.15))
      ctx.lineWidth = Math.max(0.5, b.width * u)
      ctx.stroke()

      if (b.branch) {
        strokePath(b.branch, 0, R)
        ctx.strokeStyle = rgba(pal.arc, ab * 0.5)
        ctx.lineWidth = b.width * 1.6 * u
        ctx.stroke()
        ctx.strokeStyle = rgba(hot, ab * 0.75)
        ctx.lineWidth = Math.max(0.4, b.width * 0.6 * u)
        ctx.stroke()
      }
    }

    // ---- the white-hot centre ----
    //
    // The charge lives here: it is what the streamers are feeding, so it grows
    // as they arrive, sits tight while Nimbus works, and blows out on release.
    const pulse = 0.82 + 0.18 * Math.sin(now * 0.0034) + 0.1 * Math.sin(now * 0.011)
    const gathered = Math.pow(drive.charge, 1.5)
    // The voice reaches the core directly as well as through `intensity`.
    // Energy is smoothed and mixed with four other things by the time it gets
    // here, which is right for how hard the storm runs but far too sluggish to
    // read as *this syllable* — the centre has to move with the sound itself
    // or the orb looks like it is talking over a recording of itself.
    const cr = R * (0.52 + power * 0.22 + gathered * 0.3 + drive.flash * 0.55 + drive.level * 0.1) * pulse
    const heat = 0.5 + power * 0.5 + gathered * 0.45 + drive.flash * 0.8 + drive.level * 0.3
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr)
    core.addColorStop(0, rgba(pal.core, Math.min(1, 0.8 * heat)))
    core.addColorStop(0.16, rgba(pal.arc, Math.min(1, 0.42 * (0.4 + power * 0.6 + gathered))))
    core.addColorStop(0.52, rgba(pal.beam, 0.18 * (0.4 + power * 0.6)))
    core.addColorStop(1, rgba(pal.beam, 0))
    ctx.fillStyle = core
    ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2)

    // ---- interior haze: the volume the storm is held in ----
    const fogr = R * 0.98
    const fog = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, fogr)
    fog.addColorStop(0, rgba(pal.beam, 0.16 * (0.4 + power * 0.6)))
    fog.addColorStop(0.55, rgba(pal.beam, 0.1 * (0.4 + power * 0.6)))
    fog.addColorStop(1, rgba(pal.beam, 0.02))
    ctx.fillStyle = fog
    ctx.fillRect(cx - fogr, cy - fogr, fogr * 2, fogr * 2)

    // ---- inner rim: light catching the inside of the shell ----
    const inner = ctx.createRadialGradient(cx, cy, R * 0.74, cx, cy, R)
    inner.addColorStop(0, rgba(pal.beam, 0))
    // Catching the voice too, so the shell lights up from the inside as it
    // speaks rather than only the middle brightening.
    inner.addColorStop(1, rgba(pal.beam, 0.3 + power * 0.2 + drive.level * 0.16))
    ctx.fillStyle = inner
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2)

    ctx.restore()

    // ---- outer rim lines ----
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, TAU)
    ctx.strokeStyle = rgba(pal.arc, 0.16 + power * 0.16)
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, R + 3 * u, 0, TAU)
    ctx.strokeStyle = rgba(pal.beam, 0.1 + power * 0.12)
    ctx.lineWidth = Math.max(1, 7 * u)
    ctx.stroke()

    // ---- the discharge leaving ----
    //
    // One ring rather than three. The panel behind the orb runs its own wave
    // off --orb-shock, so this only has to get the energy across the rim and
    // hand it over; a stack of rings here would be saying it twice.
    if (drive.release > 0 && !options.bare) {
      const ring = R * (1 + drive.release * 1.5)
      const fade = (1 - drive.release) * (1 - drive.release)
      ctx.beginPath()
      ctx.arc(cx, cy, ring, 0, TAU)
      ctx.strokeStyle = rgba(pal.arc, fade * 0.5)
      ctx.lineWidth = Math.max(1, 3 * u) * (1 + drive.release * 2)
      ctx.stroke()
    }

    ctx.globalCompositeOperation = 'source-over'
  }

  /**
   * Advances the storm, then draws it.
   *
   * Spawn rates are the only place the state really changes the storm's
   * behaviour rather than its colour: a charged core throws more lightning,
   * and a question being taken in is a shower of streamers arriving.
   */
  function frame(drive: OrbDrive, dt: number, now: number): void {
    spin += dt * 0.00016 * (0.6 + drive.intensity * 0.8)

    const rate = (7 + Math.pow(clamp(drive.intensity + burst, 0, 1.4), 2) * 62) / 1000
    spawnDebt += dt * rate
    const cap = maxBolts()
    while (spawnDebt >= 1) {
      spawnDebt -= 1
      // The discharge fires outward — biased to the near face so it is thrown
      // at the viewer rather than away from them.
      if (bolts.length < cap) bolts.push(makeBolt(burst > 0.05 ? true : Math.random() < 0.78))
    }

    // Streamers only while light is actually being drawn in, and they stop the
    // moment the charge is full: the shower is the *gathering*, and leaving it
    // running through the hold would say the question is still arriving.
    const gathering = drive.charge > 0 && drive.charge < 1 && drive.charge >= lastCharge
    lastCharge = drive.charge
    if (gathering) {
      streamerDebt += dt * 0.019
      while (streamerDebt >= 1) {
        streamerDebt -= 1
        if (streamers.length < 14) streamers.push(makeStreamer())
      }
    } else {
      streamerDebt = 0
    }

    // Held up across the whole discharge rather than only its flash, so the
    // storm stays thrown-open while the wave crosses the panel instead of
    // dropping back to resting the instant the core stops glaring.
    if (drive.release > 0) burst = Math.max(burst, 0.55 * (1 - drive.release))
    if (drive.flash > 0.5) burst = Math.max(burst, 0.6)
    burst *= Math.pow(0.93, dt / 16.7)

    draw(drive, dt, now)
  }

  /**
   * A single considered frame for people who asked for less motion: same
   * storm, same palette, just not alive.
   */
  function still(drive: OrbDrive): void {
    bolts.length = 0
    for (let i = 0; i < Math.min(7, maxBolts()); i++) {
      const b = makeBolt(true)
      b.born = b.life * 0.22
      bolts.push(b)
    }
    for (let i = 0; i < filaments.length; i++) filaments[i].born = filaments[i].life * 0.5
    draw(drive, 16, 1200)
  }

  return { resize, frame, still }
}
