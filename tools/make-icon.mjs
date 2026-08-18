import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

/**
 * Draws the Nimbus app icon.
 *
 * The icon is the orb, because the orb is the only thing about this app anyone
 * ever sees. What it was before — a flat lavender lens, off-centre, no depth —
 * shared nothing with the interface it launches.
 *
 * Rendered rather than drawn by hand so it is reproducible and tunable: every
 * value below is a number you can change and re-run. No image library, because
 * a PNG is a header, a zlib stream of scanlines and a checksum, and adding a
 * native dependency to draw one circle would be silly.
 *
 * Antialiasing is analytic, not supersampled. Every edge here is a circle or a
 * smooth falloff, so coverage can be computed exactly from the distance to the
 * edge — sharper than supersampling and far cheaper.
 */

// --- PNG ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data])
  out.writeUInt32BE(crc32(crcInput), 8 + data.length)
  return out
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  // One filter byte per scanline. Filter 0 (none) keeps this readable; the
  // image is smooth gradients, which deflate handles well regardless.
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- drawing helpers ------------------------------------------------------

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v)
/** Smooth 0->1 across [edge0, edge1]; the antialiasing primitive. */
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
const mix = (a, b, t) => a + (b - a) * t
const mixColor = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
]

/**
 * The palette is the orb's `listening` state — the blue it wears while someone
 * is talking to it, which is the moment the app is most itself. Idle red would
 * read as an error at icon size, and the indigo of `thinking` goes muddy once
 * it is 16 pixels wide.
 */
const CORE = hex('#0a1628')
const MID = hex('#2f6bbd')
const RIM = hex('#8fc0ff')
const HOT = [255, 255, 255]

