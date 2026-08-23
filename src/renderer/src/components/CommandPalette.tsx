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
      <div className="rounded-xl border border-white/15 bg-[#1a1c28] px-3 py-2.5 text-[12px] text-[#d5d8e4] shadow-[0_16px_40px_-16px_rgba(0,0,0,0.85)]">
        Nothing matches — but you can just ask in your own words.
      </div>
    )
  }

  let lastGroup = ''

  return (
    <ul
      ref={listRef}
      className="nimbus-scroll max-h-[min(220px,42vh)] overflow-y-auto rounded-xl border border-white/15 bg-[#1a1c28] py-1.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.85)]"
    >
      {matches.map((capability, index) => {
        const showGroup = capability.group !== lastGroup
        lastGroup = capability.group
        const active = index === activeIndex

        return (
          <li key={capability.title}>
            {showGroup && (
              <div className="px-2.5 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#ffb198]">
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
              className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors ${
                active ? 'bg-[#ff7a5c] text-white' : 'hover:bg-white/[0.08]'
              }`}
            >
              <span className={`shrink-0 text-[12px] font-medium ${active ? 'text-white' : 'text-[#f2f4fa]'}`}>
                {capability.title}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[11px] italic ${
                  active ? 'text-white/85' : 'text-[#c4c8d6]'
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
