// Futuristic UI chimes synthesized at runtime via the Web Audio API — no
// audio assets to ship. Each cue is a filtered frequency sweep with a
// detuned harmonic layer and a short feedback delay, which reads as
// "sci-fi interface" rather than the plain beeps we started with.

let sharedCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext()
  }
  // A global hotkey isn't a user gesture, so the context can start suspended.
  if (sharedCtx.state === 'suspended') void sharedCtx.resume().catch(() => {})
  return sharedCtx
}

interface SweepOptions {
  fromHz: number
  toHz: number
  durationMs: number
  filterFromHz: number
  filterToHz: number
  peakGain?: number
}

function sweep({
  fromHz,
  toHz,
  durationMs,
  filterFromHz,
  filterToHz,
  peakGain = 0.16
}: SweepOptions): void {
  const ctx = getCtx()
  const now = ctx.currentTime
  const duration = durationMs / 1000

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 6
  filter.frequency.setValueAtTime(filterFromHz, now)
  filter.frequency.exponentialRampToValueAtTime(filterToHz, now + duration)

  const envelope = ctx.createGain()
  envelope.gain.setValueAtTime(0.0001, now)
  envelope.gain.exponentialRampToValueAtTime(peakGain, now + duration * 0.18)
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration)

  // Short feedback delay gives the cue a sense of space without needing an
  // impulse response.
  const delay = ctx.createDelay()
  delay.delayTime.value = 0.075
  const feedback = ctx.createGain()
  feedback.gain.value = 0.22
  const wet = ctx.createGain()
  wet.gain.value = 0.5

  filter.connect(envelope)
  envelope.connect(ctx.destination)
  envelope.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(wet)
  wet.connect(ctx.destination)

  // Main tone plus a detuned octave layer for a synthetic, non-beepy timbre.
  const layers: Array<{ type: OscillatorType; ratio: number; detune: number; gain: number }> = [
    { type: 'sine', ratio: 1, detune: 0, gain: 1 },
    { type: 'triangle', ratio: 2, detune: 6, gain: 0.35 }
  ]

  layers.forEach((layer) => {
    const osc = ctx.createOscillator()
    osc.type = layer.type
    osc.detune.value = layer.detune
    osc.frequency.setValueAtTime(fromHz * layer.ratio, now)
    osc.frequency.exponentialRampToValueAtTime(toHz * layer.ratio, now + duration)

    const layerGain = ctx.createGain()
    layerGain.gain.value = layer.gain

    osc.connect(layerGain)
    layerGain.connect(filter)
    osc.start(now)
    osc.stop(now + duration + 0.25)
  })
}

/**
 * Rising sweep with a shimmer on top — a hextech core spinning up. Two
 * layers an octave-and-a-fifth apart give it a crystalline ring rather than
 * the plain electronic blip of a single sweep.
 */
export function playListenStartChime(): void {
  sweep({
    fromHz: 392,
    toHz: 1174,
    durationMs: 210,
    filterFromHz: 600,
    filterToHz: 7600
  })
  // Delayed harmonic, so the cue blooms instead of arriving all at once.
  setTimeout(
    () =>
      sweep({
        fromHz: 1174,
        toHz: 1568,
        durationMs: 240,
        filterFromHz: 3000,
        filterToHz: 9000,
        peakGain: 0.07
      }),
    70
  )
}

/** Falling sweep — the core powering back down. */
export function playListenEndChime(): void {
  sweep({
    fromHz: 988,
    toHz: 330,
    durationMs: 260,
    filterFromHz: 6500,
    filterToHz: 520,
    peakGain: 0.12
  })
}
