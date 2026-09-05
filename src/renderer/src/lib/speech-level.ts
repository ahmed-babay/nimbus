/** Peak-aware lift: quiet recordings gain clarity, loud ones retain headroom. */
export function speechGain(buffer: AudioBuffer, volume = 1): number {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel)
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i])) return 0
      peak = Math.max(peak, Math.abs(samples[i]))
    }
  }
  return Math.min(2.2, peak > 0 ? .85 / peak : 1) * Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1))
}
export function speechVolume(): number {
  try {
    const raw = localStorage.getItem('nimbus.speech-volume')
    if (raw === null) return 1
    const value = Number(raw)
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
  } catch { return 1 }
}
