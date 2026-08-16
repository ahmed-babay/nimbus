import { useCallback, useRef, useState } from 'react'
import { useAudioCapture, type CapturedPiece } from './useAudioCapture'
import type { Subtitle } from '@shared/types'

/**
 * Live subtitle mode.
 *
 * Watching something in a language you don't read, with no subtitle track:
 * Nimbus listens to the computer's own audio, and translated lines appear at
 * the bottom of the screen. Nothing is spoken, the microphone is never opened,
 * and no chime plays — this mode is silent by design, because a sound effect
 * every few seconds during a film would be unbearable.
 *
 * Pieces are transcribed in parallel as they arrive, so a slow one never holds
 * up the next. That means results can come back out of order, which is why
 * lines are placed by their capture offset rather than appended on arrival.
 */

/** Lines kept on screen at once — enough to read a spillover sentence. */
const VISIBLE_LINES = 2
/** Total kept in memory, so the session can be reviewed after stopping. */
const MAX_LINES = 400

export interface SubtitleControls {
  active: boolean
  lines: Subtitle[]
  /** The most recent lines, oldest first, for display. */
  visible: Subtitle[]
  detected: string
  error: string
  start: () => Promise<void>
  stop: () => void
}

export function useSubtitles(): SubtitleControls {
  const [active, setActive] = useState(false)
  const [lines, setLines] = useState<Subtitle[]>([])
  const [detected, setDetected] = useState('')
  const [error, setError] = useState('')

  // The tail of the last line, fed to Whisper as context so a phrase cut at
  // the maximum piece length still transcribes as a continuation.
  const previousRef = useRef('')
  // First detected language, reused for the whole session — a film doesn't
  // change language, and the fallback translator can't detect one itself.
  const sourceRef = useRef('')
  const activeRef = useRef(false)

  const handlePiece = useCallback((piece: CapturedPiece) => {
    const previous = previousRef.current
    void window.nimbus
      .subtitleFor(piece.audio, piece.mimeType, piece.offsetMs, previous, sourceRef.current)
      .then((line) => {
        // A stop that lands mid-flight must not push a line onto a screen the
        // user has already cleared.
        if (!line || !activeRef.current) return

        previousRef.current = line.original
        if (line.detected && !sourceRef.current) {
          sourceRef.current = line.detected
          setDetected(line.detected)
        }

        setLines((current) => {
          const next = [...current, line]
          // Ordered by capture time, not arrival time.
          next.sort((a, b) => a.offsetMs - b.offsetMs)
          return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
        })
      })
      .catch(() => {
        // Deliberately silent: one lost line during a film is not worth
        // interrupting the film to report.
      })
  }, [])

  const capture = useAudioCapture({
    onPiece: handlePiece,
    onError: (message) => {
      setError(message)
      activeRef.current = false
      setActive(false)
    }
  })

  const start = useCallback(async () => {
    setError('')
    setLines([])
    setDetected('')
    previousRef.current = ''
    sourceRef.current = ''
    activeRef.current = true
    setActive(true)
    await capture.start(['system'])
  }, [capture])

  const stop = useCallback(() => {
    activeRef.current = false
    setActive(false)
    capture.stop()
  }, [capture])

  return {
    active,
    lines,
    visible: lines.slice(-VISIBLE_LINES),
    detected,
    error,
    start,
    stop
  }
}
