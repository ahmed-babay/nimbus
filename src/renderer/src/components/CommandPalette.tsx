import { useEffect, useRef } from 'react'
import type { Capability } from '@shared/capabilities'

interface CommandPaletteProps {
  matches: Capability[]
  activeIndex: number
  onPick: (capability: Capability) => void
  onHover: (index: number) => void
}

/**
 * The one thing you have to learn: type `/` and everything Nimbus can do is
 * listed. Picking an entry types its example into the input instead of running
 * a hidden command, so the palette teaches the phrasing and then becomes
 * unnecessary — next time you just say it.
 *
 * Anchored above the composer (see TextInput) so it grows upward from the
 * field, including in the squeezed corner dock.
 */
export function CommandPalette({ matches, activeIndex, onPick, onHover }: CommandPaletteProps) {
  const listRef = useRef<HTMLUListElement>(null)

  // Keep the keyboard selection in view when arrowing past the fold.
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (matches.length === 0) {
    return (
      <div className="nimbus-command-menu px-4 py-4 text-[12px] text-nimbus-text-dim">
        Nothing matches — but you can just ask in your own words.
      </div>
    )
  }

  let lastGroup = ''

  return (
    <ul
      ref={listRef}
      aria-label="Nimbus commands"
      className="nimbus-command-menu nimbus-scroll max-h-[min(240px,42vh)] overflow-y-auto py-2"
    >
      {matches.map((capability, index) => {
        const showGroup = capability.group !== lastGroup
        lastGroup = capability.group
        const active = index === activeIndex

        return (
          <li key={capability.title}>
            {showGroup && (
              <div className="px-4 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-[0.16em] text-nimbus-accent-bright">
                {capability.group}
              </div>
            )}
            <button
              type="button"
              data-active={active}
              // onMouseDown, not onClick: the input must not lose focus first,
              // or the palette closes before the pick registers.
              onMouseDown={(event) => {
                event.preventDefault()
                onPick(capability)
              }}
              onMouseEnter={() => onHover(index)}
              onClick={(event) => { if (event.detail === 0) onPick(capability) }}
              className={`nimbus-command-item flex w-full items-baseline gap-3 px-4 py-2.5 text-left transition-colors ${
                active ? 'bg-nimbus-accent/15 text-nimbus-accent-bright' : 'hover:bg-white/[0.04]'
              }`}
            >
              <span className={`shrink-0 text-[12px] font-medium ${active ? 'text-nimbus-accent-bright' : 'text-nimbus-text'}`}>
                {capability.title}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[11px] italic ${
                  active ? 'text-nimbus-text' : 'text-nimbus-text-dim'
                }`}
              >
                “{capability.example}”
              </span>
              {capability.requires && (
                <span className={`shrink-0 text-[9px] ${active ? 'text-white/80' : 'text-nimbus-yellow'}`}>
                  {capability.requires}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
