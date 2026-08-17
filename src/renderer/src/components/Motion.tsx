import { motion, useInView, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Shared motion primitives.
 *
 * Every card animating in its own way looks like several apps stacked on top
 * of each other, so the vocabulary is defined once here and reused: numbers
 * count, lists stagger, bars fill, and everything uses the same easing curve
 * the overlay itself opens with.
 *
 * The rule applied throughout: **motion carries meaning or it doesn't ship.**
 * A number counts up because the magnitude is the point. A list staggers
 * because the order is the point. Nothing spins for decoration — this is a
 * panel someone sees twenty times a day, and ornament becomes irritation fast.
 */

/** The overlay's own entrance curve; reused so cards feel part of it. */
export const EASE = [0.22, 1, 0.36, 1] as const

/**
 * A number that counts to its value.
 *
 * Spring rather than linear, because a price settling is the readable
 * behaviour — it overshoots slightly and lands, which reads as "this arrived"
 * rather than "this is still loading".
 */
export function CountUp({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  className = ''
}: {
  value: number
  decimals?: number
  prefix?: string
  suffix?: string
  className?: string
}) {
  const motionValue = useMotionValue(0)
  const spring = useSpring(motionValue, { stiffness: 90, damping: 18, mass: 0.6 })
  const text = useTransform(spring, (latest) => {
    const shown = latest.toFixed(decimals)
    // Large counts are unreadable without separators, and a price never wants
    // them — decimals is the honest signal for which is which.
    const grouped = decimals === 0 ? Number(shown).toLocaleString() : shown
    return `${prefix}${grouped}${suffix}`
  })

  useEffect(() => {
    motionValue.set(value)
  }, [value, motionValue])

  return <motion.span className={className}>{text}</motion.span>
}

/**
 * Reveals children one after another.
 *
 * Held back until the element is actually on screen: a card can be scrolled
 * past the fold, and a list that finished animating before it was visible is
 * a list that never animated at all.
 */
export function Stagger({
  children,
  gap = 0.055,
  className = ''
}: {
  children: ReactNode
  gap?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-20px' })

  return (
    <motion.div
      ref={ref}
      className={className}
      initial="hidden"
      animate={inView ? 'shown' : 'hidden'}
      variants={{ shown: { transition: { staggerChildren: gap } }, hidden: {} }}
    >
      {children}
    </motion.div>
  )
}

/** One row inside a `Stagger`. */
export function StaggerItem({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 6 },
        shown: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } }
      }}
    >
      {children}
    </motion.div>
  )
}

/**
 * A bar that fills to a fraction.
 *
 * Used anywhere a value has a known ceiling — quota used, how far through a
 * journey, how strong a factor is. Filling from zero is what makes "nearly
 * full" register before the number is read.
 */
export function FillBar({
  fraction,
  className = 'bg-nimbus-accent',
  track = 'bg-white/10',
  height = 'h-1',
  delay = 0
}: {
  fraction: number
  className?: string
  track?: string
  height?: string
  delay?: number
}) {
  const clamped = Math.max(0, Math.min(1, fraction))
  return (
    <div className={`${height} w-full overflow-hidden rounded-full ${track}`}>
      <motion.div
        className={`h-full rounded-full ${className}`}
        initial={{ width: 0 }}
        animate={{ width: `${clamped * 100}%` }}
        transition={{ duration: 0.65, ease: EASE, delay }}
      />
    </div>
  )
}

/**
 * A slow pulse, for something genuinely live.
 *
 * Deliberately not offered as a general highlight: if everything pulses, the
 * one thing that is actually updating stops standing out.
 */
export function LivePulse({ label = 'live' }: { label?: string }) {
  return (
    <span className="flex items-center gap-1 text-[9px] text-nimbus-positive">
      <motion.span
        className="h-1.5 w-1.5 rounded-full bg-nimbus-positive"
        animate={{ opacity: [1, 0.25, 1] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
      />
      {label}
    </span>
  )
}

/**
 * Counts down to a moment, re-rendering every second.
 *
 * The whole value of a departure card is the number you act on — "in 6 min" —
 * and a number that was true when the card opened is worth less every second
 * it stays on screen.
 */
export function Countdown({ to, className = '' }: { to: string; className?: string }) {
  const target = new Date(to).getTime()
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (Number.isNaN(target)) return

    const render = (): void => {
      if (!ref.current) return
      const diff = target - Date.now()
      const minutes = Math.round(diff / 60000)
      ref.current.textContent =
        diff <= 0
          ? 'now'
          : minutes < 1
            ? 'under a minute'
            : minutes < 60
              ? `in ${minutes} min`
              : `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
    }

    render()
    const timer = setInterval(render, 1000)
    return () => clearInterval(timer)
  }, [target])

  if (Number.isNaN(target)) return null
  return <span ref={ref} className={className} />
}
