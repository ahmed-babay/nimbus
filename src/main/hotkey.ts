import { globalShortcut } from 'electron'
import config from '../../config.json'

let registeredAccelerator: string | null = null

/**
 * Registers a systemwide hotkey (default Ctrl+Shift+Space) that opens the
 * overlay. This replaces Porcupine's spoken "Hey Nimbus" wake word —
 * Picovoice discontinued Porcupine's free tier, so a keypress is the free,
 * zero-setup trigger instead. Voice is still used for the actual question
 * once the overlay is open.
 */
export function registerHotkey(onTrigger: () => void): void {
  if (!config.hotkey.enabled) {
    console.log('[hotkey] disabled in config.json')
    return
  }

  const accelerator = config.hotkey.accelerator
  const ok = globalShortcut.register(accelerator, onTrigger)

  if (!ok) {
    console.warn(
      `[hotkey] failed to register "${accelerator}" — it may already be in use by another app. ` +
        'Change hotkey.accelerator in config.json and restart Nimbus. The tray icon still opens Nimbus.'
    )
    return
  }

  registeredAccelerator = accelerator
  console.log(`[hotkey] "${accelerator}" opens Nimbus`)
}

export function unregisterHotkey(): void {
  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator)
    registeredAccelerator = null
  }
}
