import { useCallback, useRef } from 'react'
import { toPcm } from '../lib/pcm'

/**
 * Long-running audio capture, cut into transcribable pieces.
 *
 * This is the shared layer under both meeting capture and live subtitles.
 * It differs from `useVoiceInput` in what it is for: that hook records one
 * turn and stops when you stop talking, because it is waiting to answer.
 * This one runs for an hour and never stops on its own, because it is only
 * listening.
 *
 * Two details here were found by measurement rather than reasoning, and both
 * matter more than they look:
 *
 * 1. Every piece needs its own MediaRecorder. A single recorder started with
 *    a timeslice emits the container header only in the first blob, so every
 *    later piece is an undecodable fragment that Whisper rejects.
 *
 * 2. The successor starts *before* its predecessor stops. Recording strictly
 *    back to back loses whatever falls in the gap between the two calls —
 *    in testing that swallowed four consecutive words at one boundary, and
 *    the transcript read as if the speaker had skipped them.
 *
 * Pieces are cut at pauses rather than on a stopwatch. A fixed interval cuts
 * through the middle of sentences, which wrecks translation ("we about the
 * situation on the financial markets. The interest") and makes a meeting
 * transcript hard to read. Waiting for a natural break costs a little latency
 * and is worth it every time.
 */

/**
 * Defaults suit a meeting, where accuracy matters and nobody is waiting on the
 * text. Subtitles override all three downwards — see `useSubtitles`, which
 * trades a little transcription context for a visibly shorter lag.
 */
/** Never cut shorter than this — tiny clips give Whisper too little context. */
const MIN_PIECE_MS = 2500
/** Cut anyway after this, so an unbroken monologue still produces output. */
const MAX_PIECE_MS = 7000
/** A gap this long is treated as a sentence boundary. */
const SILENCE_MS = 350
/** How long the outgoing and incoming recorders overlap. */
const OVERLAP_MS = 250
/** RMS below this counts as silence, on the 0..1 scale. */
const SILENCE_LEVEL = 0.012
const POLL_MS = 50

export type CaptureSource = 'system' | 'microphone'

export interface CapturedPiece {
  /**
   * 16kHz mono samples, already decoded. Speech models want raw samples and
   * only Chromium has the Opus codec, so the recording is unpacked here rather
   * than shipped compressed to the main process.
   */
  pcm: Float32Array
  source: CaptureSource
  /** Wall-clock ms since capture began, for ordering and timestamps. */
  offsetMs: number
  durationMs: number
}

export interface UseAudioCaptureOptions {
  onPiece: (piece: CapturedPiece) => void
  onError?: (message: string) => void
  /** Live level 0..1, for the recording indicator. */
  onLevel?: (level: number) => void
  /** Shortest piece to cut, even at a pause. Lower means faster, less context. */
  minPieceMs?: number
  /** Longest piece before cutting regardless. This is the worst-case lag. */
  maxPieceMs?: number
  /** Pause length that counts as a sentence boundary. */
  silenceMs?: number
}

export interface AudioCaptureControls {
  start: (sources: CaptureSource[]) => Promise<void>
  stop: () => void
  isSupported: boolean
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

/**
 * Chromium applies echo cancellation, noise suppression and gain control to
 * loopback audio by default, which is meant for a voice call and is wrong for
 * a film or a music track — it pumps the level and chews on anything that
 * isn't speech. Turning all three off measurably changed the stream (it also
 * stops being downmixed to mono).
 */
const RAW_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}

