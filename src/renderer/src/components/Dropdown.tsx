import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'

export interface DropdownOption {
  value: string
  label: string
  /** Optional second line, e.g. what a model is for. */
  hint?: string
}

interface DropdownProps {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  placeholder?: string
  /** Above this many options a filter box appears. */
  filterAbove?: number
  disabled?: boolean
}

/**
 * A select that belongs to this app.
 *
 * `<select>` cannot be styled past its border: the popup is drawn by Windows
 * itself, in the system font on a white background, which lands in the middle
 * of a dark translucent overlay looking like a dialog from another program.
 * It is also the wrong control for the job — the provider model lists run to
 * dozens of entries, and a native select gives no way to search them.
 *
 * Closes on outside click and on Escape, which the overlay's own Escape
 * handler would otherwise take as "leave this panel".
 */
export function Dropdown({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  filterAbove = 8,
  disabled = false
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = options.find((option) => option.value === value)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle)
    )
  }, [options, query])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Stopped before it reaches the window: Escape here means "close the
      // list", not "close the panel I was editing".
      event.stopPropagation()
      setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    // Capture phase, so this runs before the app-level Escape handler.
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const choose = (next: string): void => {
    onChange(next)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((isOpen) => !isOpen)}
        className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-[11px] transition-colors disabled:opacity-40 ${
          open
            ? 'border-nimbus-accent/60 bg-nimbus-accent/10 text-nimbus-text'
            : 'border-white/[0.07] bg-white/[0.03] text-nimbus-text hover:bg-white/[0.06]'
        }`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-nimbus-text-dim'}`}>
          {selected?.label ?? placeholder}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="shrink-0 text-[8px] text-nimbus-text-dim"
        >
          ▼
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            // Above everything else in the panel, and anchored to the button
            // rather than the page so it travels with a scrolling form.
            className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-nimbus-border bg-nimbus-bg shadow-[0_16px_40px_-12px_rgba(0,0,0,0.8)] backdrop-blur-2xl"
          >
            {options.length > filterAbove && (
              <div className="border-b border-white/[0.06] p-1.5">
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter…"
                  className="w-full rounded-md border border-white/[0.07] bg-black/30 px-2 py-1 text-[11px] text-nimbus-text outline-none placeholder:text-nimbus-text-dim focus:border-nimbus-accent/50"
                />
              </div>
            )}

            <div className="nimbus-scroll max-h-[168px] overflow-y-auto overscroll-contain py-1">
              {visible.length === 0 ? (
                <p className="px-2.5 py-2 text-[10.5px] text-nimbus-text-dim">Nothing matches.</p>
              ) : (
                visible.map((option) => {
                  const isSelected = option.value === value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => choose(option.value)}
                      className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors ${
                        isSelected
                          ? 'bg-nimbus-accent/15 text-nimbus-text'
                          : 'text-nimbus-text-dim hover:bg-white/[0.06] hover:text-nimbus-text'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px]">{option.label}</span>
                        {option.hint && (
                          <span className="block truncate text-[9.5px] text-nimbus-text-dim">
                            {option.hint}
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <span className="shrink-0 text-[10px] text-nimbus-accent-bright">✓</span>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
