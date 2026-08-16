import { useEffect, useMemo, useRef, useState } from 'react'
import { matchCapabilities, type Capability } from '@shared/capabilities'
import { CommandPalette } from './CommandPalette'

interface TextInputProps {
  onSubmit: (text: string) => void
  /** Re-focuses whenever this changes, so the field is ready on each open. */
  focusKey: unknown
  /** Fired on the first keystroke, so the mic can be closed before it hears
   *  typing and submits a competing transcript. */
  onTypingStart?: () => void
  placeholder?: string
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
  placeholder = 'Type a message, or / to see what I can do…'
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
    // Deliberately fills the box rather than submitting: you see the phrasing
    // that works, can edit it before sending, and learn it for next time.
    setValue(capability.example)
    inputRef.current?.focus()
  }

  return (
    <div className="mt-3 border-t border-white/[0.07] pt-2.5">
      {paletteOpen && (
        <CommandPalette
          matches={matches}
          activeIndex={activeIndex}
          onPick={pick}
          onHover={setActiveIndex}
        />
      )}

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
        className="flex items-center gap-2"
      >
        <span
          className="arcade-type shrink-0 text-[11px] text-nimbus-cyan"
          style={{ textShadow: '0 0 8px rgba(34,232,255,0.7)' }}
          aria-hidden
        >
          &gt;
        </span>
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
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-nimbus-text outline-none placeholder:text-nimbus-text-dim/70"
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
    </div>
  )
}
