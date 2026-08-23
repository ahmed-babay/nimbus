import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { EASE } from './Motion'
import { useDragHandle } from '../hooks/useDragHandle'
import type { Interruption, StandingItem } from '@shared/types'

/**
 * Everything Nimbus is holding, in one place.
 *
 * Until this existed, a watched train and a saved event were invisible: they
 * only surfaced when they fired, or when a question happened to mention them.
 * That is a bad property for a tray app whose whole promise is "I'll tell you
 * later" — you cannot trust a promise you cannot see.
 *
 * Items are ordered by when they come up, not grouped by type, because time is
 * the ordering that matters. A train in twenty minutes belongs above a
 * birthday next week no matter which store it came from.
 */

const KIND: Record<StandingItem['kind'], { icon: string; label: string; tint: string }> = {
  watch: { icon: '🚆', label: 'Following', tint: 'text-nimbus-cyan' },
  outdoor: { icon: '🌤', label: 'Weather watch', tint: 'text-nimbus-positive' },
  price: { icon: '📈', label: 'Price alert', tint: 'text-nimbus-yellow' },
  event: { icon: '📅', label: 'Event', tint: 'text-nimbus-accent-bright' },
  reminder: { icon: '⏰', label: 'Reminder', tint: 'text-nimbus-yellow' }
}

export function StandingPanel({
  onClose,
  onDragChange,
  onDragEnd
}: {
  onClose: () => void
  onDragChange: (dragging: boolean) => void
  onDragEnd?: (didMove: boolean) => void
}) {
  const drag = useDragHandle(onDragChange, onDragEnd)
  const [items, setItems] = useState<StandingItem[] | null>(null)
  /**
   * Things Nimbus raised while it had been told to stay quiet.
   *
   * Without this they are simply lost: a reminder that came due at two in the
   * morning was recorded and never shown to anybody. Quiet hours are meant to
   * defer an interruption, not delete it.
   */
  const [missed, setMissed] = useState<Interruption[]>([])

  const refresh = useCallback(() => {
    void window.nimbus.getStanding().then(setItems)
    void window.nimbus.getMissed().then(setMissed)
  }, [])

  useEffect(refresh, [refresh])

  useEffect(() => {
    // A watched train's delay changes underneath this panel, so it re-reads
    // while open rather than showing whatever was true when it was opened.
    const timer = setInterval(refresh, 20_000)
    return () => clearInterval(timer)
  }, [refresh])

  const cancel = (item: StandingItem): void => {
    void window.nimbus.cancelStanding(item.kind, item.id).then((removed) => {
      if (removed) setItems((current) => (current ?? []).filter((row) => row.id !== item.id))
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-[18px] py-4">
      <div
        className="flex items-center justify-between"
        onPointerDown={drag.onPointerDown}
        style={drag.style}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-nimbus-accent">
          Watching for you
        </span>
        <button
          onClick={onClose}
          title="Back to the assistant (Esc)"
          className="-mr-1 rounded-md px-1.5 py-0.5 text-[11px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
        >
          ← Back
        </button>
      </div>

      {missed.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-2.5 rounded-lg border border-nimbus-accent/25 bg-nimbus-accent/[0.07] px-2.5 py-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-nimbus-accent-bright">
              While you were away
            </span>
            <button
              onClick={() => {
                void window.nimbus.clearMissed().then(() => setMissed([]))
              }}
              className="rounded px-1.5 py-0.5 text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-text"
            >
              Got it
            </button>
          </div>
          <ul className="mt-1.5 space-y-1">
            {missed.slice(0, 4).map((entry) => (
              <li key={entry.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[11px] leading-snug text-nimbus-text">
                  {entry.text}
                </span>
                {/* Muting is by subject, so silencing one delayed train leaves
                    every other watch alone. */}
                <button
                  onClick={() => {
                    void window.nimbus.muteSource(entry.source)
                    setMissed((current) => current.filter((row) => row.source !== entry.source))
                  }}
                  title="Stop telling me about this"
                  className="shrink-0 rounded px-1 text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.07] hover:text-nimbus-negative"
                >
                  Mute
                </button>
              </li>
            ))}
          </ul>
        </motion.div>
      )}

      {items === null ? (
        <p className="mt-3 text-[11px] text-nimbus-text-dim">Checking…</p>
      ) : items.length === 0 ? (
        <div className="mt-3">
          <p className="text-[11px] text-nimbus-text-dim">
            Nothing standing. Nimbus isn&apos;t holding anything for you right now.
          </p>
          <p className="mt-2 text-[10px] leading-relaxed text-nimbus-text-dim">
            Try &ldquo;the 17:30 to Frankfurt, keep me posted&rdquo;, &ldquo;remind me to call the
            landlord at 6&rdquo;, or &ldquo;I have a dentist appointment on the 24th&rdquo;.
          </p>
        </div>
      ) : (
        <ul className="nimbus-scroll mt-2.5 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          <AnimatePresence initial={false}>
            {items.map((item, index) => {
              const kind = KIND[item.kind]
              return (
                <motion.li
                  key={`${item.kind}:${item.id}`}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  // Slides out on cancel rather than vanishing, so the click
                  // visibly did the thing.
                  exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
                  transition={{ duration: 0.3, ease: EASE, delay: index * 0.04 }}
                  className="mb-1.5 flex items-start gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1.5"
                >
                <span className="mt-0.5 w-4 shrink-0 text-center text-[11px]">{kind.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-nimbus-text">
                      {item.title}
                    </span>
                    {/* Only shown when something is actually wrong, so the eye
                        goes to it rather than learning to ignore a badge. */}
                    {item.warning && (
                      <span className="shrink-0 rounded bg-nimbus-negative/15 px-1 text-[9.5px] text-nimbus-negative">
                        {item.warning}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5 text-[9.5px] text-nimbus-text-dim">
                    <span className={kind.tint}>{kind.label}</span>
                    {item.detail && (
                      <>
                        <span className="opacity-50">·</span>
                        <span className="truncate">{item.detail}</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => cancel(item)}
                  aria-label={`Cancel ${item.title}`}
                  title="Stop this"
                  className="shrink-0 rounded px-1 text-[11px] leading-none text-nimbus-text-dim transition-colors hover:bg-white/[0.08] hover:text-nimbus-negative"
                >
                  ×
                  </button>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  )
}
