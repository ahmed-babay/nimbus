// Remote images are fetched here in the main process and handed to the
// renderer as base64 data URIs. Two reasons: the overlay's CSP is locked to
// 'self' (so remote <img> URLs would be blocked outright), and some hosts
// reject hotlinked requests that lack a normal User-Agent/Referer.

import { nativeImage } from 'electron'

const MAX_IMAGE_BYTES = 3_000_000 // cap on the *download*, before downscaling
const FETCH_TIMEOUT_MS = 4000
// 2x the card width, so images stay crisp on high-DPI displays and when
// shown large. Still a fraction of a full-resolution press photo.
const MAX_WIDTH = 1000
const JPEG_QUALITY = 86

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif'
])

/**
 * Downloads an image and returns it as a `data:` URI, or null if it's
 * missing, too large, not actually an image, or simply slow. Images are
 * decoration here — a failure must never take the whole answer down with it.
 */
export async function fetchImageAsDataUri(
  url: string | null | undefined,
  options: { keepTransparency?: boolean } = {}
): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NimbusAssistant/0.1 (personal desktop assistant)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_TYPES.has(contentType)) return null

    const declaredLength = Number(res.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_IMAGE_BYTES) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null

    // Downscale before base64-ing. A press photo can be several hundred KB at
    // full resolution but is displayed here in an 80px strip, and base64
    // inflates it another ~33% across the IPC boundary. nativeImage ships
    // with Electron, so this costs no extra dependency.
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return null

    const { width } = image.getSize()
    const sized = width > MAX_WIDTH ? image.resize({ width: MAX_WIDTH, quality: 'good' }) : image

    // Diagrams and line art arrive as PNGs with a transparent background.
    // Flattening those to JPEG paints the transparency black, which on a dark
    // card turns black-on-transparent line art into a black rectangle — so
    // those keep their alpha and the card supplies the backdrop.
    const transparent = options.keepTransparency && contentType === 'image/png'
    if (transparent) {
      const png = sized.toPNG()
      if (png.length === 0) return null
      return `data:image/png;base64,${png.toString('base64')}`
    }

    // JPEG re-encode: these are photographic thumbnails, where JPEG is far
    // smaller than PNG.
    const encoded = sized.toJPEG(JPEG_QUALITY)
    if (encoded.length === 0) return null

    return `data:image/jpeg;base64,${encoded.toString('base64')}`
  } catch {
    return null
  }
}

/** Fetches several images at once; failures come back as null, never throw. */
export async function fetchImagesAsDataUris(
  urls: Array<string | null | undefined>,
  options: { keepTransparency?: boolean } = {}
): Promise<Array<string | null>> {
  return Promise.all(urls.map((url) => fetchImageAsDataUri(url, options)))
}
