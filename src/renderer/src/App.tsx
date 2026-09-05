import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Orb } from './components/Orb'
import { Waveform } from './components/Waveform'
import { accentVars, orbModeFor } from './lib/state-theme'
import { ResponseCard } from './components/ResponseCard'
import { SelectionActions } from './components/SelectionActions'
import { TextInput } from './components/TextInput'
import { KeySettings } from './components/KeySettings'
import { ExperienceSettings } from './components/ExperienceSettings'
import { Presence } from './components/Presence'
import { VoiceMessageBar } from './components/VoiceMessageBar'
import { SubtitleBar } from './components/SubtitleBar'
import { MeetingPanel } from './components/MeetingPanel'
import { StandingPanel } from './components/StandingPanel'
import { useNimbus } from './hooks/useNimbus'
import { useDragHandle } from './hooks/useDragHandle'
import { useWakeWord } from './hooks/useWakeWord'
import { useSubtitles } from './hooks/useSubtitles'
import { useMeeting } from './hooks/useMeeting'
import { useTypewriter } from './hooks/useTypewriter'
import { useModelLoading } from './hooks/useModelLoading'
import { FillBar } from './components/Motion'
import type {
  NimbusConfig,
  NimbusResponse,
  NimbusState,
  OverlayCorner,
  OverlayLayout,
  TextActionKind
} from '@shared/types'
import type { RadioPlayerControls } from './hooks/useRadioPlayer'

const STATE_LABEL: Record<NimbusState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  playing: 'Playing'
}

/** Shrinks the dock into the parked corner, and unfolds from it on click. */
function peekOrigin(corner: OverlayCorner | null): string {
  if (corner === 'top-right') return 'top right'
  if (corner === 'bottom-left') return 'bottom left'
  if (corner === 'bottom-right') return 'bottom right'
  return 'top left'
}

const PEEK_SPRING = { duration: 0.2, ease: 'easeOut' as const }

