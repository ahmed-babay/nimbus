import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { NimbusConfig, NimbusResponse, NimbusState } from '@shared/types'
import { useVoiceInput } from './useVoiceInput'
import { useRadioPlayer, type RadioPlayerControls } from './useRadioPlayer'
import { isStopPhrase, isStopPlaybackPhrase } from '../lib/stop-phrases'

const DEFAULT_AUTO_FADE_MS = 8000
// When an answer is on screen it needs reading time — headlines, a photo and
// an extract take far longer to take in than the fade meant for an empty
// overlay, and closing at 8s made results feel like they vanished instantly.
const READING_AUTO_FADE_MS = 45000

export interface NimbusOverlayState {
  state: NimbusState
  mode: 'assistant' | 'settings'
  response: NimbusResponse | null
  error: string | null
  transcript: string | null
  /** Partial answer text while the model is still generating. */
  streamingText: string
  /** Screenshot captured and awaiting a question. */
  pendingCapture: string | null
  config: NimbusConfig | null
  /** In-app radio playback state and controls. */
  radio: RadioPlayerControls
  /** Live mic level 0..1. A ref, not state — the waveform reads it on each
   *  animation frame, so it never triggers a React re-render. */
  levelRef: RefObject<number>
  /** 0..1 progress through the spoken response, for the synced text reveal. */
  speechProgressRef: RefObject<number>
  dismiss: () => void
}