/** Where the light comes from. Lower-right, so the crescent sits there. */
const LIGHT = (() => {
  const [x, y] = [0.60, 0.72]
  const len = Math.hypot(x, y)
  return [x / len, y / len]
})()

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = size / 2
  // Leaves room for the glow to fall off inside the canvas rather than being
  // clipped at the edge, which is what makes a glow look like a grey box.
  const R = size * 0.395
  const px = size / 1024 // so every constant below is authored at 1024

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Pixel centres, or the sphere lands half a pixel off and looks wobbly.
      const dx = x + 0.5 - c
      const dy = y + 0.5 - c
      const d = Math.hypot(dx, dy)
      const nx = d === 0 ? 0 : dx / d
      const ny = d === 0 ? 0 : dy / d

      let r = 0
      let g = 0
      let b = 0
      let a = 0

      // 1. Outer bloom. Light does not stop at the object, and on a dark
      //    taskbar this is what stops a dark sphere disappearing entirely.
      if (d > R - 2 * px) {
        const facingGlow = clamp((dx * LIGHT[0] + dy * LIGHT[1]) / Math.max(d, 1e-6))
        const falloff = Math.exp(-(d - R) / (size * 0.05))
        // Weighted toward the light: a glow of even thickness all the way
        // round is a halo, and a halo reads as a logo rather than an object.
        const glow =
          clamp(falloff * 0.46) * smoothstep(R + size * 0.13, R, d) * (0.35 + 0.65 * clamp(facingGlow))
        r = RIM[0] * glow
        g = RIM[1] * glow
        b = RIM[2] * glow
        a = glow * 0.85
      }

      // 2. The glass body: dark at the centre, lifting toward the edge. A
      //    sphere lit from outside is *darkest* in the middle; filling the
      //    centre with colour is what makes an orb read as a button.
      const body = smoothstep(R + 1.0 * px, R - 1.0 * px, d)
      if (body > 0) {
        const t = clamp(d / R)
        // Radial falloff *and* a directional term. Purely radial shading gives
        // a ring, which is what makes a sphere read as a doughnut; a real one
        // is lit from a side and the far edge stays dark.
        const lit = clamp(0.5 + 0.5 * (nx * LIGHT[0] + ny * LIGHT[1]))
        const shade = Math.pow(t, 2.0) * (0.30 + 0.70 * Math.pow(lit, 1.4))
        const [br, bg, bb] = mixColor(CORE, MID, shade)
        r = mix(r, br, body)
        g = mix(g, bg, body)
        b = mix(b, bb, body)
        a = mix(a, 1, body)
      }

      // 3. The void: a darker mass inside, pushed away from the light so the
      //    sphere reads as a volume rather than a disc.
      if (body > 0) {
        const vx = dx + size * 0.085
        const vy = dy + size * 0.095
        const vd = Math.hypot(vx, vy)
        const vr = R * 0.50
        const inVoid = smoothstep(vr, vr * 0.2, vd)
        const [dr, dg, db] = mixColor([r, g, b], CORE, inVoid * 0.55)
        r = dr
        g = dg
        b = db

        // No lit edge on the void. A second bright circle inside the first
        // one reads as an iris, and an eye is not what this app is.
      }

      // 3b. One ribbon of light through the interior. Without it this is a
      //     shaded ball; with it, it is the thing on screen when Nimbus is
      //     listening. Kept to a single sweep so it still resolves at 16px.
      if (body > 0) {
        const ang = Math.atan2(dy, dx)
        const ribbonR = R * 0.66
        const across = Math.exp(-Math.pow((d - ribbonR) / (R * 0.115), 2))
        // A partial arc, not a full ring: brightest sweeping up the left side
        // and fading out before it closes.
        const sweep = Math.pow(clamp(Math.cos(ang - 2.55) * 0.5 + 0.5), 2.6)
        const ribbon = across * sweep * body * 1.35
        r += RIM[0] * ribbon * 0.75
        g += RIM[1] * ribbon * 0.85
        b += 255 * ribbon * 0.95
      }

      // 4. The rim. This is the whole icon: a bright crescent where the
      //    surface turns away, brightest along the light direction and fading
      //    to nothing opposite it.
      const facing = clamp(nx * LIGHT[0] + ny * LIGHT[1])
      const band = Math.exp(-Math.pow((d - (R - 4.0 * px)) / (R * 0.045), 2))
      // Power 3.5, not 1.5. This is the difference between a crescent and a
      // ring, and the crescent is the entire silhouette of a lit sphere.
      const rim = band * Math.pow(facing, 3.5) * body
      const rimColor = mixColor(RIM, HOT, Math.pow(facing, 4) * 0.85)
      r += rimColor[0] * rim * 1.95
      g += rimColor[1] * rim * 1.95
      b += rimColor[2] * rim * 1.95

      // 5. Specular clip, opposite the rim: the small hard highlight that
      //    tells the eye this surface is glass and not matte.
      const spec =
        Math.exp(-Math.pow((d - R * 0.80) / (R * 0.075), 2)) *
        Math.pow(clamp(-(nx * LIGHT[0] + ny * LIGHT[1])), 6) *
        body
      r += HOT[0] * spec * 0.55
      g += HOT[1] * spec * 0.6
      b += HOT[2] * spec * 0.65

      const i = (y * size + x) * 4
      rgba[i] = clamp(r, 0, 255)
      rgba[i + 1] = clamp(g, 0, 255)
      rgba[i + 2] = clamp(b, 0, 255)
      rgba[i + 3] = clamp(a * 255, 0, 255)
    }
  }
  return encodePng(size, size, rgba)
}

/**
 * The tray icon is the same mark at 32px.
 *
 * Deliberately not a simplified monochrome glyph: Windows tray icons sit on a
 * taskbar that may be light or dark, and this one already survives both
 * because the bright crescent carries the silhouette while the dark body
 * carries it the other way round. A single mark everywhere is also the point
 * of having one.
 */
const targets = [
  ['resources/icon.png', 1024],
  ['resources/tray-icon.png', 32]
]
for (const [path, size] of targets) {
  const png = render(size)
  writeFileSync(path, png)
  console.log(`${path.padEnd(32)} ${size}x${size}  ${png.length} bytes`)
}
