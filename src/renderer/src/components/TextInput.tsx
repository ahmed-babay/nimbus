import { useEffect, useRef, useState } from 'react'

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
 */
export function TextInput({
  onSubmit,
  focusKey,
  onTypingStart,
  placeholder = 'Type a message…'
}: TextInputProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus on open so you can just start typing, with no click first. The
  // overlay window takes focus when shown, so this actually lands.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [focusKey])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!value.trim()) return
        onSubmit(value)
        setValue('')
      }}
      className="mt-3 flex items-center gap-2 border-t border-white/[0.07] pt-2.5"
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
        // Esc is handled globally to close the overlay; stop the keystroke
        // here so it doesn't also get treated as ordinary typing.
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-nimbus-text outline-none placeholder:text-nimbus-text-dim/70"
      />
      {value.trim() && (
        <button
          type="submit"
          className="arcade-type shrink-0 rounded border border-nimbus-border px-2 py-0.5 text-[9px] text-nimbus-accent-bright transition-colors hover:bg-nimbus-accent/20"
        >
          Enter
        </button>
      )}
    </form>
  )
}