export default function App() {
  const [commandsOpen, setCommandsOpen] = useState(false)
  const {
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
    finishListening,
    transcribing,
    interruptAnswer,
    replayAnswer,
    onTypingStart,
    answerSeq,
    micEnabled,
    toggleMic,
    ttsEnabled,
    toggleTts,
    openSettings,
    openStanding,
    closePanel,
    setHoldOpen,
    dismiss
  } = useNimbus()
  // Paced reveal: the model streams in a few big chunks, which otherwise
  // lands as the whole answer at once.
  const typedText = useTypewriter(streamingText)
  const modelLoading = useModelLoading()
  const subtitles = useSubtitles()
  const meeting = useMeeting()
  // Driven by one explicit flag rather than inferred from state and content.
  // The card steps aside while subtitles run: they belong over the video, and
  // a panel on top of the picture is exactly what nobody wants there.
  const isVisible = (isOpen || mode === 'settings' || mode === 'standing') && !subtitles.active

  // Without this the overlay would fade out mid-film and take the subtitles
  // with it.
  const meetingOpen = meeting.phase !== 'idle'
  const [overlayLayout, setOverlayLayout] = useState<OverlayLayout>({
    corner: null,
    squeeze: 'full'
  })
  const overlayLayoutRef = useRef(overlayLayout)
  overlayLayoutRef.current = overlayLayout
  const hoveredRef = useRef(false)
  const lastTouchRef = useRef(Date.now())
  // The dock unmounts (and plays its collapse) before the window actually
  // becomes the icon, so the spring can finish in the large window rather
  // than getting clipped to 48px mid-motion.
  const [compactVisible, setCompactVisible] = useState(true)
  const compactVisibleRef = useRef(true)
  const pendingIconRef = useRef(false)

  useEffect(() => {
    void window.nimbus.getOverlayLayout().then(setOverlayLayout)
    return window.nimbus.onOverlayLayout(setOverlayLayout)
  }, [])

  useEffect(() => {
    if (overlayLayout.squeeze === 'compact') {
      pendingIconRef.current = false
      compactVisibleRef.current = true
      setCompactVisible(true)
    }
  }, [overlayLayout.squeeze])

  useEffect(() => {
    setHoldOpen(subtitles.active || meetingOpen || overlayLayout.corner !== null)
  }, [subtitles.active, meetingOpen, overlayLayout.corner, setHoldOpen])

  // Settings and the watching list need the full card. Coming back to the
  // assistant while still docked returns to the compact dock, not a full
  // overlay covering the corner.
  useEffect(() => {
    if (!overlayLayout.corner) return
    if (mode !== 'assistant' || meetingOpen) {
      if (overlayLayout.squeeze !== 'full') window.nimbus.setOverlaySqueeze('full')
      return
    }
    if (overlayLayout.squeeze === 'full') window.nimbus.setOverlaySqueeze('compact')
  }, [overlayLayout.corner, overlayLayout.squeeze, mode, meetingOpen])

  // Asking while the orb is parked as an icon should pop the compact dock
  // back so maps, trains, music and a grabbed selection can actually show.
  useEffect(() => {
    if (!overlayLayout.corner) return
    if (overlayLayout.squeeze !== 'icon') return
    if (mode !== 'assistant') return
    if (state === 'thinking' || state === 'speaking' || state === 'listening' || pendingSelection) {
      lastTouchRef.current = Date.now()
      window.nimbus.setOverlaySqueeze('compact')
    }
  }, [overlayLayout.corner, overlayLayout.squeeze, mode, state, pendingSelection])

  // After three quiet seconds in an empty compact dock, shrink to a
  // taskbar-sized orb so it stops occupying the corner. Clicking it brings the
  // dock back. An answer stays expanded: collapsing a map or result card a few
  // seconds after it renders looks like a crash and makes the result unusable.
  useEffect(() => {
    if (!overlayLayout.corner) return
    if (overlayLayout.squeeze !== 'compact') return
    if (mode !== 'assistant') return
    const tick = window.setInterval(() => {
      if (
        state === 'thinking' ||
        state === 'speaking' ||
        state === 'listening' ||
        pendingSelection ||
        response ||
        error
      ) {
        lastTouchRef.current = Date.now()
        return
      }
      if (hoveredRef.current || draggingRef.current) return
      if (!compactVisibleRef.current) return
      if (Date.now() - lastTouchRef.current < 3000) return
      pendingIconRef.current = true
      compactVisibleRef.current = false
      setCompactVisible(false)
    }, 250)
    return () => window.clearInterval(tick)
  }, [overlayLayout.corner, overlayLayout.squeeze, mode, state, pendingSelection, response, error])

  // Listening for its own name, when the user has turned that on. Suspended
  // whenever Nimbus is already up or talking — otherwise it competes with the
  // question recorder for the microphone, or hears itself say "Nimbus" and
  // wakes in a loop.
  useWakeWord({
    onWake: () => {
      // Main shows the overlay; nothing to do here but stop listening, which
      // the suspend flag below handles on the next render.
    },
    suspended: isVisible || meetingOpen || subtitles.active || state === 'speaking'
  })

  // Shared by the header handles so the click-through toggle above can tell
  // a real "pointer left the card" from the window moving underneath it.
  const draggingRef = useRef(false)
  const onDragChange = (dragging: boolean): void => {
    draggingRef.current = dragging
    // Re-assert interactivity the moment a drag ends under the pointer.
    if (!dragging) window.nimbus.setMouseIgnore(false)
  }
  const onDragEnd = (didMove: boolean): void => {
    if (didMove) {
      window.nimbus.snapOverlay()
      return
    }
    if (overlayLayoutRef.current.squeeze === 'icon') {
      lastTouchRef.current = Date.now()
      window.nimbus.setOverlaySqueeze('compact')
    }
  }

  const stopSubtitles = (): void => {
    subtitles.stop()
    setHoldOpen(false)
    dismiss()
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      // Escape means "end what's running", which during a film is the
      // subtitles rather than the overlay behind them.
      if (subtitles.active) stopSubtitles()
      // A panel is a place you went into, so Escape comes back out of it
      // rather than closing everything and losing the conversation behind it.
      else if (mode !== 'assistant') closePanel()
      // Escape during a recording stops it rather than throwing the
      // transcript away -- twenty minutes of a meeting is not something a
      // stray keypress should be able to destroy.
      else if (meeting.phase === 'recording') meeting.stop()
      else dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const squeeze = overlayLayout.squeeze
  const shellClass =
    squeeze === 'icon'
      ? 'flex h-screen w-screen items-center justify-center'
      : overlayLayout.corner?.startsWith('bottom')
        ? 'flex h-screen w-screen items-end justify-center p-2'
        : overlayLayout.corner
          ? 'flex h-screen w-screen items-start justify-center p-2'
          : 'flex h-screen w-screen items-start justify-center pt-2'

  return (
    <div className={shellClass}>
      <AnimatePresence
        onExitComplete={() => {
          if (!pendingIconRef.current) return
          pendingIconRef.current = false
          window.nimbus.setOverlaySqueeze('icon')
        }}
      >
        {isVisible && squeeze === 'icon' && (
          <PeekIcon
            key="peek-icon"
            state={state}
            searching={searching}
            answerSeq={answerSeq}
            levelRef={levelRef}
            onDragChange={onDragChange}
            onDragEnd={onDragEnd}
          />
        )}
        {isVisible && squeeze === 'compact' && compactVisible && (
          <PeekDock
            key="peek-dock"
            corner={overlayLayout.corner}
            state={state}
            searching={searching}
            answerSeq={answerSeq}
            levelRef={levelRef}
            speechProgressRef={speechProgressRef}
            response={response}
            error={error}
            typedText={typedText}
            radio={radio}
            pendingSelection={pendingSelection}
            onRunAction={runTextAction}
            micEnabled={micEnabled}
            ttsEnabled={ttsEnabled}
            onToggleMic={toggleMic}
            onToggleTts={toggleTts}
            onSubmit={submitText}
            onTypingStart={() => {
              lastTouchRef.current = Date.now()
              onTypingStart()
            }}
            onReplace={replaceSelection}
            onAsk={submitText}
            focusKey={isVisible}
            onDragChange={onDragChange}
            onDragEnd={onDragEnd}
            onTouch={() => {
              lastTouchRef.current = Date.now()
            }}
            onHoverChange={(hovered) => {
              hoveredRef.current = hovered
              if (hovered) lastTouchRef.current = Date.now()
            }}
          />
        )}
        {isVisible && squeeze === 'full' && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            // Only the card itself captures the mouse; everything around it
            // stays click-through so the overlay never blocks the screen.
            onMouseEnter={() => {
              hoveredRef.current = true
              window.nimbus.setMouseIgnore(false)
            }}
            // Where the light gathers under the pointer. Written straight to
            // the element as custom properties: this fires with every mouse
            // move, and putting it through React would re-render the whole
            // card at pointer rate for a decoration.
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              const style = event.currentTarget.style
              style.setProperty('--cursor-x', `${event.clientX - box.left}px`)
              style.setProperty('--cursor-y', `${event.clientY - box.top}px`)
              style.setProperty('--cursor-in', '1')
            }}
            onPointerLeave={(event) => {
              event.currentTarget.style.setProperty('--cursor-in', '0')
            }}
            // Not while dragging: the window chases the pointer, so the
            // pointer leaves the card constantly mid-drag, and going
            // click-through there would drop the window out from under it.
            onMouseLeave={() => {
              hoveredRef.current = false
              if (!draggingRef.current) window.nimbus.setMouseIgnore(true)
            }}
            // Capped to the window so a long answer scrolls instead of being
            // clipped off the bottom with no way to reach it.
            className="nimbus-glass relative flex min-h-0 max-h-[calc(100vh-1rem)] w-[492px] flex-col overflow-hidden rounded-[24px] border border-nimbus-border"
            // Depth from shadow and a hairline edge rather than a neon ring.
            // A glowing outline is the single strongest "toy" signal a panel
            // can send, and this one sits next to real work all day.
            style={{
              // A thicker inner top highlight and a wider, softer drop: the two
              // things that make a translucent panel read as a pane of glass
              // sitting above the desktop rather than a hole cut into it.
              boxShadow:
                // The last two insets are the lensing: light gathering along
                // the inside of the rim, brighter at the top where it enters.
                // A real pane is brightest at its edges, which is the detail
                // that separates glass from a flat translucent fill.
                '0 32px 80px -20px rgba(0,0,0,0.75), 0 4px 16px -4px rgba(0,0,0,0.5), ' +
                'inset 0 1px 0 0 rgba(255,255,255,0.14), inset 0 -1px 0 0 rgba(255,255,255,0.04), ' +
                'inset 0 0 24px -8px rgba(255,255,255,0.10)',
              // Re-points the accent tokens at the current state's hue. Every
              // accented control inside — settings, the standing list, badges,
              // buttons — is written against these variables, so the whole card
              // follows the orb without a single component knowing about state.
              // Transitioned so a state change is a shift in the light rather
              // than a flicker.
              ...accentVars(orbModeFor(transcribing ? 'thinking' : state, searching)),
              transition: 'color 500ms ease'
            }}
          >
            {/* The panel catches a little of the orb's light rather than
                being a flat slab behind it. */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                // Mixed from the accent rather than hardcoded indigo, so the
                // light spilling onto the panel is the orb's own colour.
                background:
                  'radial-gradient(120% 70% at 12% 0%, color-mix(in srgb, var(--color-nimbus-accent) 11%, transparent), transparent 60%)',
                transition: 'background 500ms ease'
              }}
            />
            {/* Specular sheen across the top third.
                What separates glass from a tinted sheet is that it *reflects*
                as well as transmits. A soft diagonal band of light near the top
                is the cheapest convincing version of that, and it is what makes
                the panel look like a physical pane catching a light source
                rather than a rectangle with opacity on it. */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-2/5"
              style={{
                background:
                  'linear-gradient(168deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.035) 38%, transparent 72%)'
              }}
            />
            {/* The bloom that follows the cursor. Above the panel's own
                lighting so it reads as light on the surface, below everything
                you can actually click. */}
            <div aria-hidden="true" className="nimbus-sheen pointer-events-none absolute inset-0" />

            {/* A single hairline of light along the top edge — enough to
                separate the panel from whatever is behind it, and nothing
                more. */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-px"
              style={{
                background:
                  'linear-gradient(90deg, transparent, rgba(255,255,255,0.18) 30%, rgba(255,255,255,0.18) 70%, transparent)'
              }}
            />

            {/* The model coming up, on the panel's own edge.
                Shown whatever Nimbus is doing, which is the point: the weights
                start loading when the overlay opens, so the wait happens while
                the state is still 'listening' and the message inside the card
                — which only appears once you have asked something — was not
                reachable yet. Twelve seconds with nothing moving is what made
                the app feel frozen on opening. This is the same hairline,
                filling. */}
            {modelLoading.active && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] overflow-hidden">
                <motion.div
                  className="h-full"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={{
                    // Never zero-width: a bar that starts invisible reads as
                    // nothing happening for the first second of the longest
                    // wait in the app.
                    width: `${Math.max(5, modelLoading.progress * 100)}%`,
                    background:
                      'linear-gradient(90deg, transparent, var(--color-nimbus-accent) 40%, var(--color-nimbus-accent-bright))',
                    boxShadow: '0 0 8px 0 var(--color-nimbus-accent)',
                    transition: 'width 220ms ease-out'
                  }}
                />
              </div>
            )}
            {/* Indeterminate progress while working, in the accent rather than
                a white strobe. */}
            {state === 'thinking' && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] overflow-hidden">
                <div
                  className="nimbus-progress h-full w-1/3 rounded-full"
                  style={{
                    background:
                      'linear-gradient(90deg, transparent, var(--color-nimbus-accent), transparent)'
                  }}
                />
              </div>
            )}

            {mode === 'settings' ? (
              <SettingsPanel
                config={config}
                onClose={closePanel}
                onDragChange={onDragChange}
                onDragEnd={onDragEnd}
              />
            ) : mode === 'standing' ? (
              <StandingPanel
                onClose={closePanel}
                onDragChange={onDragChange}
                onDragEnd={onDragEnd}
              />
            ) : (
              // Header and input stay put; only the answer between them moves.
              <div className="nimbus-studio flex min-h-0 flex-1 flex-col px-6 py-5">
                <Header
                  state={transcribing ? 'thinking' : state}
                  searching={searching}
                  onClose={dismiss}
                  micEnabled={micEnabled}
                  onToggleMic={toggleMic}
                  ttsEnabled={ttsEnabled}
                  onToggleTts={toggleTts}
                  onStanding={() => {
                    window.nimbus.setOverlaySqueeze('full')
                    openStanding()
                  }}
                  onSettings={() => {
                    window.nimbus.setOverlaySqueeze('full')
                    openSettings()
                  }}
                  onDragChange={onDragChange}
                  onDragEnd={onDragEnd}
                />

                <Presence state={state} searching={searching} answerSeq={answerSeq} levelRef={levelRef} compact={Boolean(commandsOpen || response || error || pendingSelection || pendingCapture || state === 'thinking')} transcribing={transcribing} />

                <div className="flex min-h-0 flex-1 gap-3.5">

                  <div className="nimbus-scroll min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 pt-0.5">
                    {/* An existing answer stays on screen while listening for a
                        follow-up, so there's time to actually read it. */}
                    {/* Response takes priority over a later error, so a mic
                        hiccup can't wipe out an answer being read. */}
                    {commandsOpen && !response && !error ? null : response ? (
                      <ResponseCard
                        response={response}
                        speechProgressRef={speechProgressRef}
                        radio={radio}
                        onReplace={replaceSelection}
                        onAsk={submitText}
                      />
                    ) : error ? (
                      <p className="text-[13px] leading-relaxed text-nimbus-negative">{error}</p>
                    ) : state === 'thinking' ? (
                      <div className="flex min-h-14 flex-col justify-center">
                        {transcript && (
                          <p className="truncate text-[11.5px] text-nimbus-text-dim">
                            &ldquo;{transcript}&rdquo;
                          </p>
                        )}
                        {typedText ? (
                          // Live tokens from the model, with a blinking caret.
                          <p className="mt-1.5 text-[14px] leading-[1.55] text-nimbus-text">
                            {typedText}
                            <motion.span
                              animate={{ opacity: [1, 0.15, 1] }}
                              transition={{ duration: 0.9, repeat: Infinity }}
                              className="ml-0.5 inline-block h-[14px] w-[2px] translate-y-[2px] rounded-full bg-nimbus-accent"
                            />
                          </p>
                        ) : modelLoading.active ? (
                          // Say what the wait actually is. Twelve seconds of
                          // "Thinking…" reads as a hang; twelve seconds of a
                          // bar that is visibly filling reads as a machine
                          // doing something, and only happens on the first
                          // question after a cold start.
                          <div className="mt-1.5">
                            <p className="text-[11px] text-nimbus-text-dim">
                              Starting the on-device model…
                            </p>
                            <div className="mt-1.5">
                              <FillBar fraction={Math.max(0.04, modelLoading.progress)} />
                            </div>
                          </div>
                        ) : (
                          <p className="mt-1.5 text-[11px] text-nimbus-text-dim">Thinking…</p>
                        )}
                      </div>
                    ) : pendingSelection ? (
                      <SelectionActions
                        text={pendingSelection}
                        onRun={(kind, label) => runTextAction(kind, label)}
                        levelRef={levelRef}
                        listening={state === 'listening'}
                      />
                    ) : pendingCapture ? (
                      // Screen was captured — show it so it's unambiguous what
                      // Nimbus is about to look at.
                      <div className="flex items-center gap-3">
                        <motion.img
                          initial={{ opacity: 0, scale: 0.94 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                          src={pendingCapture}
                          alt="Captured screen"
                          className="h-14 w-24 shrink-0 rounded-md object-cover object-top ring-1 ring-nimbus-accent/40"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Waveform levelRef={levelRef} barCount={18} compact />
                            <p className="text-[10.5px] text-nimbus-accent-bright">
                              Screen captured — ask about it
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : transcribing || state === 'listening' ? null : (
                      // Mic is closed (typing, or a finished typed turn) — say
                      // so rather than showing a dead "listening" waveform.
                      <div className="nimbus-shortcuts">
                        <button onClick={() => submitText('Play lofi music')}><span>♫</span>Find focus<small>Music in Nimbus</small></button>
                        <button onClick={() => submitText('What is the weather today?')}><span>☀</span>Step outside<small>Today’s weather</small></button>
                        <button onClick={() => submitText('What do you remember about me?')}><span>◇</span>My memory<small>Make it personal</small></button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Compact "still listening" strip, shown only when an answer
                    is already on screen — otherwise the main area covers it. */}
                {state === 'playing' && (
                  <div className="mt-3 border-t border-white/[0.06] pt-2.5 text-[10px] uppercase tracking-[0.14em] text-nimbus-text-dim">
                    {config?.hotkey.enabled ? config.hotkey.accelerator : 'Hotkey'} to talk ·
                    then &ldquo;stop the music&rdquo;
                  </div>
                )}

                {meetingOpen && <MeetingPanel meeting={meeting} />}

                {(state === 'listening' || state === 'thinking' || state === 'speaking' || transcribing) && (
                  <VoiceMessageBar state={state} transcribing={transcribing} levelRef={levelRef} onSend={finishListening} onStop={interruptAnswer} />
                )}
                {response && state !== 'thinking' && state !== 'speaking' && ttsEnabled && (
                  <button onClick={replayAnswer} className="mt-2 self-end rounded-full px-3 py-1.5 text-[11px] text-nimbus-accent-bright hover:bg-white/5">↻ Hear again</button>
                )}

                {transcript && state !== 'thinking' && (
                  <details className="mt-3 text-[11px] text-nimbus-text-dim">
                    <summary className="cursor-pointer">What Nimbus heard</summary>
                    <form className="mt-2 flex gap-2" onSubmit={(event) => {
                      event.preventDefault()
                      const corrected = String(new FormData(event.currentTarget).get('correction') ?? '').trim()
                      if (corrected) submitText(corrected)
                    }}>
                      <input key={transcript} name="correction" defaultValue={transcript} aria-label="Correct what Nimbus heard" onFocus={onTypingStart} className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/15 px-2 py-2 text-nimbus-text" />
                      <button type="submit" className="rounded-lg px-2 text-nimbus-accent-bright hover:bg-white/5">Ask again</button>
                    </form>
                  </details>
                )}

                {/* Always available — talking isn't possible everywhere. */}
                <TextInput
                  onSubmit={submitText}
                  onPaletteChange={setCommandsOpen}
                  onAction={(action) =>
                    action === 'subtitles'
                      ? void subtitles.start()
                      : action === 'meeting'
                        ? void meeting.start()
                        : openSettings()
                  }
                  focusKey={isVisible}
                  onTypingStart={onTypingStart}
                />

              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {subtitles.active && (
        <SubtitleBar
          lines={subtitles.visible}
          detected={subtitles.detected}
          error={subtitles.error}
          onStop={stopSubtitles}
        />
      )}
    </div>
  )
}

function PeekIcon({
  state,
  searching,
  answerSeq,
  levelRef,
  onDragChange,
  onDragEnd
}: {
  state: NimbusState
  searching: boolean
  answerSeq: number
  levelRef: RefObject<number>
  onDragChange: (dragging: boolean) => void
  onDragEnd: (didMove: boolean) => void
}): React.JSX.Element {
  const drag = useDragHandle(onDragChange, onDragEnd)
  return (
    // A div, not a button: the drag handle ignores presses that start on a
    // button, so a <button> here would neither drag nor fire onDragEnd — and
    // click-to-open would do nothing.
    <motion.div
      role="button"
      tabIndex={0}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={PEEK_SPRING}
      onMouseEnter={() => window.nimbus.setMouseIgnore(false)}
      onMouseLeave={() => window.nimbus.setMouseIgnore(true)}
      onPointerDown={drag.onPointerDown}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onDragEnd(false)
        }
      }}
      title="Nimbus — click to open, drag to move"
      className="grid h-full w-full cursor-grab place-items-center bg-transparent"
      style={drag.style}
    >
      <Orb
        state={state}
        searching={searching}
        answerSeq={answerSeq}
        levelRef={levelRef}
        size={42}
        tight
      />
    </motion.div>
  )
}

function PeekDock({
  corner,
  state,
  searching,
  answerSeq,
  levelRef,
  speechProgressRef,
  response,
  error,
  typedText,
  radio,
  pendingSelection,
  onRunAction,
  micEnabled,
  ttsEnabled,
  onToggleMic,
  onToggleTts,
  onSubmit,
  onTypingStart,
  onReplace,
  onAsk,
  focusKey,
  onDragChange,
  onDragEnd,
  onTouch,
  onHoverChange
}: {
  corner: OverlayCorner | null
  state: NimbusState
  searching: boolean
  answerSeq: number
  levelRef: RefObject<number>
  speechProgressRef: RefObject<number>
  response: NimbusResponse | null
  error: string | null
  typedText: string
  radio: RadioPlayerControls
  pendingSelection: string | null
  onRunAction: (kind: TextActionKind, label: string) => void
  micEnabled: boolean
  ttsEnabled: boolean
  onToggleMic: () => void
  onToggleTts: () => void
  onSubmit: (text: string) => void
  onTypingStart: () => void
  onReplace: (text: string) => void
  onAsk: (text: string) => void
  focusKey: unknown
  onDragChange: (dragging: boolean) => void
  onDragEnd: (didMove: boolean) => void
  onTouch: () => void
  onHoverChange: (hovered: boolean) => void
}): React.JSX.Element {
  const drag = useDragHandle(onDragChange, onDragEnd)
  const showBubble = Boolean(response || error || state === 'thinking' || pendingSelection)
  const origin = peekOrigin(corner)
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={PEEK_SPRING}
      onMouseEnter={() => {
        onTouch()
        onHoverChange(true)
        window.nimbus.setMouseIgnore(false)
      }}
      onMouseMove={onTouch}
      onMouseLeave={() => {
        onHoverChange(false)
        window.nimbus.setMouseIgnore(true)
      }}
      onPointerDown={onTouch}
      className="flex w-full min-w-0 flex-col gap-2 overflow-visible bg-transparent p-1"
      style={{ ...accentVars(orbModeFor(state, searching)), transformOrigin: origin }}
    >
      <div
        className="nimbus-glass flex shrink-0 items-center gap-2 self-stretch rounded-full border border-white/20 px-2 py-1.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.7),inset_0_1px_0_0_rgba(255,255,255,0.22)]"
        onPointerDown={drag.onPointerDown}
        style={drag.style}
      >
        <Orb
          state={state}
          searching={searching}
          answerSeq={answerSeq}
          levelRef={levelRef}
          size={36}
          tight
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold tracking-[-0.01em] text-nimbus-text">Nimbus</p>
          <p className="truncate text-[10px] text-nimbus-text-dim">
            {state === 'thinking' && searching ? 'Searching' : STATE_LABEL[state]}
          </p>
        </div>
        <IconButton
          onClick={onToggleMic}
          active={micEnabled}
          label={micEnabled ? 'Voice on — click to mute' : 'Voice off — click to enable'}
        >
          {micEnabled ? <MicIcon /> : <MicOffIcon />}
        </IconButton>
        <IconButton
          onClick={onToggleTts}
          active={ttsEnabled}
          label={ttsEnabled ? 'Answers are spoken — click to mute' : 'Answers are silent — click to unmute'}
        >
          {ttsEnabled ? <SoundIcon /> : <SoundOffIcon />}
        </IconButton>
      </div>

      {showBubble && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="relative w-full min-w-0 self-stretch"
        >
          <div
            aria-hidden
            className="absolute left-7 -top-1.5 h-3 w-3 rotate-45 border-l border-t border-white/15 bg-[#14161f]"
          />
          <div className="nimbus-glass overflow-hidden rounded-[22px] border border-white/15 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.7),inset_0_1px_0_0_rgba(255,255,255,0.14)]">
            <div className="nimbus-scroll max-h-[min(22rem,calc(100vh-8.5rem))] overflow-y-auto px-3.5 py-3.5">
            {response ? (
              <ResponseCard
                response={response}
                speechProgressRef={speechProgressRef}
                radio={radio}
                onReplace={onReplace}
                onAsk={onAsk}
              />
            ) : error ? (
              <p className="text-[12px] leading-relaxed text-nimbus-negative">{error}</p>
            ) : pendingSelection ? (
              <SelectionActions
                text={pendingSelection}
                onRun={(kind, label) => onRunAction(kind, label)}
                levelRef={levelRef}
                listening={state === 'listening'}
              />
            ) : typedText ? (
              <p className="text-[13px] leading-relaxed text-nimbus-text">
                {typedText}
                <span className="ml-0.5 inline-block h-[12px] w-[2px] translate-y-[1px] rounded-full bg-nimbus-accent" />
              </p>
            ) : (
              <p className="text-[11px] text-nimbus-text-dim">Thinking…</p>
            )}
            </div>
          </div>
        </motion.div>
      )}

      <div className="shrink-0">
        <TextInput
          onSubmit={onSubmit}
          focusKey={focusKey}
          onTypingStart={onTypingStart}
          compact
        />
      </div>
    </motion.div>
  )
}

