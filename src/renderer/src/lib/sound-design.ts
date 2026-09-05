export type SoundCue = 'open' | 'listen' | 'received' | 'interrupt' | 'close'
export interface SoundNote {
  from: number; to: number; at: number; length: number; gain: number; pan: number
}
// One harmonic family, distinct contours. Short tails stay clear of speech.
export const SOUND_SCORE: Record<SoundCue, SoundNote[]> = {
  open: [
    { from: 165, to: 220, at: 0, length: .29, gain: .045, pan: -.2 },
    { from: 330, to: 440, at: .045, length: .27, gain: .026, pan: .2 },
    { from: 659, to: 880, at: .095, length: .23, gain: .012, pan: .35 }
  ],
  listen: [
    { from: 440, to: 494, at: 0, length: .14, gain: .025, pan: -.1 },
    { from: 880, to: 988, at: .025, length: .1, gain: .008, pan: .1 }
  ],
  received: [
    { from: 659, to: 659, at: 0, length: .16, gain: .028, pan: -.18 },
    { from: 988, to: 988, at: .07, length: .19, gain: .019, pan: .18 }
  ],
  interrupt: [
    { from: 330, to: 277, at: 0, length: .12, gain: .033, pan: 0 },
    { from: 165, to: 139, at: 0, length: .15, gain: .023, pan: 0 }
  ],
  close: [
    { from: 440, to: 330, at: 0, length: .2, gain: .028, pan: .2 },
    { from: 330, to: 220, at: .06, length: .21, gain: .024, pan: -.15 },
    { from: 220, to: 165, at: .12, length: .2, gain: .023, pan: 0 }
  ]
}

/** Works with both a live context and OfflineAudioContext for audio QA. */
export function scheduleSound(ctx: BaseAudioContext, cue: SoundCue, offset = 0): void {
  for (const note of SOUND_SCORE[cue]) {
    const start = ctx.currentTime + offset + note.at
    const end = start + note.length
    const tone = ctx.createOscillator()
    const envelope = ctx.createGain()
    const pan = ctx.createStereoPanner()
    tone.type = 'sine'
    tone.frequency.setValueAtTime(note.from, start)
    tone.frequency.exponentialRampToValueAtTime(note.to, end)
    envelope.gain.setValueAtTime(.0001, start)
    envelope.gain.exponentialRampToValueAtTime(note.gain, start + .018)
    envelope.gain.exponentialRampToValueAtTime(.0001, end)
    pan.pan.value = note.pan
    tone.connect(envelope).connect(pan).connect(ctx.destination)
    tone.onended = () => { tone.disconnect(); envelope.disconnect(); pan.disconnect() }
    tone.start(start)
    tone.stop(end + .01)
  }
}
