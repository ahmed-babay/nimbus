import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { NimbusConfig, NimbusResponse, NimbusState, TextActionKind } from '@shared/types'
import { useVoiceInput, type VoiceEndReason } from './useVoiceInput'
import { playOpenChime, playCloseChime } from '../lib/chime'
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
  mode: 'assistant' | 'settings' | 'standing'
  response: NimbusResponse | null
  error: string | null
  transcript: string | null
  /** Partial answer text while the model is still generating. */
  streamingText: string
  /** True while a web search is actually in flight, mid-"thinking". */
  searching: boolean
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
  /**
   * Submits typed text through exactly the same router as speech, so typing
   * works for questions, screenshot follow-ups and selection instructions
   * without any of those paths needing to know where the text came from.
   */
  /** True while the overlay is on screen. */
  isOpen: boolean
  submitText: (text: string) => void
  /** Call when the user starts typing, to close the mic. */
  onTypingStart: () => void
  /** Whether speech input is enabled, and its toggle. */
  micEnabled: boolean
  toggleMic: () => void
  /** Whether answers are spoken aloud, and its toggle. */
  ttsEnabled: boolean
  toggleTts: () => void
  /** Shows the settings panel — reachable without hunting for the tray icon. */
  openSettings: () => void
  openStanding: () => void
  /** Returns to the assistant view without hiding the overlay. */
  closePanel: () => void
  /** Keeps the overlay from fading while a long-running mode owns it. */
  setHoldOpen: (hold: boolean) => void
  dismiss: () => void
}

