import { AnimatePresence, motion } from 'framer-motion'
import type { Subtitle } from '@shared/types'

/**
 * Subtitles, where subtitles belong.
 *
 * Deliberately unlike the rest of the app: no arcade glow, no panel, no
 * accent colours. Subtitles sit over someone else's picture, so anything
 * decorative here competes with what they're actually watching. White text on
 * a dark plate, bottom-centred, is the convention for a reason.
 *
 * The bar sits low and stays click-through, so it never blocks the video's own
 * controls.
 */

const LANGUAGE_NAMES: Record<string, string> = {
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  ru: 'Russian',
  ar: 'Arabic',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  'zh-CN': 'Chinese',
  'zh-TW': 'Chinese'
}

export function languageName(code: string): string {
  if (!code) return ''
  return LANGUAGE_NAMES[code] || LANGUAGE_NAMES[code.split('-')[0]] || code.toUpperCase()
}

interface SubtitleBarProps {
  lines: Subtitle[]
  detected: string
  error: string
  onStop: () => void
}

export function SubtitleBar({ lines, detected, error, onStop }: SubtitleBarProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-center gap-2 pb-[7vh]">
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur-sm"
        onMouseEnter={() => window.nimbus.setMouseIgnore(false)}
        onMouseLeave={() => window.nimbus.setMouseIgnore(true)}
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
        </span>
        <span>
          {error
            ? 'Subtitles stopped'
            : detected
              ? `Translating ${languageName(detected)}`
              : 'Listening for speech'}
        </span>
        <button
          onClick={onStop}
          className="ml-1 rounded-full px-2 py-0.5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
        >
          Stop
        </button>
      </div>

      {error && (
        <p className="max-w-[70vw] rounded-lg bg-black/75 px-3 py-1.5 text-center text-[12px] text-red-300">
          {error}
        </p>
      )}

      <div className="flex max-w-[78vw] flex-col items-center gap-1">
        <AnimatePresence initial={false}>
          {lines.map((line) => (
            <motion.p
              key={line.offsetMs}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              // Text shadow as well as a plate: subtitles have to stay legible
              // over a bright frame, and a plate alone doesn't manage it.
              className="rounded-md bg-black/65 px-3 py-1 text-center text-[19px] font-medium leading-snug text-white"
              style={{ textShadow: '0 2px 6px rgba(0,0,0,0.9)' }}
            >
              {line.translated}
            </motion.p>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
