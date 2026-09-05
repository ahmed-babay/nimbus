import { useSyncExternalStore } from 'react'

const EVENT = 'nimbus-experience-change'
export type ExperiencePreference = 'sounds' | 'acknowledgments'
export function experienceEnabled(key: ExperiencePreference): boolean {
  try { return localStorage.getItem(`nimbus.${key}`) !== 'off' } catch { return true }
}
export function setExperienceEnabled(key: ExperiencePreference, enabled: boolean): void {
  try { localStorage.setItem(`nimbus.${key}`, enabled ? 'on' : 'off') } catch { /* unavailable storage */ }
  window.dispatchEvent(new Event(EVENT))
}
function subscribe(notify: () => void): () => void {
  window.addEventListener(EVENT, notify)
  window.addEventListener('storage', notify)
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', notify) }
}
export function useExperiencePreference(key: ExperiencePreference): boolean {
  return useSyncExternalStore(subscribe, () => experienceEnabled(key))
}
