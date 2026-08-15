import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { NimbusConfig, NimbusResponse, NimbusState, TextActionKind } from '@shared/types'
import { useVoiceInput } from './useVoiceInput'
import { useRadioPlayer, type RadioPlayerControls } from './useRadioPlayer'
import { isStopPhrase, isStopPlaybackPhrase } from '../lib/stop-phrases'

const DEFAULT_AUTO_FADE_MS = 8000
// When an answer is on screen it needs reading time — headlines, a photo and
// an extract take far longer to take in than the fade meant for an empty
// overlay, and closing at 8s made results feel like they vanished instantly.
const READING_AUTO_FADE_MS = 45000
// Consecutive turns with nothing said before the overlay gives up.
const MAX_EMPTY_TURNS = 2

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
  /** Text captured from another app, awaiting an action. */
  pendingSelection: string | null
  runTextAction: (kind: TextActionKind, label: string, customInstruction?: string) => void
  replaceSelection: (text: string) => void
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
  /** Text grabbed from another app, awaiting an action. '' means the grab
   *  failed (nothing was selected). */
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
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
  /** Mirrors pendingSelection so handleResult (declared earlier) can see it. */
  const pendingSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    pendingSelectionRef.current = pendingSelection
  }, [pendingSelection])
  /** Consecutive turns that produced no usable transcript. */
  const emptyTurnsRef = useRef(0)
  /** scheduleAutoFade is declared after listenAgain, so reached by ref. */
  const scheduleAutoFadeRef = useRef<(() => void) | null>(null)
  /** askQuestion is used as a fallback from runTextAction. */
  const askQuestionRef = useRef<((text: string) => void) | null>(null)
  /** runTextAction is declared after handleResult, so it's reached by ref. */
  const runTextActionRef = useRef<
    | ((
        kind: TextActionKind,
        label: string,
        instruction?: string,
        onNoSelection?: () => void
      ) => void)
    | null
  >(null)

  // Mirror of `state` for callbacks that need the current value without
  // being re-created (or reading it inside a setState updater).
  const stateRef = useRef<NimbusState>('idle')
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    // Pending selections count as content: if the user says nothing, the
    // buttons must stay up long enough to click rather than fading in 8s.
    hasContentRef.current = Boolean(response || error || pendingSelection)
  }, [response, error, pendingSelection])

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
    setPendingSelection(null)
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

  useEffect(() => {
    scheduleAutoFadeRef.current = scheduleAutoFade
  }, [scheduleAutoFade])

  // After Nimbus finishes speaking, listen again for a follow-up instead of
  // immediately fading out — otherwise every turn required pressing the
  // hotkey again, which reads as "it won't let me speak anymore." If the
  // follow-up listen captures nothing, handleVoiceEnd's existing silence
  // handling schedules the fade-out, so the conversation still ends on its
  // own once the user stops responding.
  const listenAgain = useCallback(() => {
    clearFadeTimer()
    // Two silent turns in a row means the user has walked away or the room is
    // just noisy. Reopening the mic forever kept the overlay alive and fed
    // Whisper more silence to hallucinate from.
    if (emptyTurnsRef.current >= MAX_EMPTY_TURNS) {
      console.log('[nimbus] no speech for two turns — closing instead of listening again')
      scheduleAutoFadeRef.current?.()
      setState('idle')
      return
    }
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

  /** Sends an utterance through the normal assistant pipeline. */
  const askQuestion = useCallback(
    (finalTranscript: string) => {
      // Previous answer clears here — when a new question actually arrives —
      // rather than the moment the mic reopens.
      emptyTurnsRef.current = 0
      setPendingSelection(null)
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
    [speak]
  )

  useEffect(() => {
    askQuestionRef.current = askQuestion
  }, [askQuestion])

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

      // Text is waiting to be worked on, so anything said is an instruction
      // about that text — not a question for the assistant.
      if (pendingSelectionRef.current) {
        console.log(`[nimbus] text instruction heard ("${finalTranscript}")`)
        // Falls back to the normal question path if the main process no
        // longer holds the selection, so a stale flag can't swallow a real
        // question.
        runTextActionRef.current?.('custom', finalTranscript, finalTranscript, () =>
          askQuestionRef.current?.(finalTranscript)
        )
        return
      }

      // A real question while music is paused for listening: the music is
      // finished with, so drop it rather than resuming underneath the answer.
      if (pausedForListeningRef.current) {
        pausedForListeningRef.current = false
        radioActiveRef.current = false
        radioRef.current.stop()
      }

      askQuestion(finalTranscript)
    },
    [askQuestion, dismiss]
  )

  /** Runs a transform on the captured selection and shows the result. */
  const runTextAction = useCallback(
    (
      kind: TextActionKind,
      label: string,
      customInstruction?: string,
      onNoSelection?: () => void
    ) => {
      const source = pendingSelection
      if (!source) {
        onNoSelection?.()
        return
      }

      clearFadeTimer()
      setStreamingText('')
      setError(null)
      setState('thinking')

      window.nimbus
        .runTextAction(kind, customInstruction)
        .then(({ result, canReplace }) => {
          setStreamingText('')
          // Keep the selection context alive so a spoken follow-up chains
          // onto this result rather than being treated as a new question.
          setPendingSelection(result)
          setResponse({
            speech: result,
            card: {
              type: 'selection',
              data: { source, action: kind, actionLabel: label, result, canReplace }
            }
          })
          // Deliberately silent: this flow is for text you're reading and
          // pasting, and speaking a rewritten paragraph aloud is just noise.
          speechProgressRef.current = 1
          // Stay open and listening rather than counting down to close — the
          // usual next step is a follow-up ("now make it shorter") or hitting
          // Replace, and closing on them mid-read was infuriating.
          emptyTurnsRef.current = 0
          setState('listening')
          startVoiceInputRef.current?.()
        })
        .catch((err: unknown) => {
          setStreamingText('')
          const message = err instanceof Error ? err.message : 'That action failed.'

          // The main process no longer holds the selection (it was pasted, or
          // a new turn started). Treat what was said as an ordinary question
          // rather than surfacing an internal error.
          if (message.includes('no selected text') && onNoSelection) {
            console.log('[nimbus] selection expired — handling as a question instead')
            setPendingSelection(null)
            onNoSelection()
            return
          }

          setError(message)
          setState('idle')
          scheduleAutoFade()
        })
    },
    [pendingSelection, clearFadeTimer, scheduleAutoFade]
  )

  useEffect(() => {
    runTextActionRef.current = runTextAction
  }, [runTextAction])

  /** Pastes a result back over the original selection. */
  const replaceSelection = useCallback(
    (text: string) => {
      window.nimbus
        .replaceSelection(text)
        .then(() => {
          clearFadeTimer()
          setState('idle')
          setResponse(null)
          // Main drops its copy once pasted; clear ours in step or the next
          // thing said is routed as an instruction against nothing.
          setPendingSelection(null)
          window.nimbus.resetConversation()
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "I couldn't paste that back.")
        })
    },
    [clearFadeTimer]
  )

  const handleVoiceEnd = useCallback(() => {
    // Recording ended with nothing usable (silence timeout) — fade out.
    // Reads state from a ref rather than triggering the side effect inside a
    // setState updater, which React StrictMode double-invokes.
    console.log(`[nimbus] voice turn ended with no transcript (state: ${stateRef.current})`)
    emptyTurnsRef.current += 1

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
      setPendingSelection(null)
      setResponse(null)
      setError(null)
    })
  }, [])

  useEffect(() => {
    return window.nimbus.onSelectionCaptured((text) => {
      clearFadeTimer()
      setPendingSelection(text)
      setPendingCapture(null)
      setResponse(null)
      setError(text ? null : 'Select some text first, then press the shortcut.')

      if (text) {
        // Listen as well as showing the buttons: the buttons cover the common
        // cases, speaking covers everything else ("translate to Arabic",
        // "make this more formal", "turn it into bullet points").
        setState('listening')
        startVoiceInputRef.current?.()
      } else {
        setState('idle')
        stopVoiceInputRef.current?.()
      }
    })
  }, [clearFadeTimer])

  useEffect(() => {
    const unsubscribeWake = window.nimbus.onWake(() => {
      clearFadeTimer()
      emptyTurnsRef.current = 0
      setMode('assistant')
      setError(null)
      setTranscript(null)

      // Plain hotkey means a fresh question, so drop any selection context —
      // main clears its copy at the same moment.
      setPendingSelection(null)

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
    pendingSelection,
    runTextAction,
    replaceSelection,
    config,
    radio,
    levelRef,
    speechProgressRef,
    dismiss
  }
}
