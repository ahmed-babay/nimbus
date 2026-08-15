import { useCallback, useRef } from 'react'
import { playListenEndChime, playListenStartChime } from '../lib/chime'

// Electron's Chromium doesn't ship the proprietary Google API key that the
// Web Speech API's SpeechRecognition needs, so it always fails with a
// "network" error here regardless of connectivity — this hook replaces it:
// record the mic via MediaRecorder, auto-stop on silence, send the audio to
// the main process (Groq's free Whisper endpoint) over IPC, and surface the
// transcript through the same onResult(text) shape SpeechRecognition used,
// so the rest of the app (useNimbus.ts) didn't need to change.

// Calibration starts *after* the listen-start chime has rung out, otherwise
// the mic samples the chime itself and inflates the room's noise floor.
const CALIBRATION_START_MS = 300
const CALIBRATION_END_MS = 700

// Absolute thresholds on the 0-255 RMS scale. Calibration may raise these for
// a noisy room but must never lower them: a purely relative threshold sank
// below ambient noise once speech started, so "still talking" stayed true
// forever and the recording never stopped.
// Deliberately forgiving: a threshold set too high ignores quiet microphones
// entirely (the turn ends with speechDetected=false and nothing is
// transcribed), whereas one set too low costs at most one short upload that
// comes back empty. The noise-floor multipliers below still raise the bar in
// a loud room.
const ABS_START_THRESHOLD = 7
const ABS_CONTINUE_THRESHOLD = 5
// Kept modest on purpose: in a noisy room speech is only ~2x above ambient,
// and a higher multiplier put the bar above the user's actual voice.
const START_MULTIPLIER = 1.8 // vs. calibrated floor, to decide talking *started*
const CONTINUE_MULTIPLIER = 1.6 // lower bar to stay "still talking" (hysteresis)

const SILENCE_MS = 1500 // auto-stop after this much continuous quiet
const MIN_RECORDING_MS = 500 // never cut off before this, avoids instant truncation
const NO_SPEECH_TIMEOUT_MS = 7000 // give up if the user never starts talking
const MAX_RECORDING_MS = 20000 // hard safety cap once they *are* talking
const TAIL_PADDING_MS = 350 // keep recording briefly after silence so final words aren't clipped
// Opus runs ~3KB/s, so this is well under a second of speech — big enough to
// reject a truncated container, small enough to keep genuine short answers.
const MIN_UPLOAD_BYTES = 600

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

export interface UseVoiceInputOptions {
  onResult: (transcript: string) => void
  onEnd?: () => void
  onError?: (error: string) => void
  /** Live mic level, 0..1 — drives the waveform visualisation. */
  onLevel?: (level: number) => void
}

export interface VoiceInputControls {
  start: () => void
  stop: () => void
  isSupported: boolean
}