function Header({
  state,
  searching,
  onClose,
  micEnabled,
  onToggleMic,
  ttsEnabled,
  onToggleTts,
  onStanding,
  onSettings,
  onDragChange,
  onDragEnd
}: {
  state: NimbusState
  searching: boolean
  onClose: () => void
  micEnabled: boolean
  onToggleMic: () => void
  ttsEnabled: boolean
  onToggleTts: () => void
  onStanding: () => void
  onSettings: () => void
  onDragChange: (dragging: boolean) => void
  onDragEnd: (didMove: boolean) => void
}) {
  const drag = useDragHandle(onDragChange, onDragEnd)
  return (
    // The header is the grab handle. Presses that land on a button are ignored
    // by the handle, so Close still closes.
    <div
      className="flex items-center justify-between"
      onPointerDown={drag.onPointerDown}
      style={drag.style}
    >
      <div className="flex items-center gap-2.5">
        {/* Set in the interface face rather than a marquee mono, and lit by
            weight and colour instead of a text-shadow glow. */}
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-nimbus-text">Nimbus</span>
        {/* A lit dot rather than a divider and a word. State is the thing this
            header exists to convey, and a dot in the state's own colour says
            it faster than a label — the label is then free to be quiet. */}
        <span className="flex items-center gap-1.5">
          <motion.span
            className="block h-[5px] w-[5px] rounded-full bg-nimbus-accent"
            animate={
              state === 'idle'
                ? { opacity: 0.55, scale: 1 }
                : { opacity: [0.45, 1, 0.45], scale: [1, 1.25, 1] }
            }
            transition={
              state === 'idle'
                ? { duration: 0.3 }
                : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
            }
          />
          <span className="text-[11px] text-nimbus-text-dim">
            {state === 'thinking' && searching ? 'Searching' : STATE_LABEL[state]}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        {/* Icons, not words. Five text labels in a row read as a toolbar from
            2010 and take three times the width; a mic that is plainly a mic
            needs no reading at all. */}
        <IconButton
          onClick={onToggleMic}
          active={micEnabled}
          label={micEnabled ? 'Voice on — click to mute' : 'Voice off — click to enable'}
        >
          {micEnabled ? <MicIcon /> : <MicOffIcon />}
        </IconButton>
        <IconButton
          onClick={onToggleTts}
          active={ttsEnabled}
          label={ttsEnabled ? 'Answers are spoken — click to mute' : 'Answers are silent — click to unmute'}
        >
          {ttsEnabled ? <SoundIcon /> : <SoundOffIcon />}
        </IconButton>

        <span className="mx-1 h-3.5 w-px bg-white/10" />

        <button
          onClick={onStanding}
          title="Watching — trains, events and reminders Nimbus is holding"
          className="rounded-lg px-2 py-1 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
        >
          Watching
        </button>
        <button
          onClick={onSettings}
          title="Settings — API keys and model"
          className="rounded-lg px-2 py-1 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
        >
          Settings
        </button>
        <button
          onClick={onClose}
          aria-label="Close Nimbus"
          title="Close (Esc)"
          className="-mr-1 ml-0.5 rounded-lg p-1.5 text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * A header toggle.
 *
 * Lit when on, quiet when off — the same two-state treatment the text buttons
 * had, at a third of the width and readable without being read.
 */
function IconButton({
  onClick,
  active,
  label,
  children
}: {
  onClick: () => void
  active: boolean
  label: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`rounded-full p-1.5 transition-colors ${
        active
          ? 'bg-nimbus-accent/15 text-nimbus-accent-bright'
          : 'text-nimbus-text-dim hover:bg-white/[0.07] hover:text-nimbus-text'
      }`}
    >
      {children}
    </button>
  )
}

/** 16px line icons, stroked in currentColor so the state palette drives them. */
const iconProps = {
  viewBox: '0 0 16 16',
  className: 'h-3.5 w-3.5',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

function MicIcon() {
  return (
    <svg {...iconProps}>
      <rect x="6" y="1.5" width="4" height="7.5" rx="2" />
      <path d="M3.5 7v.5a4.5 4.5 0 0 0 9 0V7M8 12v2.5" />
    </svg>
  )
}

function MicOffIcon() {
  return (
    <svg {...iconProps}>
      <rect x="6" y="1.5" width="4" height="7.5" rx="2" />
      <path d="M3.5 7v.5a4.5 4.5 0 0 0 9 0V7M8 12v2.5" />
      <path d="M2 2l12 12" />
    </svg>
  )
}

function SoundIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8.5 2.5 5 5.5H2.5v5H5l3.5 3z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6.5 6.5 0 0 1 0 9" />
    </svg>
  )
}

function SoundOffIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8.5 2.5 5 5.5H2.5v5H5l3.5 3z" />
      <path d="M11 6l3.5 4M14.5 6L11 10" />
    </svg>
  )
}

function SettingsPanel({
  config,
  onClose,
  onDragChange,
  onDragEnd
}: {
  config: NimbusConfig | null
  onClose: () => void
  onDragChange: (dragging: boolean) => void
  onDragEnd: (didMove: boolean) => void
}) {
  const drag = useDragHandle(onDragChange, onDragEnd)
  const rows: Array<[string, string]> = config
    ? [
        ['Hotkey', config.hotkey.enabled ? config.hotkey.accelerator : 'disabled'],
        ['Weather', config.integrations.weather ? 'on' : 'off'],
        ['Stocks', config.integrations.stocks ? 'on' : 'off'],
        ['Crypto', config.integrations.crypto ? 'on' : 'off'],
        ['Web search', config.integrations.search ? 'on' : 'off'],
        ['Music', config.integrations.music ? 'on' : 'off'],
        ['News', config.integrations.news ? 'on' : 'off'],
        ['GitHub', config.integrations.github ? 'on' : 'off']
      ]
    : []

  return (
    // Same shape as the assistant view: the header stays put and only the
    // content below it scrolls. Without the min-h-0/flex-1 pair the panel sizes
    // to its content, grows past the card's max height and gets clipped by the
    // card's overflow-hidden — which looked exactly like "settings can't
    // scroll", because there was nothing to scroll.
    <div className="flex min-h-0 flex-1 flex-col px-[18px] py-4">
      <div
        className="flex items-center justify-between"
        onPointerDown={drag.onPointerDown}
        style={drag.style}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-nimbus-accent">
          Settings
        </span>
        <button
          onClick={onClose}
          title="Back to the assistant (Esc)"
          className="-mr-1 rounded-md px-1.5 py-0.5 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
        >
          ← Back
        </button>
      </div>

      {!config ? (
        <p className="mt-3 text-[11px] text-nimbus-text-dim">Loading config…</p>
      ) : (
        <div className="nimbus-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-1.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-2">
                <dt className="text-[11px] text-nimbus-text-dim">{label}</dt>
                <dd
                  className={`text-[11px] font-medium tabular-nums ${
                    value === 'off' || value === 'disabled'
                      ? 'text-nimbus-text-dim'
                      : 'text-nimbus-accent-bright'
                  }`}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[10px] text-nimbus-text-dim">
            Edit config.json and restart Nimbus to change these.
          </p>
          <ExperienceSettings />
          <KeySettings />
        </div>
      )}
    </div>
  )
}
