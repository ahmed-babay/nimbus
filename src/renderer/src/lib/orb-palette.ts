import type { NimbusState } from '@shared/types'

/** The orb's own mode key includes a variant no `NimbusState` has. */
export type OrbMode = NimbusState | 'searching'

/**
 * Per-state hues, as [core, mid, rim] — dark to bright.
 *
 * The single source of truth for what each state looks like. Both the orb
 * itself and the rest of the UI's accent colour (see useAccentTheme) read
 * from this, so a button in the Standing panel is always the same colour as
 * the orb it was opened next to — the two used to run off separate palettes
 * (a fixed cool indigo everywhere but the orb), which made every panel look
 * like it belonged to a different app the moment the orb wasn't idle.
 */
/** Shared so the orb and the app-wide accent theme always agree on "what mode is this". */
export function orbModeFor(state: NimbusState, searching = false): OrbMode {
  return searching ? 'searching' : state
}

export const ORB_PALETTE: Record<OrbMode, [core: string, mid: string, rim: string]> = {
  // Warm ember rather than a cool accent: at rest the orb should read as
  // banked rather than working. Deliberately not alarm red - a saturated red
  // on an assistant means "recording" or "broken" to everyone who sees it.
  idle: ['#26100e', '#5c241f', '#ff7a5c'],
  listening: ['#0d1a33', '#1e4c8a', '#7fb2ff'],
  thinking: ['#141029', '#3b2f7a', '#a5aeff'],
  // Thinking's violet pushed toward cyan — reaching outward rather than
  // turning something over internally, the same relationship listening
  // (blue) has to speaking (cyan) but a step further into that green-blue.
  searching: ['#031c22', '#0d5b6e', '#5cf0ff'],
  speaking: ['#08202b', '#136a86', '#63d8f5'],
  playing: ['#0b2418', '#166b4a', '#4ec99a']
}
