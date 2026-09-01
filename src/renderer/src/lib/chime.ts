// Small UI sounds synthesized at runtime, so Nimbus does not need to ship or
// decode audio assets. Each cue is one soft spectral gesture rather than a
// sequence of notes: restrained enough for frequent voice use, but still
// distinct from the system's notification sounds.

let sharedCtx: AudioContext | null = null
let suppressListenStartUntil = 0

function getCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext()
  }
  // A global hotkey is not a browser user gesture, so the context may begin
  // suspended even though the user deliberately invoked Nimbus.
  if (sharedCtx.state === 'suspended') void sharedCtx.resume().catch(() => {})
  return sharedCtx
}

interface PartialOptions {
  fromHz: number
  toHz: number
  durationMs: number
  gain: number
  pan: number
  startOffsetMs?: number
  attackMs?: number
}

function partial({
  fromHz,
  toHz,
  durationMs,
  gain,
  pan,
  startOffsetMs = 0,
  attackMs = 42
}: PartialOptions): void {
  const ctx = getCtx()
  const start = ctx.currentTime + startOffsetMs / 1000
  const end = start + durationMs / 1000

  const oscillator = ctx.createOscillator()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(fromHz, start)
  oscillator.frequency.exponentialRampToValueAtTime(toHz, end)

  const envelope = ctx.createGain()
  envelope.gain.setValueAtTime(0.0001, start)
  envelope.gain.linearRampToValueAtTime(gain, start + attackMs / 1000)
  envelope.gain.exponentialRampToValueAtTime(0.0001, end)

  const position = ctx.createStereoPanner()
  position.pan.setValueAtTime(pan, start)

  oscillator.connect(envelope)
  envelope.connect(position)
  position.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(end + 0.02)
}

interface AirOptions {
  fromHz: number
  toHz: number
  durationMs: number
  gain: number
  startOffsetMs?: number
}

/** A nearly subliminal filtered breath keeps the cue from sounding like a bell. */
function air({ fromHz, toHz, durationMs, gain, startOffsetMs = 0 }: AirOptions): void {
  const ctx = getCtx()
  const duration = durationMs / 1000
  const start = ctx.currentTime + startOffsetMs / 1000
  const end = start + duration
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate)
  const samples = buffer.getChannelData(0)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.random() * 2 - 1
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.setValueAtTime(0.75, start)
  filter.frequency.setValueAtTime(fromHz, start)
  filter.frequency.exponentialRampToValueAtTime(toHz, end)

  const envelope = ctx.createGain()
  envelope.gain.setValueAtTime(0.0001, start)
  envelope.gain.linearRampToValueAtTime(gain, start + Math.min(0.05, duration * 0.22))
  envelope.gain.exponentialRampToValueAtTime(0.0001, end)

  source.connect(filter)
  filter.connect(envelope)
  envelope.connect(ctx.destination)
  source.start(start)
  source.stop(end + 0.01)
}

/**
 * A compact, upward spectral bloom that follows the orb's expansion. The
 * partials begin together, so it is perceived as one material rather than a
 * startup melody. It also replaces the first listening cue to avoid stacking
 * two sounds while the microphone is opening.
 */
export function playOpenChime(): void {
  suppressListenStartUntil = Date.now() + 2000
  partial({ fromHz: 196, toHz: 220, durationMs: 410, gain: 0.017, pan: -0.14 })
  partial({ fromHz: 392, toHz: 440, durationMs: 350, gain: 0.007, pan: 0.16, startOffsetMs: 12 })
  partial({ fromHz: 784, toHz: 880, durationMs: 260, gain: 0.0025, pan: 0.3, startOffsetMs: 24 })
  air({ fromHz: 1450, toHz: 2300, durationMs: 300, gain: 0.0024, startOffsetMs: 18 })
}

/** The same material folding inward into a short, calm finish. */
export function playCloseChime(): void {
  partial({ fromHz: 220, toHz: 190, durationMs: 310, gain: 0.015, pan: 0.12, attackMs: 24 })
  partial({ fromHz: 440, toHz: 380, durationMs: 260, gain: 0.006, pan: -0.14, attackMs: 20 })
  partial({ fromHz: 880, toHz: 760, durationMs: 190, gain: 0.002, pan: -0.28, attackMs: 16 })
  air({ fromHz: 2200, toHz: 1250, durationMs: 240, gain: 0.0018 })
}

/** A minimal confirmation for later listening turns. */
export function playListenStartChime(): void {
  if (Date.now() < suppressListenStartUntil) {
    suppressListenStartUntil = 0
    return
  }
  partial({ fromHz: 330, toHz: 366, durationMs: 170, gain: 0.011, pan: -0.08, attackMs: 18 })
  partial({ fromHz: 660, toHz: 732, durationMs: 145, gain: 0.0035, pan: 0.1, attackMs: 16 })
}

/** A softer downward confirmation when capture has completed. */
export function playListenEndChime(): void {
  partial({ fromHz: 366, toHz: 330, durationMs: 155, gain: 0.008, pan: 0.08, attackMs: 14 })
  partial({ fromHz: 732, toHz: 660, durationMs: 130, gain: 0.0025, pan: -0.1, attackMs: 12 })
}
