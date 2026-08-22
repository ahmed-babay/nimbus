import { execFile } from 'node:child_process'
import { httpFetch } from './http'

/**
 * Where this machine actually is, asked of Windows.
 *
 * Everything here used to start from an address in config.json, which is fine
 * for the person who wrote it and wrong for everyone else — the installer
 * carries that file, so a copy handed to a colleague plans their trains from
 * someone else's station. IP geolocation is the usual substitute and is not
 * good enough: measured on this connection it reported Frankfurt am Main and
 * Stromberg, 30km and 90km from the machine asking. That is the difference
 * between the right train and the wrong city.
 *
 * Windows already knows, to a much better standard. Its location service uses
 * nearby WiFi networks and returned this machine's position to within 82
 * metres, free, with no account and no API key. It needs the location
 * permission to be granted, which is a switch the user controls and can see.
 *
 * Reached through PowerShell because the API is WinRT, which Node cannot call
 * directly. The script is passed base64-encoded rather than as a command line:
 * quoting a multi-line PowerShell script through a process argument is a
 * reliable source of breakage, and -EncodedCommand sidesteps all of it.
 */

export interface DeviceFix {
  lat: number
  lon: number
  /** Radius in metres the OS believes this is good to. */
  accuracy: number
  /** "WiFi", "Cellular", "Satellite" — mainly useful in logs. */
  source: string
}

/**
 * How long a fix is reused. Long enough that asking three questions in a row
 * doesn't spawn three PowerShell processes, short enough to follow someone
 * who has moved between buildings.
 */
const FIX_TTL_MS = 10 * 60 * 1000

/** A WiFi fix is usually well under a second; a cold location service is not. */
const FIX_TIMEOUT_MS = 20_000

/**
 * Beyond this the fix is too vague to be worth preferring over a configured
 * address. Windows reports a kilometres-wide radius when it is falling back to
 * its own IP lookup, which is the thing this exists to avoid.
 */
const MAX_USEFUL_ACCURACY_M = 5_000

const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Devices.Geolocation.Geolocator,Windows.Devices.Geolocation,ContentType=WindowsRuntime]
  $null = [Windows.Devices.Geolocation.Geoposition,Windows.Devices.Geolocation,ContentType=WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  $geo = New-Object Windows.Devices.Geolocation.Geolocator
  $geo.DesiredAccuracyInMeters = 100
  $task = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($geo.GetGeopositionAsync()))
  if ($task.Wait(15000)) {
    $c = $task.Result.Coordinate
    $out = @{
      lat = $c.Point.Position.Latitude
      lon = $c.Point.Position.Longitude
      accuracy = $c.Accuracy
      source = [string]$c.PositionSource
    }
    Write-Output ($out | ConvertTo-Json -Compress)
  }
} catch { }
`

let cached: { fix: DeviceFix; at: number } | null = null
let inFlight: Promise<DeviceFix | null> | null = null

function runScript(): Promise<DeviceFix | null> {
  return new Promise((resolve) => {
    // UTF-16LE base64 is what -EncodedCommand expects.
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: FIX_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null)
        try {
          const parsed = JSON.parse(stdout.trim()) as Partial<DeviceFix>
          if (typeof parsed.lat !== 'number' || typeof parsed.lon !== 'number') {
            return resolve(null)
          }
          resolve({
            lat: parsed.lat,
            lon: parsed.lon,
            accuracy: typeof parsed.accuracy === 'number' ? parsed.accuracy : Number.NaN,
            source: parsed.source ?? 'unknown'
          })
        } catch {
          // No output means the permission is off or no fix was available.
          resolve(null)
        }
      }
    )
  })
}

/**
 * The device's position, or null when Windows can't or won't say.
 *
 * Null is a perfectly ordinary answer — location permission is off, it is a
 * desktop with no WiFi radio, the service is disabled — so every caller
 * treats it as "fall back to what was configured" rather than an error.
 */
export async function deviceLocation(): Promise<DeviceFix | null> {
  if (process.platform !== 'win32') return null
  if (cached && Date.now() - cached.at < FIX_TTL_MS) return cached.fix
  if (inFlight) return inFlight

  inFlight = (async () => {
    const started = Date.now()
    const fix = await runScript()
    if (!fix) {
      console.log('[location] Windows gave no fix; falling back to the configured place')
      return null
    }
    if (Number.isFinite(fix.accuracy) && fix.accuracy > MAX_USEFUL_ACCURACY_M) {
      console.log(`[location] fix too vague (${Math.round(fix.accuracy)}m); ignoring it`)
      return null
    }
    console.log(
      `[location] ${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)} +/-${Math.round(fix.accuracy)}m via ${fix.source} (${Date.now() - started}ms)`
    )
    cached = { fix, at: Date.now() }
    return fix
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

interface ReverseResult {
  address?: Record<string, string>
  display_name?: string
}

/**
 * A name for a set of coordinates, so Nimbus can say "Darmstadt" rather than
 * reading out a latitude. Failure is fine — the coordinates still work for
 * every lookup; only the wording suffers.
 */
export async function describeFix(fix: DeviceFix): Promise<string | null> {
  try {
    const res = await httpFetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${fix.lat}&lon=${fix.lon}&format=json&zoom=14`,
      {
        // Nominatim's usage policy requires callers to identify themselves and
        // it refuses anonymous requests, which is why this quietly returned
        // nothing the first time.
        headers: { 'User-Agent': 'NimbusAssistant/0.1 (personal desktop assistant)' },
        label: 'Nominatim',
        timeoutMs: 8000,
        retries: 1
      }
    )
    if (!res.ok) return null
    const json = (await res.json()) as ReverseResult
    const address = json.address ?? {}
    return (
      address.city ??
      address.town ??
      address.village ??
      address.suburb ??
      address.county ??
      json.display_name?.split(',')[0] ??
      null
    )
  } catch {
    return null
  }
}