export function useVoiceInput({
  onResult,
  onEnd,
  onError,
  onLevel
}: UseVoiceInputOptions): VoiceInputControls {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Incremented per start(). MediaRecorder.onstop is async, so a follow-up
  // turn can begin before the previous one finishes; this lets a stale
  // session detect that it's been superseded and bow out quietly.
  const sessionIdRef = useRef(0)

  const isSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)

  const cleanup = useCallback(() => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current)
      stopTimeoutRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    mediaRecorderRef.current = null
  }, [])

  const stop = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    } else {
      cleanup()
    }
  }, [cleanup])

  const start = useCallback(() => {
    if (!isSupported) {
      onError?.('Microphone recording is not supported in this environment.')
      return
    }

    const sessionId = ++sessionIdRef.current
    // Session-local, not shared refs: a new turn resetting a shared chunk
    // array wiped audio out from under the previous turn's pending onstop,
    // which uploaded a truncated blob and got "not a valid media file" back.
    const chunks: Blob[] = []
    const speech = { detected: false }
    // Declared up here so recorder.onstop (assigned before the analyser is
    // built) can report them.
    const metrics = { peak: 0, threshold: 0, startedAt: Date.now() }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (sessionId !== sessionIdRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream

        const mimeType = pickMimeType()
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
        mediaRecorderRef.current = recorder

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data)
        }

        recorder.onstop = () => {
          playListenEndChime()
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          const spoke = speech.detected
          cleanup()

          console.log(
            `[voice] turn ended — ${chunks.length} chunks, ${blob.size} bytes, ` +
              `${Date.now() - metrics.startedAt}ms, speechDetected=${spoke}, ` +
              `peakLevel=${metrics.peak.toFixed(1)} vs threshold=${metrics.threshold.toFixed(1)}, ` +
              `session=${sessionId}/${sessionIdRef.current}`
          )

          // Superseded by a newer turn — drop this one silently.
          if (sessionId !== sessionIdRef.current) {
            console.log('[voice] superseded by a newer turn, discarding')
            return
          }

          // Never transcribe a turn with no detected speech — uploading near
          // silence is what made Whisper invent replies out of nothing. The
          // size floor also avoids shipping a truncated container.
          if (blob.size < MIN_UPLOAD_BYTES || !spoke) {
            console.log(
              `[voice] skipping transcription (${!spoke ? 'no speech detected' : `only ${blob.size} bytes`})`
            )
            onEnd?.()
            return
          }

          blob
            .arrayBuffer()
            .then((buffer) => window.nimbus.transcribeAudio(buffer, blob.type))
            .then((transcript) => {
              if (transcript) {
                console.log(`[voice] transcript: "${transcript}"`)
                onResult(transcript)
              } else {
                console.log('[voice] transcription returned empty text')
                onEnd?.()
              }
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : 'Transcription failed.'
              console.error(`[voice] transcription error: ${message}`)
              onError?.(message)
            })
        }

        // Timeslice: flush chunks as they're captured rather than relying on
        // a single flush at stop(), so nothing is lost if the stream ends
        // abruptly.
        recorder.start(250)
        playListenStartChime()

        // Silence detection: auto-stop once the mic has been quiet for a
        // beat so the user doesn't have to press anything to end their turn.
        const audioContext = new AudioContext()
        audioContextRef.current = audioContext
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)

        const data = new Uint8Array(analyser.frequencyBinCount)
        const startedAt = Date.now()
        let lastLoudAt = Date.now()

        // Calibrate against the actual room instead of a hardcoded level: a
        // fixed threshold clipped people with quiet mics, and treated fan
        // noise as speech on loud ones.
        let noiseFloor = 0
        let calibrationSamples = 0

        const interval = setInterval(() => {
          // A previous turn's interval used to outlive its session — the
          // shared ref was overwritten, so it was never cleared, and it went
          // on calling stop() on whichever recorder was current. That cut new
          // recordings short after a few hundred milliseconds.
          if (sessionId !== sessionIdRef.current) {
            clearInterval(interval)
            return
          }

          analyser.getByteTimeDomainData(data)
          let sumSquares = 0
          for (let i = 0; i < data.length; i++) {
            const centered = data[i] - 128
            sumSquares += centered * centered
          }
          const rms = Math.sqrt(sumSquares / data.length)
          onLevel?.(Math.min(1, rms / 40))

          const now = Date.now()
          const elapsed = now - startedAt

          // Skip the chime, then sample the room before judging any speech.
          if (elapsed < CALIBRATION_END_MS) {
            if (elapsed >= CALIBRATION_START_MS) {
              noiseFloor = (noiseFloor * calibrationSamples + rms) / (calibrationSamples + 1)
              calibrationSamples++
            }
            lastLoudAt = now
            return
          }

          // Keep tracking ambient after calibration: a one-shot sample taken
          // during a momentarily quiet instant under-estimates a noisy room,
          // leaving the "still talking" bar below the room's own hum so the
          // recording never ended. Falls fast toward true quiet, rises slowly
          // so speech itself barely moves it.
          noiseFloor =
            rms < noiseFloor ? noiseFloor * 0.9 + rms * 0.1 : noiseFloor * 0.999 + rms * 0.001

          // Hysteresis: it takes a clear signal to *start* counting as speech,
          // but a weaker one to keep it going, since sentence endings trail off
          // in volume. Both are clamped to absolute minimums so a quiet room
          // can't drive the "still talking" bar below ambient noise.
          const threshold = speech.detected
            ? Math.max(ABS_CONTINUE_THRESHOLD, noiseFloor * CONTINUE_MULTIPLIER)
            : Math.max(ABS_START_THRESHOLD, noiseFloor * START_MULTIPLIER)

          metrics.peak = Math.max(metrics.peak, rms)
          metrics.threshold = threshold

          if (rms > threshold) {
            lastLoudAt = now
            speech.detected = true
          }

          const quietFor = now - lastLoudAt

          if (speech.detected) {
            if (elapsed > MIN_RECORDING_MS && quietFor > SILENCE_MS + TAIL_PADDING_MS) stop()
          } else if (elapsed > NO_SPEECH_TIMEOUT_MS) {
            // Nothing said at all — close the turn promptly instead of
            // holding the mic open for the full cap.
            stop()
          }
        }, 100)

        silenceTimerRef.current = interval
        stopTimeoutRef.current = setTimeout(() => {
          if (sessionId === sessionIdRef.current) stop()
        }, MAX_RECORDING_MS)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Microphone access was denied.'
        onError?.(message)
      })
  }, [isSupported, onResult, onEnd, onError, onLevel, cleanup, stop])

  return { start, stop, isSupported }
}