export function useNimbus(): NimbusOverlayState {
  const [state, setState] = useState<NimbusState>('idle')
  const [mode, setMode] = useState<'assistant' | 'settings'>('assistant')
  const [response, setResponse] = useState<NimbusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<string | null>(null)
  /** Answer text accumulating live from the model, shown while thinking. */
  const [streamingText, setStreamingText] = useState('')
  /** Screenshot awaiting a question about it, shown above the waveform. */
  const [pendingCapture, setPendingCapture] = useState<string | null>(null)
  const [config, setConfig] = useState<NimbusConfig | null>(null)

  const radio = useRadioPlayer()
  const radioRef = useRef(radio)
  useEffect(() => {
    radioRef.current = radio
  }, [radio])

  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const levelRef = useRef(0)
  /** 0..1 through the current spoken response — drives the text reveal. */
  const speechProgressRef = useRef(1)
  /** Whether an answer is currently displayed, read by the fade scheduler. */
  const hasContentRef = useRef(false)
  /** Starts the station once the spoken confirmation has finished, so the
   *  announcement isn't talked over by the music. */
  const startPendingRadioRef = useRef<(() => void) | null>(null)
  /** Set the moment a station is requested. `radio.isPlaying` only flips on
   *  the audio element's 'playing' event, which is too late for the decision
   *  about whether to reopen the mic. */
  const radioActiveRef = useRef(false)
  /** True while the station is paused purely so the mic can hear the user —
   *  resumed if they say nothing, dropped if they ask something new. */
  const pausedForListeningRef = useRef(false)

  // Mirror of `state` for callbacks that need the current value without
  // being re-created (or reading it inside a setState updater).
  const stateRef = useRef<NimbusState>('idle')
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    hasContentRef.current = Boolean(response || error)
  }, [response, error])

  const handleLevel = useCallback((level: number) => {
    levelRef.current = level
  }, [])

  const clearFadeTimer = useCallback(() => {
    if (fadeTimer.current) {
      clearTimeout(fadeTimer.current)
      fadeTimer.current = null
    }
  }, [])

  const stopPlayback = useCallback(() => {
    const source = currentSourceRef.current
    currentSourceRef.current = null
    if (source) {
      source.onended = null
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
    }
  }, [])

  const dismiss = useCallback(() => {
    clearFadeTimer()
    window.speechSynthesis?.cancel()
    stopPlayback()
    radioActiveRef.current = false
    startPendingRadioRef.current = null
    radioRef.current.stop()
    stopVoiceInputRef.current?.()
    setState('idle')
    setResponse(null)
    setError(null)
    setTranscript(null)
    setPendingCapture(null)
    // Each time the overlay closes the conversation ends, so the next
    // session doesn't inherit stale context from an old topic.
    window.nimbus.resetConversation()
    window.nimbus.hide()
  }, [clearFadeTimer, stopPlayback])

  const scheduleAutoFade = useCallback(() => {
    clearFadeTimer()
    // Never close while a station is playing — closing tears down the audio
    // element and the music would just stop. "stop" or Esc ends it.
    if (radioActiveRef.current) return
    // Give the user real reading time whenever there's an answer on screen.
    const autoFadeMs = hasContentRef.current
      ? READING_AUTO_FADE_MS
      : (config?.overlay.autoFadeMs ?? DEFAULT_AUTO_FADE_MS)
    fadeTimer.current = setTimeout(dismiss, autoFadeMs)
  }, [clearFadeTimer, config, dismiss])

  // After Nimbus finishes speaking, listen again for a follow-up instead of
  // immediately fading out — otherwise every turn required pressing the
  // hotkey again, which reads as "it won't let me speak anymore." If the
  // follow-up listen captures nothing, handleVoiceEnd's existing silence
  // handling schedules the fade-out, so the conversation still ends on its
  // own once the user stops responding.
  const listenAgain = useCallback(() => {
    clearFadeTimer()
    // Don't reopen the mic over a playing station: the speakers feed straight
    // back into it, and Whisper happily transcribes the music as commands.
    // The player stays on screen; Esc or the hotkey starts a new turn.
    if (radioActiveRef.current) {
      setState('playing')
      return
    }
    // The answer stays on screen while listening for a follow-up. Clearing it
    // here meant news headlines and charts vanished the instant Nimbus stopped
    // talking, leaving nothing to actually read.
    setState('listening')
    startVoiceInputRef.current?.()
  }, [clearFadeTimer])

  // Fallback if the Edge neural voice (below) is unreachable — the local
  // Windows SAPI voice is robotic, but it's better than staying silent.
  const speakNative = useCallback(
    (text: string) => {
      if (!window.speechSynthesis) {
        scheduleAutoFade()
        return
      }
      window.speechSynthesis.cancel()
      // No audio clock available on this path, so show the text in full
      // rather than leaving it stuck mid-reveal.
      speechProgressRef.current = 1
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.onend = listenAgain
      utterance.onerror = scheduleAutoFade
      window.speechSynthesis.speak(utterance)
    },
    [listenAgain, scheduleAutoFade]
  )

  // Plays the Edge neural voice through the Web Audio API rather than an
  // <audio> element: decodeAudioData reports *why* audio failed instead of a
  // bare onerror, and an explicitly resumed AudioContext isn't subject to the
  // element autoplay gating that silently dropped us to the robotic fallback.
  const speak = useCallback(
    (text: string) => {
      window.nimbus
        .synthesizeSpeech(text)
        .then(async ({ audio, mimeType }) => {
          console.log(
            `[nimbus] TTS audio received: ${audio?.byteLength ?? 0} bytes (${mimeType})`
          )
          if (!audio || audio.byteLength === 0) {
            throw new Error('empty audio buffer from main process')
          }

          const ctx = audioCtxRef.current ?? new AudioContext()
          audioCtxRef.current = ctx
          if (ctx.state === 'suspended') await ctx.resume()

          // decodeAudioData detaches the buffer it's given, so hand it a copy.
          const buffer = await ctx.decodeAudioData(audio.slice(0))

          stopPlayback()
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)
          source.onended = () => {
            currentSourceRef.current = null
            speechProgressRef.current = 1
            startPendingRadioRef.current?.()
            listenAgain()
          }
          currentSourceRef.current = source

          // Drive the on-screen text reveal from the audio clock, so words
          // appear as they're actually spoken rather than all at once.
          const startedAt = ctx.currentTime
          const duration = buffer.duration
          speechProgressRef.current = 0
          const tickProgress = (): void => {
            if (currentSourceRef.current !== source) return
            speechProgressRef.current = Math.min(1, (ctx.currentTime - startedAt) / duration)
            if (speechProgressRef.current < 1) requestAnimationFrame(tickProgress)
          }

          source.start()
          requestAnimationFrame(tickProgress)
          console.log(`[nimbus] speaking via Edge neural voice (${duration.toFixed(1)}s)`)
        })
        .catch((err: unknown) => {
          // Loud, not silent: a quiet fallback here is exactly what made the
          // voice seem "unchanged" while the neural path was actually failing.
          console.error(
            '[nimbus] Edge neural TTS failed, falling back to robotic system voice:',
            err instanceof Error ? err.message : err
          )
          speakNative(text)
        })
    },
    [listenAgain, speakNative, stopPlayback]
  )

  const handleResult = useCallback(
    (finalTranscript: string) => {
      // While something is playing, "stop" means "stop the music" — not
      // "close Nimbus". Checked first so playback commands win.
      if (radioActiveRef.current && isStopPlaybackPhrase(finalTranscript)) {
        console.log(`[nimbus] stop-playback heard ("${finalTranscript}")`)
        radioActiveRef.current = false
        pausedForListeningRef.current = false
        radioRef.current.stop()
        setResponse(null)
        setTranscript(null)
        setState('listening')
        startVoiceInputRef.current?.()
        return
      }

      // "stop", "that's it for today", etc. close the overlay rather than
      // being treated as a question. Handled here so it's instant.
      if (isStopPhrase(finalTranscript)) {
        console.log(`[nimbus] stop phrase heard ("${finalTranscript}") — closing`)
        dismiss()
        return
      }

      // A real question while music is paused for listening: the music is
      // finished with, so drop it rather than resuming underneath the answer.
      if (pausedForListeningRef.current) {
        pausedForListeningRef.current = false
        radioActiveRef.current = false
        radioRef.current.stop()
      }

      // Previous answer clears here — when a new question actually arrives —
      // rather than the moment the mic reopens.
      setResponse(null)
      setError(null)
      setStreamingText('')
      setTranscript(finalTranscript)
      setState('thinking')
      window.nimbus
        .sendTranscript(finalTranscript)
        .then((res) => {
          setStreamingText('')
          setPendingCapture(null)
          setResponse(res)
          setState('speaking')
          // Queue the stream rather than starting it now — it would play over
          // the "Playing X" announcement.
          if (res.card.type === 'radio') {
            radioActiveRef.current = true
            const { streamUrl } = res.card.data
            startPendingRadioRef.current = () => {
              radioRef.current.play(streamUrl)
              startPendingRadioRef.current = null
            }
          } else {
            radioActiveRef.current = false
            startPendingRadioRef.current = null
            radioRef.current.stop()
          }
          speak(res.speech)
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Something went wrong.'
          setError(message)
          setState('speaking')
          speak(message)
        })
    },
    [speak, dismiss]
  )

  const handleVoiceEnd = useCallback(() => {
    // Recording ended with nothing usable (silence timeout) — fade out.
    // Reads state from a ref rather than triggering the side effect inside a
    // setState updater, which React StrictMode double-invokes.
    console.log(`[nimbus] voice turn ended with no transcript (state: ${stateRef.current})`)

    // Interrupted the music but then said nothing? Put it back on.
    if (pausedForListeningRef.current) {
      pausedForListeningRef.current = false
      radioRef.current.resume()
      setState('playing')
      return
    }

    if (stateRef.current === 'listening') {
      scheduleAutoFade()
    }
  }, [scheduleAutoFade])

  const handleVoiceError = useCallback(
    (voiceError: string) => {
      setError(voiceError)
      setState('speaking')
      scheduleAutoFade()
    },
    [scheduleAutoFade]
  )

  const { start: startVoiceInput, stop: stopVoiceInput } = useVoiceInput({
    onResult: handleResult,
    onEnd: handleVoiceEnd,
    onError: handleVoiceError,
    onLevel: handleLevel,
    endOfSpeechMs: config?.voice?.endOfSpeechMs
  })

  // Keep stable refs so `dismiss`/`listenAgain` (defined above the hook
  // call) can reach the latest start()/stop() without being redeclared.
  const stopVoiceInputRef = useRef(stopVoiceInput)
  const startVoiceInputRef = useRef(startVoiceInput)
  useEffect(() => {
    stopVoiceInputRef.current = stopVoiceInput
    startVoiceInputRef.current = startVoiceInput
  }, [stopVoiceInput, startVoiceInput])

  useEffect(() => {
    window.nimbus.getConfig().then(setConfig).catch(() => setConfig(null))
  }, [])

  useEffect(() => {
    return window.nimbus.onSpeechChunk((chunk) => {
      setStreamingText((current) => current + chunk)
    })
  }, [])

  useEffect(() => {
    return window.nimbus.onScreenCaptured((thumbnail) => {
      setPendingCapture(thumbnail)
      setResponse(null)
      setError(null)
    })
  }, [])

  useEffect(() => {
    const unsubscribeWake = window.nimbus.onWake(() => {
      clearFadeTimer()
      setMode('assistant')
      setError(null)
      setTranscript(null)

      // Hotkey pressed while a station is playing: duck the music so the mic
      // can hear, and keep the player card visible. Saying nothing resumes it.
      if (radioActiveRef.current) {
        pausedForListeningRef.current = true
        radioRef.current.pause()
      } else {
        setResponse(null)
      }

      setState('listening')
      startVoiceInput()
    })

    const unsubscribeSettings = window.nimbus.onShowSettings(() => {
      clearFadeTimer()
      setMode('settings')
      setState('idle')
    })

    return () => {
      unsubscribeWake()
      unsubscribeSettings()
    }
  }, [clearFadeTimer, startVoiceInput])

  useEffect(() => clearFadeTimer, [clearFadeTimer])

  return {
    state,
    mode,
    response,
    error,
    transcript,
    streamingText,
    pendingCapture,
    config,
    radio,
    levelRef,
    speechProgressRef,
    dismiss
  }
}