export function useNimbus(): NimbusOverlayState {
  const [state, setState] = useState<NimbusState>('idle')
  const [mode, setMode] = useState<'assistant' | 'settings' | 'standing'>('assistant')
  const [response, setResponse] = useState<NimbusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<string | null>(null)
  /** Answer text accumulating live from the model, shown while thinking. */
  const [streamingText, setStreamingText] = useState('')
  /** True while a web search is actually in flight, so the orb can show that rather than plain thinking. */
  const [searching, setSearching] = useState(false)
  /** Screenshot awaiting a question about it, shown above the waveform. */
  const [pendingCapture, setPendingCapture] = useState<string | null>(null)
  /** Text grabbed from another app, awaiting an action. '' means the grab
   *  failed (nothing was selected). */
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
  const [config, setConfig] = useState<NimbusConfig | null>(null)
  /**
   * Whether the overlay is showing. Explicit rather than derived from
   * `state`: visibility used to be inferred from a growing list of
   * conditions, and every new flow (selection, typing) broke it — typing set
   * the state to 'idle' to close the mic and the whole overlay vanished.
   */
  const [isOpen, setIsOpen] = useState(false)

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
  const holdOpenRef = useRef(false)
  /** True while the station is paused purely so the mic can hear the user —
   *  resumed if they say nothing, dropped if they ask something new. */
  const pausedForListeningRef = useRef(false)
  /** Mirrors pendingSelection so handleResult (declared earlier) can see it. */
  const pendingSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    pendingSelectionRef.current = pendingSelection
  }, [pendingSelection])
  /** Explicit user preference. Typing no longer disables speech implicitly —
   *  only this toggle does, so both input methods stay available. */
  const [micEnabled, setMicEnabled] = useState(true)
  const micEnabledRef = useRef(true)
  const [ttsEnabled, setTtsEnabled] = useState(true)
  const ttsEnabledRef = useRef(true)
  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled
  }, [ttsEnabled])
  /** Bumped on dismiss. Async work started before a close checks this and
   *  bows out, so a pending answer cannot speak into a shut overlay. */
  const generationRef = useRef(0)
  /** Mirrors isOpen for async callbacks. Discarding in-flight work is not
   *  enough on its own — a late transcript could still start a brand new
   *  turn and speak into a closed overlay. */
  const isOpenRef = useRef(false)
  /** stopPlayback is declared later; reached by ref from toggleTts. */
  const stopPlaybackNowRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    micEnabledRef.current = micEnabled
  }, [micEnabled])
  /** Consecutive turns that produced no usable transcript. */
  const emptyTurnsRef = useRef(0)
  /** scheduleAutoFade is declared after listenAgain, so reached by ref. */
  const scheduleAutoFadeRef = useRef<(() => void) | null>(null)
  /** handleResult is declared after submitText, so reached by ref. */
  const handleResultRef = useRef<((text: string) => void) | null>(null)
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
    isOpenRef.current = isOpen
  }, [isOpen])

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

  useEffect(() => {
    stopPlaybackNowRef.current = stopPlayback
  }, [stopPlayback])

  /**
   * Shared by both panels. A panel is something you read and click, so the
   * assistant goes quiet while one is open: a half-finished recording is
   * thrown away rather than transcribed, and anything being spoken stops.
   * Otherwise opening settings mid-answer left a voice talking over a form,
   * and the microphone listening to someone who is plainly typing.
   */
  const openPanel = useCallback(
    (panel: 'settings' | 'standing') => {
      clearFadeTimer()
      cancelVoiceInputRef.current?.()
      stopPlaybackNowRef.current?.()
      setIsOpen(true)
      isOpenRef.current = true
      hasContentRef.current = true
      setState('idle')
      // The recording was just cancelled, so the microphone really is off and
      // the toggle has to say so. Leaving it lit while a settings form is open
      // is the same lie as the orb staying blue after a timeout.
      micEnabledRef.current = false
      setMicEnabled(false)
      setMode(panel)
    },
    [clearFadeTimer]
  )

  const openStanding = useCallback(() => openPanel('standing'), [openPanel])

  /**
   * Cancels the fade too: settings is read-and-type, not glanced at, and
   * having the panel vanish mid-paste of an API key would be maddening.
   */
  const openSettings = useCallback(() => openPanel('settings'), [openPanel])

  /**
   * Back to the assistant without closing the overlay.
   *
   * Panels used to close by dismissing everything, which meant the only way
   * back to the thing you came from was to summon Nimbus again.
   */
  const closePanel = useCallback(() => {
    clearFadeTimer()
    setMode('assistant')
    setState('idle')
  }, [clearFadeTimer])

  /**
   * Set while a long-running mode owns the overlay — subtitles today. The
   * overlay closing itself under a film would take the subtitles with it, the
   * same reason radio suppresses the fade.
   */
  const setHoldOpen = useCallback(
    (hold: boolean) => {
      holdOpenRef.current = hold
      if (hold) clearFadeTimer()
    },
    [clearFadeTimer]
  )

  const dismiss = useCallback(() => {
    // Only for a real close: a dismiss reached while already closed (a
    // second Esc, a stray auto-fade tick) must not play the sound twice.
    if (isOpenRef.current) playCloseChime()
    holdOpenRef.current = false
    clearFadeTimer()
    setIsOpen(false)
    window.speechSynthesis?.cancel()
    stopPlayback()
    radioActiveRef.current = false
    startPendingRadioRef.current = null
    radioRef.current.stop()
    generationRef.current += 1
    // cancel, not stop: a stopped recorder still uploads and answers.
    cancelVoiceInputRef.current?.()
    setState('idle')
    setResponse(null)
    setError(null)
    setTranscript(null)
    setPendingCapture(null)
    setPendingSelection(null)
    setSearching(false)
    // Each time the overlay closes the conversation ends, so the next
    // session doesn't inherit stale context from an old topic.
    window.nimbus.resetConversation()
    window.nimbus.hide()
  }, [clearFadeTimer, stopPlayback])

  const scheduleAutoFade = useCallback(() => {
    clearFadeTimer()
    // Never close while a station is playing — closing tears down the audio
    // element and the music would just stop. "stop" or Esc ends it.
    if (radioActiveRef.current || holdOpenRef.current) return
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
    // The mic reopens after a typed turn too — typing once shouldn't lock
    // speech out for the rest of the session. Turning it off is an explicit
    // choice via the mic toggle, not something inferred from one message.
    if (!micEnabledRef.current) {
      setState('idle')
      scheduleAutoFadeRef.current?.()
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
    (text: string, thenListen = true) => {
      if (!window.speechSynthesis) {
        scheduleAutoFade()
        return
      }
      window.speechSynthesis.cancel()
      // No audio clock available on this path, so show the text in full
      // rather than leaving it stuck mid-reveal.
      speechProgressRef.current = 1
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.onend = thenListen ? listenAgain : scheduleAutoFade
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
    // `thenListen` is false when Nimbus started the exchange rather than the
    // user — a reminder firing must not leave a hot microphone in an empty
    // room, which is exactly how ambient noise became hallucinated questions.
    (text: string, thenListen = true) => {
      if (!isOpenRef.current) return

      // Muted: show the answer, skip the voice, and carry on to the next turn.
      if (!ttsEnabledRef.current) {
        speechProgressRef.current = 1
        startPendingRadioRef.current?.()
        if (thenListen) listenAgain()
        else scheduleAutoFade()
        return
      }

      // Synthesis is a network round trip; the overlay can be closed before
      // it returns. Anything started in this generation must not act once
      // that has happened, or Nimbus talks into a shut overlay.
      const generation = generationRef.current

      window.nimbus
        .synthesizeSpeech(text)
        .then(async ({ audio, mimeType }) => {
          if (generation !== generationRef.current) {
            console.log('[nimbus] discarding speech for a closed session')
            return
          }
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
          if (generation !== generationRef.current) return

          stopPlayback()
          const source = ctx.createBufferSource()
          source.buffer = buffer

          // The orb reacts to Nimbus's own voice as well as to yours. Without
          // this it sat perfectly still while speaking, which made the thing
          // look like it had stopped working at the exact moment it was most
          // obviously alive. Same levelRef the microphone writes to, so the
          // sphere has one input and does not care where the sound came from.
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          analyser.smoothingTimeConstant = 0.75
          source.connect(analyser)
          analyser.connect(ctx.destination)

          const samples = new Uint8Array(analyser.frequencyBinCount)
          let meter = 0
          const readLevel = (): void => {
            if (currentSourceRef.current !== source) return
            analyser.getByteTimeDomainData(samples)
            let sum = 0
            for (let i = 0; i < samples.length; i++) {
              const centred = (samples[i] - 128) / 128
              sum += centred * centred
            }
            // RMS, lifted a little: speech rarely peaks, and a meter that only
            // moves on plosives reads as broken.
            const rms = Math.sqrt(sum / samples.length)
            levelRef.current = Math.min(1, rms * 2.6)
            meter = requestAnimationFrame(readLevel)
          }
          meter = requestAnimationFrame(readLevel)

          source.onended = () => {
            cancelAnimationFrame(meter)
            levelRef.current = 0
            currentSourceRef.current = null
            speechProgressRef.current = 1
            startPendingRadioRef.current?.()
            if (thenListen) listenAgain()
            else scheduleAutoFade()
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
          speakNative(text, thenListen)
        })
    },
    [listenAgain, scheduleAutoFade, speakNative, stopPlayback]
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
      setSearching(false)
      setTranscript(finalTranscript)
      setState('thinking')
      const generation = generationRef.current
      window.nimbus
        .sendTranscript(finalTranscript)
        .then((res) => {
          if (generation !== generationRef.current) {
            console.log('[nimbus] discarding answer for a closed session')
            return
          }
          setStreamingText('')
          setSearching(false)
          setPendingCapture(null)
          // Reset before the card renders. If it still held 1 from the last
          // answer, the new text mounted fully revealed and the reveal never
          // ran for this turn.
          speechProgressRef.current = 0
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
          setSearching(false)
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
      // Closed: ignore anything that arrives late rather than waking back up.
      if (!isOpenRef.current) {
        console.log('[nimbus] ignoring input for a closed overlay')
        return
      }
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

  useEffect(() => {
    handleResultRef.current = handleResult
  }, [handleResult])

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

  /**
   * Typed input takes the same path as a finished transcript, so stop phrases,
   * selection instructions and screenshot questions all behave identically
   * whether spoken or typed. The mic is closed first — otherwise a half-heard
   * sentence could land on top of what was just typed.
   */
  const submitText = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Only stops the in-flight recording; the mic stays enabled so the next
    // turn can still be spoken.
    stopVoiceInputRef.current?.()
    console.log(`[nimbus] typed input: "${trimmed}"`)
    handleResultRef.current?.(trimmed)
  }, [])

  /** Explicit on/off for speech input. */
  const toggleMic = useCallback(() => {
    setMicEnabled((on) => {
      const next = !on
      micEnabledRef.current = next
      if (!next) {
        stopVoiceInputRef.current?.()
        if (stateRef.current === 'listening') setState('idle')
      } else if (stateRef.current === 'idle') {
        setState('listening')
        startVoiceInputRef.current?.()
      }
      return next
    })
  }, [])

  /** Explicit on/off for spoken answers. */
  const toggleTts = useCallback(() => {
    setTtsEnabled((on) => {
      const next = !on
      ttsEnabledRef.current = next
      // Silence anything mid-sentence rather than letting it finish.
      if (!next) {
        window.speechSynthesis?.cancel()
        stopPlaybackNowRef.current?.()
      }
      return next
    })
  }, [])

  /** Closes the mic the moment typing starts, before it hears the keyboard. */
  const handleTypingStart = useCallback(() => {
    if (stateRef.current === 'listening') {
      stopVoiceInputRef.current?.()
      setState('idle')
    }
  }, [])

  const handleVoiceEnd = useCallback((reason: VoiceEndReason = 'empty') => {
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
      // Drop out of 'listening' the moment the microphone is released, rather
      // than staying blue until the overlay happens to fade. Nothing is being
      // heard any more, and an orb that still looks like it is listening is a
      // lie about a microphone — the one thing an assistant on screen all day
      // has to be honest about. The idle palette is warm red, so it is
      // visible at a glance that Nimbus has let go.
      setState('idle')

      // The toggle is a switch, not a preference: if the mic timed out with
      // nobody there, it is genuinely off now and must say so. Only on real
      // silence — a turn that came back unusable had someone talking into it,
      // and switching their mic off mid-conversation would be maddening.
      //
      // Silence is also the one case that must NOT auto-fade the overlay:
      // saying nothing is not a request to be dismissed, just a mic to turn
      // off. A turn that came back unusable, on the other hand, was someone
      // trying to say something — that still fades like any other dead end.
      if (reason === 'silence') {
        micEnabledRef.current = false
        setMicEnabled(false)
      } else {
        scheduleAutoFade()
      }
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

  const {
    start: startVoiceInput,
    stop: stopVoiceInput,
    cancel: cancelVoiceInput,
    isRecording
  } = useVoiceInput({
    onResult: handleResult,
    onEnd: handleVoiceEnd,
    onError: handleVoiceError,
    onLevel: handleLevel,
    endOfSpeechMs: config?.voice?.endOfSpeechMs
  })

  // Keep stable refs so `dismiss`/`listenAgain` (defined above the hook
  // call) can reach the latest start()/stop() without being redeclared.
  const stopVoiceInputRef = useRef(stopVoiceInput)
  const cancelVoiceInputRef = useRef(cancelVoiceInput)
  const startVoiceInputRef = useRef(startVoiceInput)
  useEffect(() => {
    stopVoiceInputRef.current = stopVoiceInput
    cancelVoiceInputRef.current = cancelVoiceInput
    startVoiceInputRef.current = startVoiceInput
  }, [stopVoiceInput, cancelVoiceInput, startVoiceInput])

  useEffect(() => {
    window.nimbus.getConfig().then(setConfig).catch(() => setConfig(null))
  }, [])

  useEffect(() => {
    return window.nimbus.onSpeechChunk((chunk) => {
      setStreamingText((current) => current + chunk)
    })
  }, [])

  useEffect(() => {
    return window.nimbus.onSearchStatus(setSearching)
  }, [])

  useEffect(() => {
    return window.nimbus.onScreenCaptured((thumbnail) => {
      setIsOpen(true)
      setPendingCapture(thumbnail)
      setPendingSelection(null)
      setResponse(null)
      setError(null)
    })
  }, [])

  useEffect(() => {
    return window.nimbus.onSelectionCaptured((text) => {
      clearFadeTimer()
      setIsOpen(true)
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
    return window.nimbus.onReminderDue((reminder) => {
      clearFadeTimer()
      setIsOpen(true)
      // Both refs are written directly, not left to the effects that mirror
      // them. Those run after the render commits, but `speak` is called
      // synchronously below and bails on `!isOpenRef.current` — so a reminder
      // arriving while the overlay was closed was silently dropped, which is
      // precisely when a reminder matters most. `hasContentRef` decides the
      // fade length for the same reason: stale, it gave an alert you weren't
      // looking at the 8-second timeout instead of the 45-second one.
      isOpenRef.current = true
      hasContentRef.current = true
      setMode('assistant')
      setError(null)
      setTranscript(null)
      setPendingSelection(null)
      setPendingCapture(null)
      setStreamingText('')
      // Nimbus is the one initiating here, so it shows and speaks but does not
      // open the microphone — see presentOverlay in src/main/window.ts.
      setResponse({
        speech: reminder.text,
        card: { type: 'reminder', data: { created: reminder, pending: [] } }
      })
      speechProgressRef.current = 0
      speak(reminder.text, false)
      // Stays up longer than a normal answer: an alert you miss is worthless,
      // and the user was not looking at the screen when it appeared.
      scheduleAutoFadeRef.current?.()
    })
  }, [clearFadeTimer, speak])

  useEffect(() => {
    const unsubscribeWake = window.nimbus.onWake(() => {
      clearFadeTimer()
      // Only when it was actually closed. Waking an already-open overlay for a
      // follow-up would otherwise stack the opening chime on top of the
      // listening one, which is two sounds for one event.
      if (!isOpenRef.current) playOpenChime()
      setIsOpen(true)
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

      if (!micEnabledRef.current) {
        setState('idle')
      } else if (isRecording()) {
        // Already listening. A second wake — the hotkey pressed again, or the
        // wake word heard mid-sentence — used to start a fresh turn, and the
        // one in progress was then discarded as superseded. That threw away
        // whatever had just been said into it, which is the worst possible
        // response to someone asking for attention they already had.
        console.log('[nimbus] wake while already listening — keeping the current turn')
        setState('listening')
      } else {
        setState('listening')
        startVoiceInput()
      }
    })

    const unsubscribeSettings = window.nimbus.onShowSettings(() => {
      clearFadeTimer()
      setIsOpen(true)
      setMode('settings')
      setState('idle')
    })

    const unsubscribeStanding = window.nimbus.onShowStanding(() => {
      clearFadeTimer()
      setIsOpen(true)
      setMode('standing')
      setState('idle')
    })

    return () => {
      unsubscribeWake()
      unsubscribeSettings()
      unsubscribeStanding()
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
    searching,
    pendingCapture,
    pendingSelection,
    runTextAction,
    replaceSelection,
    config,
    radio,
    levelRef,
    speechProgressRef,
    isOpen,
    submitText,
    onTypingStart: handleTypingStart,
    micEnabled,
    toggleMic,
    ttsEnabled,
    toggleTts,
    openSettings,
    openStanding,
    closePanel,
    setHoldOpen,
    dismiss
  }
}
