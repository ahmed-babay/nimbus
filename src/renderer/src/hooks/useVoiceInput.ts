import { useCallback, useRef } from 'react'
import { playListenEndChime, playListenStartChime } from '../lib/chime'
import { isLikelyNoise } from '../lib/noise-transcripts'
import { toPcm } from '../lib/pcm'

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

// How long to wait for more speech before deciding the turn is over. This is
// adaptive: early in an utterance someone is often still assembling the
// sentence, so pauses get more room. Once they've been speaking for a while a
// pause much more likely means "done", and waiting the full early window just
// feels laggy.
const SILENCE_MS_EARLY = 1300
const SILENCE_MS_SETTLED = 900
const SPEECH_SETTLED_MS = 1500 // speech duration after which the shorter window applies

const MIN_RECORDING_MS = 500 // never cut off before this, avoids instant truncation
// Asked to listen and heard nothing, Nimbus should let go of the microphone
// rather than sit there holding it open. Five seconds is long enough to gather
// a thought and short enough that a mistaken wake word costs nothing.
const NO_SPEECH_TIMEOUT_MS = 5000
const MAX_RECORDING_MS = 20000 // hard safety cap once they *are* talking
// Small margin so a trailing consonant isn't clipped. The hysteresis below
// does most of that work, so this stays short — it's pure added latency.
const TAIL_PADDING_MS = 150
// Speech band. The low edge sits at 150Hz rather than 300 so male voices,
// whose fundamental runs 85-180Hz, aren't half-excluded; the high edge covers
// the formants that carry intelligibility.
const VOICE_BAND_LOW_HZ = 150
const VOICE_BAND_HIGH_HZ = 4000

// Energy alone can't tell a voice from a fan — measured on synthesised
// signals, a 100Hz hum scored 5.48 on a voice-band/total-energy ratio against
// speech's 6.29, nowhere near separable. Speech's real signature is that it
// *fluctuates*: syllables modulate the level several times a second, while
// fans, hiss and hum hold steady. This tracks that variation over a ~1s
// window and requires it before calling something speech.
const MODULATION_WINDOW = 16 // samples at POLL_MS ≈ 1 second
const MODULATION_MIN = 0.18 // coefficient of variation; steady noise sits near 0
// How long a lull in modulation is forgiven once someone is definitely
// speaking. Long enough to carry a held vowel or a drawn-out word, short
// enough that steady room noise stops qualifying shortly after they finish.
const MODULATION_GRACE_MS = 1200
const POLL_MS = 60 // detection granularity; also the jitter floor on stopping
// Opus runs ~3KB/s, so this is well under a second of speech — big enough to
// reject a truncated container, small enough to keep genuine short answers.
const MIN_UPLOAD_BYTES = 600
// Total time actually above the speech threshold. A cough, a keystroke or a
// chair creak can trip the threshold for a moment; Whisper then invents
// filler ("." / "you" / "Thank you.") from what is effectively silence.
// Requiring a real amount of voiced audio filters those out before upload.
const MIN_VOICED_MS = 320

// --- Neural voice activity detection -------------------------------------
//
// Everything above is energy: how loud, in which band, fluctuating how much.
// None of it can tell a voice from a train, because a train fluctuates too.
// Silero VAD can — it is a small model trained on that exact distinction, and
// it runs in the main process (see services/vad.ts). Measured there, noise on
// its own never crossed 0.5 even when scaled as loud as speech.
//
// Two thresholds rather than one, because a single one chatters on the frames
// either side of it: it takes a confident frame to call speech started, and a
// clearly unvoiced one to call it stopped.
const VAD_START = 0.5
const VAD_CONTINUE = 0.35
// The model reports per 32ms frame; the AudioContext hands us 1024 samples at
// a time, which is two frames.
const VAD_SAMPLE_RATE = 16000
const VAD_BUFFER_SAMPLES = 1024
// If no probability has come back in this long the model has stalled, and the
// energy heuristic takes over rather than the last reading standing forever.
const VAD_STALE_MS = 400

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
  /** Overrides SILENCE_MS_SETTLED from config, so end-of-turn responsiveness
   *  is tunable without editing code. */
  endOfSpeechMs?: number
}

