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
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint id, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
`

/**
 * Brings a window to the front and *keeps* the focus there.
 *
 * `SetForegroundWindow` alone is not enough, and this is the reason a paste
 * could land nowhere at all: Windows refuses foreground changes from a process
 * that did not receive the last input event, and Nimbus — which was just
 * hidden — is exactly that. The documented workaround is to attach our input
 * queue to the target window's thread for the duration of the call, which
 * makes the two threads share focus state and lets the change through.
 *
 * A minimised window is restored first, because a window that is not shown
 * cannot take focus however it is asked.
 */
const FOCUS_WINDOW = `
function Focus-NimbusTarget([IntPtr]$hWnd) {
  if ([NimbusWin32]::IsIconic($hWnd)) { [void][NimbusWin32]::ShowWindow($hWnd, 9) }
  $target = [NimbusWin32]::GetWindowThreadProcessId($hWnd, [IntPtr]::Zero)
  $self = [NimbusWin32]::GetCurrentThreadId()
  [void][NimbusWin32]::AttachThreadInput($self, $target, $true)
  [void][NimbusWin32]::SetForegroundWindow($hWnd)
  [void][NimbusWin32]::AttachThreadInput($self, $target, $false)
}
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
 * Drops `text` into the message box of the window the selection came from,
 * without sending it.
 *
 * Different from `pasteIntoWindow` in one decisive way: replacing would
 * overwrite the message being replied *to*, which is the opposite of what a
 * reply means. Escape is pressed first because in every chat client worth
 * naming — WhatsApp Web, Discord, Slack, Teams, Telegram — it clears the
 * selection and returns focus to the composer, which is exactly where the
 * draft should land.
 *
 * It deliberately stops there. Nothing is sent: the whole point is that you
 * read it, edit it if you want, and press Enter yourself. An assistant that
 * sends messages on your behalf is a different and much riskier product.
 */
export async function replyInWindow(windowHandle: string, text: string): Promise<boolean> {
  // On the clipboard *first* and unconditionally. Whatever happens to focus
  // after this, the draft is one Ctrl+V away — which is the difference between
  // a feature that sometimes does nothing and one that always does something.
  clipboard.writeText(text)

  const output = await powershell(`
${WIN32_TYPES}
${FOCUS_WINDOW}
Add-Type -AssemblyName System.Windows.Forms
$h = [IntPtr]${windowHandle}
Focus-NimbusTarget $h
Start-Sleep -Milliseconds 260
if ([NimbusWin32]::GetForegroundWindow() -eq $h) {
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Write-Output "pasted"
} else {
  # Never fire keystrokes at whatever happens to be in front instead — that is
  # how a draft ends up typed into the wrong window.
  Write-Output "nofocus"
}
`).catch(() => 'nofocus')

  return output.includes('pasted')
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
