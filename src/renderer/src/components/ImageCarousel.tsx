import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

interface ImageCarouselProps {
  images: string[]
  className?: string
  intervalMs?: number
}

/**
 * Cross-fading image strip. Auto-advances when there's more than one image so
 * a topic gets a sense of motion rather than a single arbitrary still, and
 * collapses to a plain image when there's only one.
 */
export function ImageCarousel({ images, className = '', intervalMs = 3600 }: ImageCarouselProps) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (images.length < 2) return
    const timer = setInterval(() => setIndex((i) => (i + 1) % images.length), intervalMs)
    return () => clearInterval(timer)
  }, [images.length, intervalMs])

  if (images.length === 0) return null

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.img
          key={index}
          src={images[index]}
          alt=""
          initial={{ opacity: 0, scale: 1.06 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.02 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </AnimatePresence>

      {/* Gentle bottom fade so overlaid text stays readable on any image. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />

      {images.length > 1 && (
        <div className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 gap-1">
          {images.map((_, i) => (
            <span
              key={i}
              className={`h-1 rounded-full transition-all duration-300 ${
                i === index ? 'w-4 bg-nimbus-accent' : 'w-1 bg-white/40'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
