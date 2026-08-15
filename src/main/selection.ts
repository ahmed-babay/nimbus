import { execFile } from 'child_process'
import { promisify } from 'util'
import { clipboard } from 'electron'

const run = promisify(execFile)

// PowerShell arguments are passed base64-encoded (UTF-16LE, as -EncodedCommand
// expects) so no amount of quoting or special characters in the script can
// break the invocation.
function encode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)],
    { windowsHide: true, timeout: 5000 }
  )
  return stdout.trim()
}

const WIN32_TYPES = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NimbusWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
`

export interface CapturedSelection {
  text: string
  /** Foreground window handle, so the result can be pasted back into it. */
  windowHandle: string
}

/**
 * Reads the highlighted text out of whatever app currently has focus.
 *
 * There's no API to read another application's selection, so this does what a
 * user would: sends Ctrl+C to the focused window and reads the clipboard. The
 * previous clipboard contents are saved and restored afterwards, so using
 * Nimbus never costs the user whatever they had copied.
 */
export async function captureSelection(): Promise<CapturedSelection> {
  const previous = clipboard.readText()
  // A sentinel makes it possible to tell "nothing was selected" (clipboard
  // unchanged) apart from "the selection happens to equal the old clipboard".
  const sentinel = `__nimbus_${Date.now()}__`
  clipboard.writeText(sentinel)

  const script = `
${WIN32_TYPES}
Add-Type -AssemblyName System.Windows.Forms
$hwnd = [NimbusWin32]::GetForegroundWindow()
[System.Windows.Forms.SendKeys]::SendWait("^c")
Start-Sleep -Milliseconds 180
Write-Output $hwnd
`

  let windowHandle = '0'
  try {
    windowHandle = (await powershell(script)).split(/\r?\n/)[0]?.trim() || '0'
  } catch {
    clipboard.writeText(previous)
    throw new Error("I couldn't read the selected text.")
  }

  const copied = clipboard.readText()
  // Restore what the user had before we borrowed the clipboard.
  clipboard.writeText(previous)

  if (!copied || copied === sentinel) {
    throw new Error('Select some text first, then press the shortcut.')
  }

  return { text: copied.trim(), windowHandle }
}

/**
 * Puts `text` back into the window the selection came from, replacing what is
 * still highlighted there. Focus is restored explicitly because showing the
 * overlay takes it away.
 */
export async function pasteIntoWindow(windowHandle: string, text: string): Promise<void> {
  clipboard.writeText(text)

  await powershell(`
${WIN32_TYPES}
Add-Type -AssemblyName System.Windows.Forms
[void][NimbusWin32]::SetForegroundWindow([IntPtr]${windowHandle})
Start-Sleep -Milliseconds 140
[System.Windows.Forms.SendKeys]::SendWait("^v")
`)
}
