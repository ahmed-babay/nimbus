/** Small hex-color helpers, just enough to derive bright/deep accent variants from one base hue. */

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((channel) => clamp255(channel).toString(16).padStart(2, '0')).join('')}`
}

function mix(hex: string, toward: [number, number, number], amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex([
    r + (toward[0] - r) * amount,
    g + (toward[1] - g) * amount,
    b + (toward[2] - b) * amount
  ])
}

export function lighten(hex: string, amount: number): string {
  return mix(hex, [255, 255, 255], amount)
}

export function darken(hex: string, amount: number): string {
  return mix(hex, [0, 0, 0], amount)
}
