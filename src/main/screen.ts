import { desktopCapturer, screen } from 'electron'

// Wide enough that on-screen text stays legible to the model, small enough to
// keep the request quick. Gemini tokenizes by image area, so full 4K would be
// slower and no more accurate for reading an error dialog.
const CAPTURE_WIDTH = 1280
// Shown back to the user in the overlay so it's obvious what was captured.
const THUMBNAIL_WIDTH = 260

export interface ScreenCapture {
  /** Base64 JPEG (no data: prefix) — what gets sent to the vision model. */
  base64: string
  mimeType: string
  /** Small data URI for display in the overlay. */
  thumbnail: string
}

/**
 * Grabs the display the cursor is on. Capture is only ever triggered by an
 * explicit hotkey — never automatically — so the user always knows when a
 * screenshot has been taken, and the thumbnail shows exactly what was seen.
 */
export async function captureScreen(): Promise<ScreenCapture> {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width, height } = display.size
  const aspect = height / width

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: CAPTURE_WIDTH,
      height: Math.round(CAPTURE_WIDTH * aspect)
    }
  })

  if (sources.length === 0) {
    throw new Error("I couldn't capture the screen.")
  }

  // display_id is a string on some platforms and absent on others; fall back
  // to the first source rather than failing outright.
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]

  const image = source.thumbnail
  if (image.isEmpty()) {
    throw new Error("The screen capture came back empty.")
  }

  return {
    base64: image.toJPEG(80).toString('base64'),
    mimeType: 'image/jpeg',
    thumbnail: `data:image/jpeg;base64,${image
      .resize({ width: THUMBNAIL_WIDTH, quality: 'good' })
      .toJPEG(70)
      .toString('base64')}`
  }
}