/** Drops the cached fix, so the next question re-asks Windows. */
export function forgetDeviceLocation(): void {
  cached = null
}

/**
 * Whether the user is asking where they are.
 *
 * Worth answering deterministically rather than letting the model do it. Asked
 * "do you know my location", it answered from the conversation instead — the
 * user had once looked up a train from Mainz, so it decided they lived there.
 * Inferring where somebody lives from a place they once asked about is the
 * kind of confident wrongness that makes an assistant untrustworthy about
 * everything else.
 */
export function asksWhereTheyAre(utterance: string): boolean {
  return /\b(where am i|where i am|where we are|my location|my position|where do i live|wo bin ich|mein standort)\b/i.test(
    utterance
  )
}

/** A spoken answer to "where am I", straight from the device. */
export async function describeWhereYouAre(): Promise<string> {
  const fix = await deviceLocation()
  if (!fix) {
    return (
      "I can't tell where you are — Windows location is switched off for Nimbus. " +
      'You can turn it on in Windows Settings under Privacy and security, Location.'
    )
  }
  const name = await describeFix(fix)
  const precision = Number.isFinite(fix.accuracy) ? ` to within about ${Math.round(fix.accuracy)} metres` : ''
  return name
    ? `You're in ${name}${precision}, according to your device.`
    : `You're at ${fix.lat.toFixed(3)}, ${fix.lon.toFixed(3)}${precision}.`
}

/**
 * Whether the user said the journey starts where they are.
 *
 * Needed because the router fills in a starting station from context when it
 * has none, and a guess beats the real answer: asked to check transport "from
 * my place", it supplied Darmstadt Hauptbahnhof and the device was never
 * consulted. When someone says "from here" they mean here, and no amount of
 * conversational context should be allowed to override that.
 */
export function meansFromHere(utterance: string): boolean {
  return /\bfrom (here|my (place|location|position|home|house|flat|apartment|side)|where i (am|live)|my current (location|position))\b|\bvon (hier|mir|meinem (ort|standort|zuhause))\b/i.test(
    utterance
  )
}
