import { useEffect } from 'react'
import { ORB_PALETTE, type OrbMode } from '../lib/orb-palette'
import { lighten, darken } from '../lib/color'

/**
 * Keeps every button, border and highlight in the app the same colour as the
 * orb, live. Tailwind's `--color-nimbus-accent*` tokens are real CSS custom
 * properties (that's what `@theme` compiles to), so overwriting them on the
 * root element re-themes every component using them — a border in the
 * Standing panel, a button in Settings — without either needing to know the
 * orb exists.
 *
 * Before this, the accent was a fixed colour and only the orb itself moved
 * through the state palette, so the moment the orb went blue-while-listening
 * or violet-while-thinking, every panel next to it stayed whatever the fixed
 * accent was — two colour schemes visibly disagreeing about what Nimbus was
 * doing at that exact moment.
 */
export function useAccentTheme(mode: OrbMode): void {
  useEffect(() => {
    const [, , rim] = ORB_PALETTE[mode]
    const root = document.documentElement.style
    root.setProperty('--color-nimbus-accent', rim)
    root.setProperty('--color-nimbus-accent-bright', lighten(rim, 0.35))
    root.setProperty('--color-nimbus-accent-deep', darken(rim, 0.32))
  }, [mode])
}
