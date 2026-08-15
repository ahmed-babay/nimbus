import { desktopCapturer, screen, type NativeImage } from 'electron'

// Wide enough that on-screen text stays legible to the model, small enough to
// keep the request quick. Gemini tokenizes by image area, so full 4K would be
// slower and no more accurate for reading an error dialog.
const MAX_SEND_WIDTH = 1280
// Shown back to the user in the overlay so it's obvious what was captured.
const THUMBNAIL_WIDTH = 260

export interface ScreenCapture {
  /** Base64 JPEG (no data: prefix) — what gets sent to the vision model. */
  base64: string
  mimeType: string
  /** Small data URI for display in the overlay. */
  thumbnail: string
}

/** Fractional selection (0..1) of the captured image, from the region picker. */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Grabs the display the cursor is on at its native resolution, so a region
 * cropped out of it still has enough detail to read.
 */
export async function captureDisplayImage(): Promise<{
  image: NativeImage
  bounds: Electron.Rectangle
}> {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width, height } = display.size

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })

  if (sources.length === 0) {
    throw new Error("I couldn't capture the screen.")
  }

  // display_id is a string on some platforms and absent on others; fall back
  // to the first source rather than failing outright.
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]

  if (source.thumbnail.isEmpty()) {
    throw new Error('The screen capture came back empty.')
  }

  return { image: source.thumbnail, bounds: display.bounds }
}

/**
 * Crops to a fractional region and encodes for sending. Cropping happens at
 * native resolution *before* the downscale, so selecting a small area gives
 * the model a genuinely sharper view of it rather than an enlarged blur.
 */
export function encodeCapture(image: NativeImage, region?: CaptureRegion): ScreenCapture {
  let framed = image

  if (region) {
    const { width, height } = image.getSize()
    const cropped = image.crop({
      x: Math.max(0, Math.round(region.x * width)),
      y: Math.max(0, Math.round(region.y * height)),
      // At least a few pixels, or crop throws.
      width: Math.max(8, Math.round(region.width * width)),
      height: Math.max(8, Math.round(region.height * height))
    })
    if (!cropped.isEmpty()) framed = cropped
  }

  const { width } = framed.getSize()
  const sized = width > MAX_SEND_WIDTH ? framed.resize({ width: MAX_SEND_WIDTH }) : framed

  return {
    base64: sized.toJPEG(80).toString('base64'),
    mimeType: 'image/jpeg',
    thumbnail: `data:image/jpeg;base64,${framed
      .resize({ width: THUMBNAIL_WIDTH, quality: 'good' })
      .toJPEG(70)
      .toString('base64')}`
  }
}

/**
 * Whole-display capture, used when region selection is turned off or the user
 * picks the full screen from the region picker.
 */
export async function captureScreen(): Promise<ScreenCapture> {
  const { image } = await captureDisplayImage()
  return encodeCapture(image)
}