export interface VoiceInputControls {
  start: () => void
  stop: () => void
  /** Stop and discard — nothing gets transcribed. */
  cancel: () => void
  isSupported: boolean
}

export function useVoiceInput({
  onResult,
  onEnd,
  onError,
  onLevel,
  endOfSpeechMs
}: UseVoiceInputOptions): VoiceInputControls {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Identifies this turn's VAD state in the main process, so it can be freed. */
  const vadIdRef = useRef<string | null>(null)
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
    // The VAD is recurrent, so its state is per-turn and has to be released or
    // the tail of this utterance colours the start of the next one.
    if (vadIdRef.current) {
      window.nimbus.vadSession(vadIdRef.current, false)
      vadIdRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    mediaRecorderRef.current = null
  }, [])

  /**
   * Abandons the current turn outright: whatever was recorded is dropped
   * rather than uploaded. Bumping the session id makes the in-flight `onstop`
   * see itself as superseded, so a turn cancelled by closing the overlay
   * can't come back a second later as a spoken answer.
   */
  const cancel = useCallback(() => {
    sessionIdRef.current += 1
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    cleanup()
  }, [cleanup])

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
    const metrics = {
      peak: 0,
      threshold: 0,
      startedAt: Date.now(),
      voicedMs: 0,
      peakRatio: 0,
      peakModulation: 0,
      peakVad: 0,
      vadUsed: false
    }

    navigator.mediaDevices
      // Chromium's own DSP does the first pass: noise suppression strips
      // steady background noise before it ever reaches the detector, and echo
      // cancellation stops Nimbus's own voice being heard as user speech.
      .getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true
        }
      })
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
              `${metrics.vadUsed ? `vad=neural peakProb=${metrics.peakVad.toFixed(2)} (need >${VAD_START})` : `vad=heuristic peakRatio=${metrics.peakRatio.toFixed(2)} peakModulation=${metrics.peakModulation.toFixed(2)} (need >${MODULATION_MIN})`}, ` +
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
          if (blob.size < MIN_UPLOAD_BYTES || !spoke || metrics.voicedMs < MIN_VOICED_MS) {
            const why = !spoke
              ? 'no speech detected'
              : metrics.voicedMs < MIN_VOICED_MS
                ? `only ${metrics.voicedMs}ms of voiced audio`
                : `only ${blob.size} bytes`
            console.log(`[voice] skipping transcription (${why})`)
            onEnd?.()
            return
          }

          toPcm(blob)
            .then((pcm) => window.nimbus.transcribeAudio(pcm.buffer as ArrayBuffer))
            .then((transcript) => {
              if (!transcript) {
                console.log('[voice] transcription returned empty text')
                onEnd?.()
                return
              }
              if (isLikelyNoise(transcript)) {
                console.log(`[voice] discarding noise transcript: "${transcript}"`)
                onEnd?.()
                return
              }
              console.log(`[voice] transcript: "${transcript}"`)
              onResult(transcript)
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
        // Opened at 16kHz rather than the hardware rate so Chromium does the
        // resampling the VAD needs, in native code, before we see a sample.
        // Doing it in JS would be another buffer and another chance to get the
        // filtering wrong. The FFT maths below reads sampleRate off the
        // context, so it follows along on its own.
        const audioContext = new AudioContext({ sampleRate: VAD_SAMPLE_RATE })
        audioContextRef.current = audioContext
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        // 1024 gives ~47Hz bins at 48kHz — enough resolution to isolate the
        // voice band rather than lumping all sound into one number.
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.3
        source.connect(analyser)

        const data = new Uint8Array(analyser.frequencyBinCount)

        // Map the voice band onto FFT bins for this context's sample rate.
        const binHz = audioContext.sampleRate / analyser.fftSize
        const voiceLowBin = Math.max(1, Math.floor(VOICE_BAND_LOW_HZ / binHz))
        const voiceHighBin = Math.min(
          analyser.frequencyBinCount - 1,
          Math.ceil(VOICE_BAND_HIGH_HZ / binHz)
        )
        const startedAt = Date.now()
        let lastLoudAt = Date.now()
        let speechStartedAt = Date.now()
        const levelHistory: number[] = []

        // --- Silero VAD tap ---
        // A second branch off the same source: the analyser answers "how
        // loud", this answers "is that a person".
        const vadId = `turn-${sessionId}`
        vadIdRef.current = vadId
        window.nimbus.vadSession(vadId, true)

        let vadProb = 0
        let vadReady = false
        let vadBusy = false
        let lastVadAt = 0

        const processor = audioContext.createScriptProcessor(VAD_BUFFER_SAMPLES, 1, 1)
        processor.onaudioprocess = (event) => {
          if (sessionId !== sessionIdRef.current) return
          // Dropped rather than queued when inference is still running. It
          // never is — a frame costs 0.117ms against the 64ms it represents —
          // but if it ever fell behind, a backlog of stale probabilities would
          // be worse than a gap.
          if (vadBusy) return
          vadBusy = true
          // Copied: the input buffer is reused by the audio thread, so passing
          // it straight to IPC would send whatever arrives next instead.
          const frame = new Float32Array(event.inputBuffer.getChannelData(0))
          window.nimbus
            .vadFrames(vadId, frame.buffer as ArrayBuffer)
            .then((probabilities) => {
              // Empty means the model isn't loaded — still downloading, or
              // offline on a first run. That is "no opinion", not "silence",
              // so the heuristic below stays in charge.
              if (probabilities.length === 0) return
              vadReady = true
              lastVadAt = Date.now()
              vadProb = Math.max(...probabilities)
            })
            .catch(() => {})
            .finally(() => {
              vadBusy = false
            })
        }
        source.connect(processor)
        // A ScriptProcessorNode only runs while connected to the destination.
        // It writes nothing to its output, so this is silent.
        processor.connect(audioContext.destination)

        // Calibrate against the actual room instead of a hardcoded level: a
        // fixed threshold clipped people with quiet mics, and treated fan
        // noise as speech on loud ones.
        let noiseFloor = 0
        let calibrationSamples = 0
        // Last moment the signal actually fluctuated like speech.
        let lastModulatedAt = 0

        const interval = setInterval(() => {
          // A previous turn's interval used to outlive its session — the
          // shared ref was overwritten, so it was never cleared, and it went
          // on calling stop() on whichever recorder was current. That cut new
          // recordings short after a few hundred milliseconds.
          if (sessionId !== sessionIdRef.current) {
            clearInterval(interval)
            return
          }

          // Frequency domain, not raw amplitude. Plain energy can't tell a
          // voice from a fan, a keyboard or music — which is why background
          // noise kept the recording alive after the user stopped talking.
          analyser.getByteFrequencyData(data)

          let voiceSum = 0
          let outsideSum = 0
          let outsideCount = 0
          for (let i = 1; i < data.length; i++) {
            if (i >= voiceLowBin && i <= voiceHighBin) {
              voiceSum += data[i]
            } else {
              outsideSum += data[i]
              outsideCount++
            }
          }
          const voiceLevel = voiceSum / (voiceHighBin - voiceLowBin + 1)
          const outsideLevel = outsideCount > 0 ? outsideSum / outsideCount : 0
          // Voice band measured against everything outside it, which rejects
          // broadband hiss and out-of-band rumble.
          const voiceRatio = voiceLevel / (outsideLevel + 1)

          // Rolling variation of the voice-band level. Speech swings with
          // every syllable; a fan or hiss holds flat.
          levelHistory.push(voiceLevel)
          if (levelHistory.length > MODULATION_WINDOW) levelHistory.shift()
          let modulation = 0
          if (levelHistory.length >= MODULATION_WINDOW) {
            const mean = levelHistory.reduce((a, b) => a + b, 0) / levelHistory.length
            if (mean > 1) {
              const variance =
                levelHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / levelHistory.length
              modulation = Math.sqrt(variance) / mean
            }
          }

          onLevel?.(Math.min(1, voiceLevel / 45))

          const now = Date.now()
          const elapsed = now - startedAt

          // Skip the chime, then sample the room before judging any speech.
          if (elapsed < CALIBRATION_END_MS) {
            if (elapsed >= CALIBRATION_START_MS) {
              noiseFloor = (noiseFloor * calibrationSamples + voiceLevel) / (calibrationSamples + 1)
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
            voiceLevel < noiseFloor
              ? noiseFloor * 0.9 + voiceLevel * 0.1
              : noiseFloor * 0.999 + voiceLevel * 0.001

          // Hysteresis: it takes a clear signal to *start* counting as speech,
          // but a weaker one to keep it going, since sentence endings trail off
          // in volume. Both are clamped to absolute minimums so a quiet room
          // can't drive the "still talking" bar below ambient noise.
          const threshold = speech.detected
            ? Math.max(ABS_CONTINUE_THRESHOLD, noiseFloor * CONTINUE_MULTIPLIER)
            : Math.max(ABS_START_THRESHOLD, noiseFloor * START_MULTIPLIER)

          // Loud enough, in the right band, and actually varying. Steady
          // noise fails the last test no matter how loud it is, which is what
          // stops a fan or background hum from holding the recording open.
          // Once speech is established the modulation gate is relaxed, so a
          // sustained word isn't cut off mid-vowel.
          const loudEnough = voiceLevel > threshold
          const inVoiceBand = voiceRatio > 1.1
          if (modulation > MODULATION_MIN) lastModulatedAt = now

          let isSpeech: boolean
          metrics.peakVad = Math.max(metrics.peakVad, vadProb)
          if (vadReady && now - lastVadAt < VAD_STALE_MS) {
            metrics.vadUsed = true
            // The model decides what counts as a voice. The energy test in
            // front of it is only the absolute floor, deliberately not the
            // calibrated one: in a loud room the calibrated bar climbs above
            // the user's own voice, which is the failure this whole change
            // exists to fix. All it does here is stop a conversation on the
            // other side of the room being recorded as if it were the user.
            const audible =
              voiceLevel > (speech.detected ? ABS_CONTINUE_THRESHOLD : ABS_START_THRESHOLD)
            isSpeech = vadProb > (speech.detected ? VAD_CONTINUE : VAD_START) && audible
          } else {
            // Fallback while the model is still downloading, or if it failed
            // to load at all. This is the old detector, kept intact so voice
            // input degrades rather than stops.
            //
            // The modulation test used to be waived permanently once speech
            // had been detected, to avoid cutting someone off mid-vowel. That
            // left no way back: after the first word of a turn, any steady
            // noise above the floor satisfied every test, so the recording ran
            // to its 20-second cap while the user sat in silence wondering why
            // it was still listening. Waiving it for a short grace window
            // instead keeps held vowels intact and still lets a quiet room end
            // the turn.
            const recentlyModulated = now - lastModulatedAt < MODULATION_GRACE_MS
            const varying = modulation > MODULATION_MIN || (speech.detected && recentlyModulated)
            isSpeech = loudEnough && inVoiceBand && varying
          }

          metrics.peak = Math.max(metrics.peak, voiceLevel)
          metrics.threshold = threshold
          metrics.peakRatio = Math.max(metrics.peakRatio, voiceRatio)
          metrics.peakModulation = Math.max(metrics.peakModulation, modulation)

          if (isSpeech) {
            lastLoudAt = now
            if (!speech.detected) speechStartedAt = now
            speech.detected = true
            metrics.voicedMs += POLL_MS
          }

          const quietFor = now - lastLoudAt

          if (speech.detected) {
            // Someone a few seconds into a sentence who goes quiet is very
            // likely finished; someone who just started may still be
            // assembling it. Shortening the window once they're settled is
            // what makes the end of a turn feel immediate.
            const settled = endOfSpeechMs ?? SILENCE_MS_SETTLED
            const speakingFor = now - speechStartedAt
            const silenceWindow =
              speakingFor > SPEECH_SETTLED_MS ? settled : Math.max(settled, SILENCE_MS_EARLY)
            if (elapsed > MIN_RECORDING_MS && quietFor > silenceWindow + TAIL_PADDING_MS) stop()
          } else if (elapsed > NO_SPEECH_TIMEOUT_MS) {
            // Nothing said at all — close the turn promptly instead of
            // holding the mic open for the full cap.
            stop()
          }
        }, POLL_MS)

        silenceTimerRef.current = interval
        stopTimeoutRef.current = setTimeout(() => {
          if (sessionId === sessionIdRef.current) stop()
        }, MAX_RECORDING_MS)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Microphone access was denied.'
        onError?.(message)
      })
  }, [isSupported, onResult, onEnd, onError, onLevel, endOfSpeechMs, cleanup, stop])

  return { start, stop, cancel, isSupported }
}
