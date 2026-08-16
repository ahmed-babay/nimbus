import { desktopCapturer, session } from 'electron'

/**
 * Lets the renderer record what the computer is playing.
 *
 * Chromium routes `getDisplayMedia()` through a handler the app has to
 * install; without one the call is simply denied. Installing it is what makes
 * meeting capture and live subtitles possible at all — the other side of a
 * call, or a film's dialogue, only exists as system audio.
 *
 * On the privacy line this app holds to — explicit capture is fine, ambient
 * capture of content is not — this sits on the allowed side, but only just,
 * so the constraints matter:
 *
 * - A screen source has to be named because `getDisplayMedia` will not return
 *   an audio-only stream. The renderer stops the video track the instant it
 *   arrives, so no frame is ever read, encoded or stored.
 * - `useSystemPicker: false` means no OS dialog appears. That is deliberate:
 *   the user has already said "record this meeting" or "turn on subtitles",
 *   and a second confirmation for something they just asked for trains people
 *   to click through prompts. It also means nothing here may start on its own
 *   — every caller is a direct response to an explicit instruction, and the
 *   overlay shows that recording is running for as long as it is.
 */
export function enableSystemAudioCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            // Denies the request rather than throwing; the renderer surfaces
            // this as "couldn't capture system audio".
            callback({})
            return
          }
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch((error) => {
          console.error('[system-audio] could not list sources:', error)
          callback({})
        })
    },
    { useSystemPicker: false }
  )
}
