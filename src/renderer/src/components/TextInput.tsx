import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { matchCapabilities, type Capability } from '@shared/capabilities'
import { CommandPalette } from './CommandPalette'

interface TextInputProps {
  onSubmit: (text: string) => void
  /** Re-focuses whenever this changes, so the field is ready on each open. */
  focusKey: unknown
  /** Fired on the first keystroke, so the mic can be closed before it hears
   *  typing and submits a competing transcript. */
  onTypingStart?: () => void
  /** Runs a palette entry that opens a panel rather than asking something. */
  onAction?: (action: NonNullable<Capability['action']>) => void
  placeholder?: string
  /** Drops the top margin and uses a pill field, for the squeezed dock. */
  compact?: boolean
  onPaletteChange?: (open: boolean) => void
}

/**
 * Typed alternative to speaking. Voice is unusable in an open office, a quiet
 * house at night, or a noisy room — without this, those situations left the
 * app with nothing to offer. Submissions go through the same router as
 * speech, so every flow behaves identically either way.
 *
 * Typing `/` opens the capability palette (see CommandPalette): the single
 * discoverability mechanism, so that adding features never means adding
 * shortcuts for people to memorise.
 */
export function TextInput({
  onSubmit,
  focusKey,
  onTypingStart,
  onAction,
  onPaletteChange,
  placeholder = 'Type a message, or / to see what I can do…',
  compact = false
}: TextInputProps) {
  const [value, setValue] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Only a *leading* slash opens it, so a question containing one ("what's
  // 8/3") types normally.
  const paletteQuery = value.startsWith('/') ? value.slice(1) : null
  const matches = useMemo(
    () => (paletteQuery === null ? [] : matchCapabilities(paletteQuery)),
    [paletteQuery]
  )
  const paletteOpen = paletteQuery !== null
  useEffect(() => { onPaletteChange?.(paletteOpen) }, [paletteOpen, onPaletteChange])

  useEffect(() => {
    setActiveIndex(0)
  }, [paletteQuery])

  // Focus on open so you can just start typing, with no click first. The
  // overlay window takes focus when shown, so this actually lands.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [focusKey])

  const pick = (capability: Capability): void => {
    // Some entries are not questions — settings opens a panel instead.
    if (capability.action) {
      setValue('')
      onAction?.(capability.action)
      return
    }
    // Deliberately fills the box rather than submitting: you see the phrasing
    // that works, can edit it before sending, and learn it for next time.
    setValue(capability.example)
    inputRef.current?.focus()
  }

  return (
    <div className={`relative ${compact ? 'z-20' : 'mt-3'}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (paletteOpen) {
            const chosen = matches[activeIndex]
            if (chosen) pick(chosen)
            return
          }
          if (!value.trim()) return
          onSubmit(value)
          setValue('')
        }}
        // A field, not a terminal. The neon "&gt;" prompt and its glow were the
        // last of the arcade theme in here; a bordered well that lights on
        // focus is what every other desktop tool does, and it tells you where
        // to type without saying anything.
        className={`flex items-center gap-2 border px-3 py-2 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)] transition-colors ${
          compact
            ? 'nimbus-glass rounded-full border-white/25 py-2.5 focus-within:border-nimbus-accent/55'
            : 'rounded-2xl border-white/15 bg-white/[0.045] py-3 focus-within:border-nimbus-accent/45'
        }`}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            if (!value && event.target.value) onTypingStart?.()
            setValue(event.target.value)
          }}
          onKeyDown={(event) => {
            if (paletteOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((current) => Math.min(current + 1, matches.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((current) => Math.max(current - 1, 0))
                return
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                const chosen = matches[activeIndex]
                if (chosen) pick(chosen)
                return
              }
              if (event.key === 'Escape') {
                // Closes the palette only. Without stopping propagation the
                // global handler would close the whole overlay, which is a
                // startling response to backing out of a menu.
                event.preventDefault()
                event.stopPropagation()
                setValue('')
                return
              }
            }
            // Esc is handled globally to close the overlay; stop the keystroke
            // here so it doesn't also get treated as ordinary typing.
            if (event.key === 'Escape') event.currentTarget.blur()
          }}
          placeholder={placeholder}
          aria-label="Message Nimbus"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-nimbus-text outline-none placeholder:text-nimbus-text-dim"
        />
        {paletteOpen ? (
          <span className="arcade-type shrink-0 text-[9px] text-nimbus-text-dim">↑↓ Enter</span>
        ) : (
          value.trim() && (
            <button
              type="submit"
              className="arcade-type shrink-0 rounded border border-nimbus-border px-2 py-0.5 text-[9px] text-nimbus-accent-bright transition-colors hover:bg-nimbus-accent/20"
            >
              Enter
            </button>
          )
        )}
      </form>
      {paletteOpen && (
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          className="mt-2"
        >
          <CommandPalette
            matches={matches}
            activeIndex={activeIndex}
            onPick={pick}
            onHover={setActiveIndex}
          />
        </motion.div>
      )}
    </div>
  )
}
