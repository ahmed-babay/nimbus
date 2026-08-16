import { useCallback, useEffect, useRef, useState } from 'react'
import { useAudioCapture, type CapturedPiece } from './useAudioCapture'

/**
 * Keeps the microphone open, waiting to hear the assistant's name.
 *
 * Every burst of speech is sent to the main process, which answers only
 * "yes, that was the wake phrase" or "no" — the words never come back here,
 * are never stored, and never leave the machine. The reasoning behind that
 * shape is in services/wake-word.ts.
 *
 * Two things switch it off automatically, and both matter more than they
 * look:
 *
 *  - **While the overlay is open.** Once Nimbus is listening properly there is
 *    nothing to wake, and running both would mean two recorders on one device.
 *  - **While Nimbus is speaking.** Otherwise it hears its own voice say the
 *    name and wakes itself, in a loop.
 */

/** Short, because a wake phrase is short — this is the latency the user feels. */
const MIN_PIECE_MS = 700
const MAX_PIECE_MS = 2400
const SILENCE_MS = 260

/**
 * Ignored for this long after waking. Without it, the tail of the same
 * sentence lands as a second burst and wakes the overlay again the moment the
 * user closes it.
 */
const REARM_MS = 1500

export interface UseWakeWordOptions {
  /** Called when the name was heard. */
  onWake: () => void
  /** True while the overlay is open or Nimbus is talking. */
  suspended: boolean
}

export function useWakeWord({ onWake, suspended }: UseWakeWordOptions): { listening: boolean } {
  const [listening, setListening] = useState(false)
  const wokeAtRef = useRef(0)
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  const handlePiece = useCallback((piece: CapturedPiece) => {
    if (Date.now() - wokeAtRef.current < REARM_MS) return

    void window.nimbus
      .wakeHeard(piece.pcm.buffer as ArrayBuffer)
      .then((heard) => {
        if (!heard) return
        wokeAtRef.current = Date.now()
        onWakeRef.current()
      })
      .catch(() => {
        // Runs continuously; a failed burst is not worth reporting.
      })
  }, [])

  const capture = useAudioCapture({
    onPiece: handlePiece,
    minPieceMs: MIN_PIECE_MS,
    maxPieceMs: MAX_PIECE_MS,
    silenceMs: SILENCE_MS
  })

  const { start, stop, isSupported } = capture

  useEffect(() => {
    let cancelled = false

    if (suspended || !isSupported) {
      stop()
      setListening(false)
      return
    }

    void window.nimbus.isWakeWordReady().then((ready) => {
      // Both the user's opt-in and the on-device recogniser, checked in the
      // main process where the config and the weights actually live.
      if (!ready || cancelled) return
      void start(['microphone'])
        .then(() => {
          if (cancelled) {
            stop()
            return
          }
          setListening(true)
        })
        .catch(() => setListening(false))
    })

    return () => {
      cancelled = true
      stop()
      setListening(false)
    }
  }, [suspended, isSupported, start, stop])

  return { listening }
}
