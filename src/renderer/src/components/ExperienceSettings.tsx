import { setExperienceEnabled, useExperiencePreference } from '../lib/experience-preferences'
import { playCue } from '../lib/chime'
import type { SoundCue } from '../lib/sound-design'

export function ExperienceSettings() {
  const sounds = useExperiencePreference('sounds')
  const acknowledgments = useExperiencePreference('acknowledgments')
  return <section className="experience-settings">
    <p className="experience-eyebrow">Sound & presence</p>
    <label><span><strong>Signature sounds</strong><small>Distinct cues for arrival, capture, interruption and departure.</small></span>
      <input type="checkbox" checked={sounds} onChange={e => setExperienceEnabled('sounds', e.target.checked)} /></label>
    <div className="flex flex-wrap gap-1.5" aria-label="Preview Nimbus sounds">
      {(['open', 'listen', 'received', 'interrupt', 'close'] as SoundCue[]).map(cue => <button key={cue} disabled={!sounds} onClick={() => playCue(cue)} className="rounded-full border border-white/10 px-2.5 py-1.5 text-[10px] capitalize text-nimbus-accent-bright hover:bg-white/5 disabled:opacity-40">{cue}</button>)}
    </div>
    <label><span><strong>Thinking acknowledgment</strong><small>A brief spoken cue for slower answers. Follows voice mute.</small></span>
      <input type="checkbox" checked={acknowledgments} onChange={e => setExperienceEnabled('acknowledgments', e.target.checked)} /></label>
  </section>
}
