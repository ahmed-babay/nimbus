/**
 * Web Mercator, shared by the process that fetches tiles and the one that
 * draws them.
 *
 * It lives here because an interactive map needs both sides to agree exactly.
 * The main process decides which tiles to download; the renderer decides where
 * to put them and where a route falls on top. If those two disagree by even a
 * pixel the route drifts off the road as you pan, and the drift grows with
 * zoom. One implementation, imported twice.
 */

export const TILE_SIZE = 256

/** Nothing useful is visible outside these, and OSM will not serve past 19. */
export const MIN_ZOOM = 3
export const MAX_ZOOM = 18

/** Longitude to a pixel on the whole-world plane at this zoom. */
export function worldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom
}

/** Latitude to a pixel on the whole-world plane at this zoom. */
export function worldY(lat: number, zoom: number): number {
  const sin = Math.sin((lat * Math.PI) / 180)
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  return y * TILE_SIZE * 2 ** zoom
}

/** The inverse, for turning a drag back into a place. */
export function lonAt(x: number, zoom: number): number {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180
}

export function latAt(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** zoom)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

/** Which tiles cover a viewport, as world-plane pixel offsets. */
export function tilesCovering(
  left: number,
  top: number,
  width: number,
  height: number,
  zoom: number
): Array<{ col: number; row: number; wrapped: number; x: number; y: number }> {
  const scale = 2 ** zoom
  const out: Array<{ col: number; row: number; wrapped: number; x: number; y: number }> = []

  for (let row = Math.floor(top / TILE_SIZE); row <= Math.floor((top + height) / TILE_SIZE); row++) {
    // Above the north edge or below the south edge there is no tile at all.
    if (row < 0 || row >= scale) continue
    for (
      let col = Math.floor(left / TILE_SIZE);
      col <= Math.floor((left + width) / TILE_SIZE);
      col++
    ) {
      // Longitude wraps, so a viewport crossing the date line still resolves.
      const wrapped = ((col % scale) + scale) % scale
      out.push({
        col,
        row,
        wrapped,
        x: col * TILE_SIZE - left,
        y: row * TILE_SIZE - top
      })
    }
  }
  return out
}
