import type { NimbusState } from '@shared/types'

/**
 * One palette per state, for the orb and for everything around it.
 *
 * The orb changes colour with what Nimbus is doing, and until now the panel it
 * sits in did not — so a red idle orb sat on an indigo card, and opening
 * settings gave you a red orb above blue buttons. The state is the single most
 * useful thing the interface conveys at a glance, and having half the window
 * disagree about it undoes that.
 *
 * `orb` is [core, mid, rim], dark to bright, for the sphere itself. `accent`
 * is the same hue family retuned for interface chrome: strong enough to lead
 * the eye, quiet enough to sit under text. Both live here so they cannot
 * drift apart.
 */
export interface StatePalette {
  /** [core, mid, rim] — the sphere, dark to bright. */
  orb: [string, string, string]
  /** Overrides --color-nimbus-accent* so every accented control follows. */
  accent: { base: string; bright: string; deep: string }
}

/**
 * `NimbusState` plus one variant that isn't a state of its own: Nimbus is
 * still "thinking" as far as the rest of the app is concerned while a web
 * search is in flight, but reaching out to the network reads differently
 * from turning an answer over, so the orb (and now the chrome around it)
 * gets its own hue for just that span.
 */
export type OrbMode = NimbusState | 'searching'

/** Shared so the orb and the app-wide accent theme always agree on "what mode is this". */
export function orbModeFor(state: NimbusState, searching = false): OrbMode {
  return searching ? 'searching' : state
}

export const STATE_THEME: Record<OrbMode, StatePalette> = {
  // Warm ember rather than the cool accent: at rest the orb should read as
  // banked rather than working. Deliberately not alarm red — a saturated red
  // on an assistant means "recording" or "broken" to everyone who sees it.
  idle: {
    orb: ['#251b14', '#68503a', '#ffd0a1'],
    accent: { base: '#c5a17c', bright: '#f0d1b0', deep: '#796046' }
  },
  listening: {
    orb: ['#0d1a33', '#1e4c8a', '#7fb2ff'],
    accent: { base: '#5590e2', bright: '#a3c8ff', deep: '#2c5aa0' }
  },
  // Thinking's violet pushed toward cyan — reaching outward rather than
  // turning something over internally, the same relationship listening
  // (blue) has to speaking (cyan) but a step further into that green-blue.
  searching: {
    orb: ['#031c22', '#0d5b6e', '#5cf0ff'],
    accent: { base: '#2bb9c9', bright: '#8ff5ff', deep: '#106572' }
  },
  // The resting indigo of the theme — thinking is the state the default
  // palette was designed around, so it stays exactly as it was.
  thinking: {
    orb: ['#141029', '#3b2f7a', '#a5aeff'],
    accent: { base: '#6e7bff', bright: '#a5aeff', deep: '#4650c8' }
  },
  speaking: {
    orb: ['#08202b', '#136a86', '#63d8f5'],
    accent: { base: '#35a9ca', bright: '#7fe0f7', deep: '#14657f' }
  },
  playing: {
    orb: ['#0b2418', '#166b4a', '#4ec99a'],
    accent: { base: '#43b587', bright: '#7fe0b8', deep: '#18684a' }
  }
}

/**
 * The custom properties to set on the card so accented utilities follow the
 * state. Tailwind compiles `text-nimbus-accent` to `var(--color-nimbus-accent)`,
 * so redefining the variable on an ancestor re-themes every descendant without
 * touching a single component.
 */
export function accentVars(mode: OrbMode): Record<string, string> {
  const { base, bright, deep } = STATE_THEME[mode].accent
  return {
    '--color-nimbus-accent': base,
    '--color-nimbus-accent-bright': bright,
    '--color-nimbus-accent-deep': deep
  }
}
