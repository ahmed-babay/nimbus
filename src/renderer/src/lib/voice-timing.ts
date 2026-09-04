/** Count actual speech, so a pause cannot make the detector less patient. */
export function silenceWindowMs(voicedMs: number, configured?: number): number {
  const settled = Number.isFinite(configured)
    ? Math.max(600, Math.min(3000, configured!))
    : 1200
  return voicedMs > 1500 ? settled : Math.max(settled, 1800)
}
