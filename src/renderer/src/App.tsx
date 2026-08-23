import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, type ReactNode } from 'react'
import { Orb } from './components/Orb'
import { Waveform } from './components/Waveform'
import { accentVars, orbModeFor } from './lib/state-theme'
import { ResponseCard } from './components/ResponseCard'
import { SelectionActions } from './components/SelectionActions'
import { TextInput } from './components/TextInput'
import { KeySettings } from './components/KeySettings'
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
import type { NimbusConfig, NimbusState } from '@shared/types'

const STATE_LABEL: Record<NimbusState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  playing: 'Playing'
}

export default function App() {
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
  useEffect(() => {
    setHoldOpen(subtitles.active || meetingOpen)
  }, [subtitles.active, meetingOpen, setHoldOpen])

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

  return (
    <div className="flex h-screen w-screen items-start justify-center pt-2">
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, y: -14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            // Only the card itself captures the mouse; everything around it
            // stays click-through so the overlay never blocks the screen.
            onMouseEnter={() => window.nimbus.setMouseIgnore(false)}
            // Not while dragging: the window chases the pointer, so the
            // pointer leaves the card constantly mid-drag, and going
            // click-through there would drop the window out from under it.
            onMouseLeave={() => {
              if (!draggingRef.current) window.nimbus.setMouseIgnore(true)
            }}
            // Capped to the window so a long answer scrolls instead of being
            // clipped off the bottom with no way to reach it.
            className="relative flex max-h-[calc(100vh-1rem)] w-[492px] flex-col overflow-hidden rounded-[20px] border border-nimbus-border bg-nimbus-bg backdrop-blur-[32px] backdrop-saturate-[1.8] backdrop-brightness-105"
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
              ...accentVars(orbModeFor(state, searching)),
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
              <SettingsPanel config={config} onClose={closePanel} onDragChange={onDragChange} />
            ) : mode === 'standing' ? (
              <StandingPanel onClose={closePanel} onDragChange={onDragChange} />
            ) : (
              // Header and input stay put; only the answer between them moves.
              <div className="flex min-h-0 flex-1 flex-col px-[18px] py-4">
                <Header
                  state={state}
                  searching={searching}
                  onClose={dismiss}
                  micEnabled={micEnabled}
                  onToggleMic={toggleMic}
                  ttsEnabled={ttsEnabled}
                  onToggleTts={toggleTts}
                  onStanding={openStanding}
                  onSettings={openSettings}
                  onDragChange={onDragChange}
                />

                {/* No items-start here: it would let the scrolling child size
                    to its content, so it grew past the card and got clipped
                    instead of scrolling. The orb pins itself with self-start. */}
                <div className="mt-2.5 flex min-h-0 flex-1 gap-3.5">
                  <Orb state={state} searching={searching} answerSeq={answerSeq} levelRef={levelRef} />

                  <div className="nimbus-scroll min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 pt-0.5">
                    {/* An existing answer stays on screen while listening for a
                        follow-up, so there's time to actually read it. */}
                    {/* Response takes priority over a later error, so a mic
                        hiccup can't wipe out an answer being read. */}
                    {response ? (
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
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                          src={pendingCapture}
                          alt="Captured screen"
                          className="h-14 w-24 shrink-0 rounded-md object-cover object-top ring-1 ring-nimbus-accent/40"
                        />
                        <div className="min-w-0 flex-1">
                          <Waveform levelRef={levelRef} barCount={18} />
                          <p className="mt-1 text-[11px] text-nimbus-accent-bright">
                            Screen captured — ask about it
                          </p>
                        </div>
                      </div>
                    ) : state === 'listening' ? (
                      <div className="flex h-14 flex-col justify-center gap-1">
                        <Waveform levelRef={levelRef} />
                        <p className="text-[9.5px] text-nimbus-text-dim">
                          Listening — say &ldquo;stop&rdquo; when done
                        </p>
                      </div>
                    ) : (
                      // Mic is closed (typing, or a finished typed turn) — say
                      // so rather than showing a dead "listening" waveform.
                      <div className="flex h-14 flex-col justify-center">
                        <p className="text-[9.5px] text-nimbus-text-dim">
                          &gt; {micEnabled ? 'Type below, or speak' : 'Voice off — type below'}
                        </p>
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

                {/* Always available — talking isn't possible everywhere. */}
                <TextInput
                  onSubmit={submitText}
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

                {(response || error) && state === 'listening' && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-3 flex items-center gap-2.5 border-t border-white/[0.06] pt-2.5"
                  >
                    <Waveform levelRef={levelRef} barCount={18} />
                    <span className="text-[10px] uppercase tracking-[0.14em] text-nimbus-text-dim">
                      Listening — say &ldquo;stop&rdquo; to close
                    </span>
                  </motion.div>
                )}
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
  onDragChange
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
}) {
  const drag = useDragHandle(onDragChange)
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
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-nimbus-text">Nimbus</span>
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
          Setup
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
      className={`rounded-lg p-1.5 transition-colors ${
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
  onDragChange
}: {
  config: NimbusConfig | null
  onClose: () => void
  onDragChange: (dragging: boolean) => void
}) {
  const drag = useDragHandle(onDragChange)
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
          <KeySettings />
        </div>
      )}
    </div>
  )
}