export function useAudioCapture({
  onPiece,
  onError,
  onLevel,
  minPieceMs = MIN_PIECE_MS,
  maxPieceMs = MAX_PIECE_MS,
  silenceMs = SILENCE_MS
}: UseAudioCaptureOptions): AudioCaptureControls {
  const streamsRef = useRef<MediaStream[]>([])
  const recordersRef = useRef<Set<MediaRecorder>>(new Set())
  const timersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set())
  const audioContextRef = useRef<AudioContext | null>(null)
  const startedAtRef = useRef(0)
  const runningRef = useRef(false)

  const isSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)

  const stop = useCallback(() => {
    runningRef.current = false
    timersRef.current.forEach((timer) => clearInterval(timer))
    timersRef.current.clear()
    // Stopping flushes each recorder's final blob through onstop, so the last
    // few seconds of a meeting aren't dropped on the way out.
    recordersRef.current.forEach((recorder) => {
      if (recorder.state !== 'inactive') recorder.stop()
    })
    recordersRef.current.clear()
    streamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()))
    streamsRef.current = []
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
  }, [])

  const start = useCallback(
    async (sources: CaptureSource[]) => {
      if (runningRef.current) return
      const mimeType = pickMimeType()
      if (!mimeType) {
        onError?.('This system has no supported audio recorder.')
        return
      }

      runningRef.current = true
      startedAtRef.current = Date.now()

      const context = new AudioContext()
      audioContextRef.current = context

      try {
        for (const source of sources) {
          const stream =
            source === 'system'
              ? await navigator.mediaDevices.getDisplayMedia({ audio: RAW_AUDIO, video: true })
              : await navigator.mediaDevices.getUserMedia({ audio: true })

          // Only the sound is wanted. Dropping the video track immediately
          // means no frame is ever decoded, let alone looked at.
          stream.getVideoTracks().forEach((track) => track.stop())

          const audioTracks = stream.getAudioTracks()
          if (audioTracks.length === 0) {
            throw new Error(
              source === 'system'
                ? "Windows didn't share any system audio. Check that something is playing."
                : 'No microphone was available.'
            )
          }

          streamsRef.current.push(stream)
          listen(new MediaStream(audioTracks), source, mimeType, context)
        }
      } catch (error) {
        stop()
        const message = error instanceof Error ? error.message : 'Could not start recording.'
        onError?.(message)
      }
    },
    // `listen` is defined below and closes over refs only, so it is stable in
    // practice; the deps here are the values that actually vary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [minPieceMs, maxPieceMs, silenceMs, onError, onPiece, onLevel, stop]
  )

  /**
   * Runs one source forever: record a piece, cut it at the next pause, hand it
   * over, and immediately begin the next — with the overlap described above.
   */
  function listen(
    stream: MediaStream,
    source: CaptureSource,
    mimeType: string,
    context: AudioContext
  ): void {
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)

    const level = (): number => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const value of samples) sum += value * value
      return Math.sqrt(sum / samples.length)
    }

    const beginPiece = (): void => {
      if (!runningRef.current) return

      const recorder = new MediaRecorder(stream, { mimeType })
      const parts: Blob[] = []
      const startedAt = Date.now()
      const offsetMs = startedAt - startedAtRef.current

      recordersRef.current.add(recorder)

      recorder.ondataavailable = (event): void => {
        if (event.data.size > 0) parts.push(event.data)
      }
      recorder.onstop = (): void => {
        recordersRef.current.delete(recorder)
        const blob = new Blob(parts, { type: mimeType })
        // Opus runs a few KB/s; anything smaller is a truncated container
        // rather than speech, and only wastes an upload.
        if (blob.size < 1024) return
        void toPcm(blob)
          .then((pcm) => {
            onPiece({
              pcm,
              source,
              offsetMs,
              durationMs: Date.now() - startedAt
            })
          })
          .catch((error) => {
            // A piece cut at an awkward boundary can be undecodable. Dropping
            // one is fine; stopping the capture over it is not.
            console.warn('[capture] could not decode a piece:', error)
          })
      }
      recorder.start()

      let quietMs = 0
      const poll = setInterval(() => {
        if (!runningRef.current) {
          clearInterval(poll)
          timersRef.current.delete(poll)
          return
        }

        const current = level()
        onLevel?.(Math.min(1, current * 8))
        quietMs = current < SILENCE_LEVEL ? quietMs + POLL_MS : 0

        const elapsed = Date.now() - startedAt
        const atPause = elapsed >= minPieceMs && quietMs >= silenceMs
        if (!atPause && elapsed < maxPieceMs) return

        clearInterval(poll)
        timersRef.current.delete(poll)
        beginPiece()
        setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop()
        }, OVERLAP_MS)
      }, POLL_MS)

      timersRef.current.add(poll)
    }

    beginPiece()
  }

  return { start, stop, isSupported }
}
