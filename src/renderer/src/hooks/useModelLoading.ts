import { useEffect, useState } from 'react'

export interface ModelLoading {
  active: boolean
  /** 0..1, from the weights being read. */
  progress: number
}

/**
 * Whether the on-device model is being read into memory right now.
 *
 * This is not the download — that is a one-off in settings. This is the twelve
 * or so seconds it takes to put a loaded model onto the GPU, which happens on
 * the first question after a cold start or after the idle unload has handed
 * the memory back.
 *
 * It needs saying out loud because the overlay otherwise shows "Thinking…" for
 * the whole of it, which reads as a hang — and if the rest of the turn then
 * ran past the 25-second deadline, the error blamed the network.
 */
export function useModelLoading(): ModelLoading {
  const [state, setState] = useState<ModelLoading>({ active: false, progress: 0 })

  useEffect(() => {
    return window.nimbus.onLocalModelLoading((next) => {
      setState({ active: next.active, progress: next.progress })
    })
  }, [])

  return state
}
