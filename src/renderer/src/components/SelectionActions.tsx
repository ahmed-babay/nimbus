import { motion } from 'framer-motion'
import type { TextActionKind } from '@shared/types'

interface SelectionActionsProps {
  text: string
  onRun: (kind: TextActionKind, label: string) => void
}

const ACTIONS: Array<{ kind: TextActionKind; label: string; hint: string }> = [
  { kind: 'grammar', label: 'Fix', hint: 'Correct spelling and grammar' },
  { kind: 'rewrite', label: 'Rewrite', hint: 'Make it clearer and more professional' },
  { kind: 'summarize', label: 'Summarize', hint: 'Condense to three sentences' },
  { kind: 'explain', label: 'Explain', hint: 'Say what it means in plain language' },
  { kind: 'translate', label: 'Translate', hint: 'Translate to English' }
]

/** Action chooser shown after grabbing text from another application. */
export function SelectionActions({ text, onRun }: SelectionActionsProps) {
  return (
    <div>
      <p className="line-clamp-3 text-[12px] leading-relaxed text-nimbus-text-dim">
        &ldquo;{text}&rdquo;
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {ACTIONS.map((action, i) => (
          <motion.button
            key={action.kind}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: i * 0.03 }}
            onClick={() => onRun(action.kind, action.label)}
            title={action.hint}
            className="rounded-lg border border-nimbus-border bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-nimbus-text transition-colors hover:border-nimbus-accent/50 hover:bg-nimbus-accent/15 hover:text-nimbus-accent-bright"
          >
            {action.label}
          </motion.button>
        ))}
      </div>

      <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-nimbus-text-dim">
        {text.length} characters selected
      </p>
    </div>
  )
}
