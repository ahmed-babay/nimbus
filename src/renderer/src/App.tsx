import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { Orb } from './components/Orb'
import { Waveform } from './components/Waveform'
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
            className="relative flex max-h-[calc(100vh-1rem)] w-[492px] flex-col overflow-hidden rounded-[18px] border border-nimbus-border bg-nimbus-bg backdrop-blur-2xl"
            // Depth from shadow and a hairline edge rather than a neon ring.
            // A glowing outline is the single strongest "toy" signal a panel
            // can send, and this one sits next to real work all day.
            style={{
              boxShadow:
                '0 24px 64px -16px rgba(0,0,0,0.7), 0 2px 8px -2px rgba(0,0,0,0.5), inset 0 1px 0 0 rgba(255,255,255,0.06)'
            }}
          >
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
              <div className="flex min-h-0 flex-1 flex-col px-4 py-3.5">
                <Header
                  state={state}
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
                  <Orb state={state} levelRef={levelRef} />

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
                          <p className="truncate text-[11px] text-nimbus-text-dim">
                            &ldquo;{transcript}&rdquo;
                          </p>
                        )}
                        {typedText ? (
                          // Live tokens from the model, with a blinking caret.
                          <p className="mt-1 text-[13px] leading-relaxed text-nimbus-text">
                            {typedText}
                            <motion.span
                              animate={{ opacity: [1, 0.15, 1] }}
                              transition={{ duration: 0.9, repeat: Infinity }}
                              className="ml-0.5 inline-block h-[13px] w-[2px] translate-y-[2px] bg-nimbus-accent"
                            />
                          </p>
                        ) : (
                          <p className="mt-1 text-[10px] text-nimbus-text-dim">Thinking…</p>
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
                          &gt; Listening — say &ldquo;stop&rdquo; when done
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
      <div className="flex items-center gap-2">
        {/* Set in the interface face rather than a marquee mono, and lit by
            weight and colour instead of a text-shadow glow. */}
        <span className="text-[12px] font-semibold tracking-[0.01em] text-nimbus-text">Nimbus</span>
        <span className="h-3 w-px bg-white/10" />
        <span className="text-[10.5px] text-nimbus-text-dim">{STATE_LABEL[state]}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={onToggleMic}
          aria-label={micEnabled ? 'Turn off voice input' : 'Turn on voice input'}
          title={micEnabled ? 'Voice on — click to mute' : 'Voice off — click to enable'}
          className={`rounded-md px-2 py-[3px] text-[10px] transition-colors ${
            micEnabled
              ? 'bg-nimbus-accent/15 text-nimbus-accent-bright'
              : 'text-nimbus-text-dim hover:bg-white/[0.06]'
          }`}
        >
          {micEnabled ? 'Mic on' : 'Mic off'}
        </button>
        <button
          onClick={onToggleTts}
          aria-label={ttsEnabled ? 'Mute spoken answers' : 'Unmute spoken answers'}
          title={
            ttsEnabled
              ? 'Answers are spoken — click to mute'
              : 'Answers are silent — click to unmute'
          }
          className={`rounded-md px-2 py-[3px] text-[10px] transition-colors ${
            ttsEnabled
              ? 'bg-nimbus-accent/15 text-nimbus-accent-bright'
              : 'text-nimbus-text-dim hover:bg-white/[0.06]'
          }`}
        >
          {ttsEnabled ? 'Sound on' : 'Sound off'}
        </button>
        <button
          onClick={onStanding}
          aria-label="Things Nimbus is watching for you"
          title="Watching — trains, events and reminders Nimbus is holding"
          className="rounded-md px-2 py-[3px] text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
        >
          Watching
        </button>
        <button
          onClick={onSettings}
          aria-label="Settings and API keys"
          title="Settings — API keys and model"
          className="rounded-md px-2 py-[3px] text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
        >
          Setup
        </button>
        <button
          onClick={onClose}
          aria-label="Close Nimbus"
          className="-mr-1 rounded-md px-2 py-[3px] text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
        >
          Esc
        </button>
      </div>
    </div>
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
    <div className="flex min-h-0 flex-1 flex-col px-4 py-3.5">
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
