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
      <div className="mb-2 rounded-lg border border-white/[0.07] bg-nimbus-bg-raised px-3 py-2 text-[11px] text-nimbus-text-dim">
        Nothing matches — but you can just ask in your own words.
      </div>
    )
  }

  let lastGroup = ''

  return (
    <ul
      ref={listRef}
      className="nimbus-scroll mb-2 max-h-[210px] overflow-y-auto rounded-lg border border-white/[0.07] bg-nimbus-bg-raised py-1"
    >
      {matches.map((capability, index) => {
        const showGroup = capability.group !== lastGroup
        lastGroup = capability.group
        const active = index === activeIndex

        return (
          <li key={capability.title}>
            {showGroup && (
              <div className="px-2.5 pb-0.5 pt-1.5 text-[9px] uppercase tracking-wider text-nimbus-accent/70">
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
              className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors ${
                active ? 'bg-nimbus-accent/20' : 'hover:bg-white/[0.05]'
              }`}
            >
              <span
                className={`shrink-0 text-[11.5px] ${active ? 'text-nimbus-text' : 'text-nimbus-text-dim'}`}
              >
                {capability.title}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] italic text-nimbus-text-dim/80">
                “{capability.example}”
              </span>
              {capability.requires && (
                <span className="shrink-0 text-[9px] text-nimbus-yellow">
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
