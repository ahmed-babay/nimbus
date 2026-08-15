import { AnimatePresence, motion } from 'framer-motion'
import { useEffect } from 'react'
import { Orb } from './components/Orb'
import { Waveform } from './components/Waveform'
import { ResponseCard } from './components/ResponseCard'
import { SelectionActions } from './components/SelectionActions'
import { TextInput } from './components/TextInput'
import { useNimbus } from './hooks/useNimbus'
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
    dismiss
  } = useNimbus()
  // Paced reveal: the model streams in a few big chunks, which otherwise
  // lands as the whole answer at once.
  const typedText = useTypewriter(streamingText)
  // Driven by one explicit flag rather than inferred from state and content.
  const isVisible = isOpen || mode === 'settings'

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismiss])

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
            onMouseLeave={() => window.nimbus.setMouseIgnore(true)}
            className="relative w-[492px] overflow-hidden rounded-[20px] border border-nimbus-border bg-nimbus-bg backdrop-blur-2xl"
            style={{
              boxShadow:
                '0 18px 50px -12px rgba(0,0,0,0.85), 0 0 0 2px rgba(255,62,165,0.35), 0 0 26px -4px rgba(255,62,165,0.45), 0 0 46px -10px rgba(34,232,255,0.3)'
            }}
          >
            {/* CRT scanlines over the whole panel */}
            <div className="nimbus-scanlines pointer-events-none absolute inset-0 opacity-70" />
            {/* Tube vignette — darker toward the corners, like curved glass */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)'
              }}
            />
            {/* Neon marquee edge */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
              style={{
                background:
                  'linear-gradient(90deg, var(--color-nimbus-cyan), var(--color-nimbus-accent), var(--color-nimbus-yellow), var(--color-nimbus-accent), var(--color-nimbus-cyan))'
              }}
            />
            {/* Marquee chase while thinking */}
            {state === 'thinking' && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] overflow-hidden">
                <div
                  className="nimbus-scan h-full w-1/4"
                  style={{ background: 'rgba(255,255,255,0.95)' }}
                />
              </div>
            )}

            {mode === 'settings' ? (
              <SettingsPanel config={config} onClose={dismiss} />
            ) : (
              <div className="px-4 py-3.5">
                <Header state={state} onClose={dismiss} />

                <div className="mt-2.5 flex items-start gap-3.5">
                  <Orb state={state} levelRef={levelRef} />

                  <div className="min-w-0 flex-1 pt-0.5">
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
                          <p className="arcade-type mt-1 text-[10px] text-nimbus-yellow">Thinking…</p>
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
                        <p className="arcade-type text-[9px] text-nimbus-cyan">
                          &gt; Listening — say &ldquo;stop&rdquo; when done
                        </p>
                      </div>
                    ) : (
                      // Mic is closed (typing, or a finished typed turn) — say
                      // so rather than showing a dead "listening" waveform.
                      <div className="flex h-14 flex-col justify-center">
                        <p className="arcade-type text-[9px] text-nimbus-text-dim">
                          &gt; Type below, or press {config?.hotkey.accelerator ?? 'the hotkey'} to
                          talk
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

                {/* Always available — talking isn't possible everywhere. */}
                <TextInput
                  onSubmit={submitText}
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
    </div>
  )
}

function Header({ state, onClose }: { state: NimbusState; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span
          className="arcade-type nimbus-flicker text-[11px] font-bold text-nimbus-accent"
          style={{ textShadow: '0 0 8px rgba(255,62,165,0.9), 0 0 16px rgba(255,62,165,0.5)' }}
        >
          Nimbus
        </span>
        <span className="h-3 w-px bg-nimbus-accent/30" />
        <span
          className="arcade-type text-[10px] text-nimbus-cyan"
          style={{ textShadow: '0 0 8px rgba(34,232,255,0.7)' }}
        >
          {STATE_LABEL[state]}
        </span>
      </div>
      <button
        onClick={onClose}
        aria-label="Close Nimbus"
        className="arcade-type -mr-1 rounded border border-nimbus-border px-1.5 py-0.5 text-[9px] text-nimbus-text-dim transition-colors hover:bg-nimbus-accent/20 hover:text-nimbus-text"
      >
        Esc
      </button>
    </div>
  )
}

function SettingsPanel({ config, onClose }: { config: NimbusConfig | null; onClose: () => void }) {
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
    <div className="px-4 py-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-nimbus-accent">
          Settings
        </span>
        <button
          onClick={onClose}
          className="-mr-1 rounded-md px-1.5 py-0.5 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
        >
          Close
        </button>
      </div>

      {!config ? (
        <p className="mt-3 text-[11px] text-nimbus-text-dim">Loading config…</p>
      ) : (
        <>
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
          <p className="mt-3 border-t border-white/[0.06] pt-2 text-[10px] text-nimbus-text-dim">
            Edit config.json and restart Nimbus to change these.
          </p>
        </>
      )}
    </div>
  )
}
