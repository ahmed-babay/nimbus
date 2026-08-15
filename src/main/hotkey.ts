import { globalShortcut } from 'electron'
import config from '../../config.json'

const registered: string[] = []

/**
 * Registers a systemwide hotkey (default Ctrl+Shift+Space) that opens the
 * overlay. This replaces Porcupine's spoken "Hey Nimbus" wake word —
 * Picovoice discontinued Porcupine's free tier, so a keypress is the free,
 * zero-setup trigger instead. Voice is still used for the actual question
 * once the overlay is open.
 */
function register(accelerator: string, label: string, handler: () => void): void {
  if (!accelerator) return

  if (!globalShortcut.register(accelerator, handler)) {
    console.warn(
      `[hotkey] failed to register "${accelerator}" — it may already be in use by another app. ` +
        'Change it in config.json and restart Nimbus. The tray icon still opens Nimbus.'
    )
    return
  }

  registered.push(accelerator)
  console.log(`[hotkey] "${accelerator}" ${label}`)
}

export function registerHotkey(onTrigger: () => void, onCapture?: () => void): void {
  if (!config.hotkey.enabled) {
    console.log('[hotkey] disabled in config.json')
    return
  }

  register(config.hotkey.accelerator, 'opens Nimbus', onTrigger)
  if (onCapture) {
    register(config.hotkey.captureAccelerator, 'captures the screen', onCapture)
  }
}

export function unregisterHotkey(): void {
  registered.forEach((accelerator) => globalShortcut.unregister(accelerator))
  registered.length = 0
}
