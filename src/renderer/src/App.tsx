import { AnimatePresence, motion } from 'framer-motion'
import { useEffect } from 'react'
import { Orb } from './components/Orb'
import { Waveform } from './components/Waveform'
import { ResponseCard } from './components/ResponseCard'
import { SelectionActions } from './components/SelectionActions'
import { useNimbus } from './hooks/useNimbus'
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
    dismiss
  } = useNimbus()
  // The selection flow has no mic, so it sits at 'idle' while waiting for the
  // user to pick an action — visibility can't be driven by state alone.
  const isVisible =
    mode === 'settings' || state !== 'idle' || pendingSelection !== null || Boolean(error)

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
            className="relative w-[492px] overflow-hidden rounded-[20px] border border-nimbus-border bg-nimbus-bg backdrop-blur-2xl"
            style={{
              boxShadow:
                '0 20px 60px -12px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,138,61,0.06), inset 0 1px 0 rgba(255,255,255,0.07)'
            }}
          >
            {/* Warm top edge highlight */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-px"
              style={{
                background:
                  'linear-gradient(90deg, transparent, rgba(255,138,61,0.55), transparent)'
              }}
            />
            {/* Scanning line while thinking */}
            {state === 'thinking' && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
                <div
                  className="nimbus-scan h-full w-1/3"
                  style={{
                    background:
                      'linear-gradient(90deg, transparent, rgba(255,176,103,0.95), transparent)'
                  }}
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
                        {streamingText ? (
                          // Live tokens from the model, with a blinking caret.
                          <p className="mt-1 text-[13px] leading-relaxed text-nimbus-text">
                            {streamingText}
                            <motion.span
                              animate={{ opacity: [1, 0.15, 1] }}
                              transition={{ duration: 0.9, repeat: Infinity }}
                              className="ml-0.5 inline-block h-[13px] w-[2px] translate-y-[2px] bg-nimbus-accent"
                            />
                          </p>
                        ) : (
                          <p className="mt-1 text-[11px] text-nimbus-accent-bright">Thinking…</p>
                        )}
                      </div>
                    ) : pendingSelection ? (
                      <SelectionActions
                        text={pendingSelection}
                        onRun={(kind, label) => runTextAction(kind, label)}
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
                    ) : (
                      <div className="flex h-14 flex-col justify-center gap-1">
                        <Waveform levelRef={levelRef} />
                        <p className="text-[11px] text-nimbus-text-dim">
                          Listening — say &ldquo;stop&rdquo; when you&rsquo;re done
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
        <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-nimbus-accent">
          Nimbus
        </span>
        <span className="h-3 w-px bg-white/10" />
        <span className="text-[10px] uppercase tracking-[0.14em] text-nimbus-text-dim">
          {STATE_LABEL[state]}
        </span>
      </div>
      <button
        onClick={onClose}
        aria-label="Close Nimbus"
        className="-mr-1 rounded-md px-1.5 py-0.5 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
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
