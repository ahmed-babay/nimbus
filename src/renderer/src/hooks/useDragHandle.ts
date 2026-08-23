import { useCallback, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * Makes an element drag the whole overlay window.
 *
 * `-webkit-app-region: drag` is the usual way and does not work here. This
 * window is transparent and click-through, and `setIgnoreMouseEvents` hides it
 * from input at the OS level, so Chromium's drag region is never reached — the
 * header simply did nothing. Moving the window from the renderer sidesteps all
 * of that.
 *
 * Screen coordinates, not client ones: the window moves out from under the
 * pointer as you drag, so anything measured relative to the window would fight
 * itself. `screenX`/`screenY` are absolute, so each delta is exactly how far
 * the mouse actually travelled.
 *
 * Pointer capture keeps the drag alive when the cursor outruns the card, which
 * it will — the window is chasing the mouse, not leading it.
 */
export interface DragHandle {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  style: CSSProperties
}

export function useDragHandle(onDragChange?: (dragging: boolean) => void): DragHandle {
  const last = useRef<{ x: number; y: number } | null>(null)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Left button only, and never when the press started on something
      // interactive — a click on Close must close, not begin a move.
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return

      const element = event.currentTarget
      last.current = { x: event.screenX, y: event.screenY }
      element.setPointerCapture(event.pointerId)
      onDragChange?.(true)

      const move = (moveEvent: PointerEvent): void => {
        if (!last.current) return
        const dx = moveEvent.screenX - last.current.x
        const dy = moveEvent.screenY - last.current.y
        // A pointer event without usable screen coordinates produces NaN here,
        // and the main process cannot turn NaN into a window position — it
        // throws out of the IPC handler, where nothing catches it. Dropping
        // the frame is the whole cost of not doing that.
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
        if (dx === 0 && dy === 0) return
        last.current = { x: moveEvent.screenX, y: moveEvent.screenY }
        window.nimbus.moveOverlay(dx, dy)
      }

      const stop = (): void => {
        last.current = null
        element.releasePointerCapture(event.pointerId)
        element.removeEventListener('pointermove', move)
        element.removeEventListener('pointerup', stop)
        element.removeEventListener('pointercancel', stop)
        onDragChange?.(false)
      }

      element.addEventListener('pointermove', move)
      element.addEventListener('pointerup', stop)
      element.addEventListener('pointercancel', stop)
    },
    [onDragChange]
  )

  return { onPointerDown, style: { cursor: 'grab' } }
}
