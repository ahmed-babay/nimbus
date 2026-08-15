import { useEffect, useRef, useState } from 'react'

interface Point {
  x: number
  y: number
}

/**
 * Drag-to-select over a frozen screenshot of the display.
 *
 * The image behind is the capture itself, so the selection maps 1:1 onto what
 * will be cropped. Coordinates are reported as fractions of the image rather
 * than pixels, so the main process doesn't need to know how the picker was
 * scaled or which display it ran on.
 */
export function RegionPicker() {
  const [image, setImage] = useState<string | null>(null)
  const [origin, setOrigin] = useState<Point | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => window.nimbus.onRegionImage(setImage), [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        window.nimbus.sendRegion(null)
      }
      // Enter takes the whole screen — the previous behaviour, still one key
      // away for when the full display is what's wanted.
      if (event.key === 'Enter') {
        window.nimbus.sendRegion('full')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rect =
    origin && cursor
      ? {
          left: Math.min(origin.x, cursor.x),
          top: Math.min(origin.y, cursor.y),
          width: Math.abs(cursor.x - origin.x),
          height: Math.abs(cursor.y - origin.y)
        }
      : null

  function toFraction(event: React.MouseEvent): Point {
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!bounds) return { x: 0, y: 0 }
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative h-screen w-screen cursor-crosshair overflow-hidden select-none"
      onMouseDown={(event) => {
        const point = toFraction(event)
        setOrigin(point)
        setCursor(point)
      }}
      onMouseMove={(event) => {
        if (origin) setCursor(toFraction(event))
      }}
      onMouseUp={() => {
        if (!rect) return
        // A stray click rather than a drag — treat as "no selection" so the
        // whole screen is used, instead of cropping to a few pixels.
        if (rect.width < 0.01 || rect.height < 0.01) {
          window.nimbus.sendRegion('full')
          return
        }
        window.nimbus.sendRegion({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        })
      }}
    >
      {image && (
        <img src={image} alt="" className="absolute inset-0 h-full w-full" draggable={false} />
      )}

      {/* Dim everything, then punch the selection back to full brightness */}
      <div className="absolute inset-0 bg-black/55" />
      {rect && (
        <>
          <div
            className="absolute overflow-hidden"
            style={{
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`
            }}
          >
            {image && (
              <img
                src={image}
                alt=""
                draggable={false}
                className="absolute max-w-none"
                style={{
                  width: `${100 / rect.width}%`,
                  height: `${100 / rect.height}%`,
                  left: `${(-rect.left / rect.width) * 100}%`,
                  top: `${(-rect.top / rect.height) * 100}%`
                }}
              />
            )}
          </div>
          <div
            className="pointer-events-none absolute border-2"
            style={{
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              borderColor: 'var(--color-nimbus-accent)',
              boxShadow: '0 0 18px rgba(255,62,165,0.65)'
            }}
          />
        </>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-8 flex justify-center">
        <div
          className="arcade-type rounded-lg border-2 px-4 py-2 text-[11px]"
          style={{
            borderColor: 'var(--color-nimbus-accent)',
            background: 'rgba(9,6,18,0.9)',
            color: 'var(--color-nimbus-text)',
            boxShadow: '0 0 24px rgba(255,62,165,0.45)'
          }}
        >
          Drag to select · Enter = whole screen · Esc = cancel
        </div>
      </div>
    </div>
  )
}
