import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import css from './MorphingText.module.css'

/** Props for the two-layer blur/crossfade text effect. */
export interface MorphingTextProps {
  /** Texts shown in order. The first item is rendered immediately. */
  readonly texts: readonly string[]
  /** Time spent morphing between adjacent texts, in seconds. */
  readonly morphTime?: number
  /** Pause after a morph before the next one starts, in seconds. */
  readonly coolDownTime?: number
}

interface MorphState {
  readonly textIndex1: number
  readonly textIndex2: number
  readonly morph: number
  readonly cooldown: number
}

function initialMorphState(length: number, coolDownTime: number): MorphState {
  return {
    textIndex1: 0,
    textIndex2: length > 1 ? 1 : 0,
    morph: 0,
    cooldown: coolDownTime,
  }
}

/**
 * Morph one line into the next with blur, opacity, and a restrained vertical crossfade.
 * @param props - text sequence and timing controls.
 * @returns the animated inline text stack.
 */
export function MorphingText({ texts, morphTime = 2, coolDownTime = 1.3 }: MorphingTextProps): ReactNode {
  const safeTexts = useMemo(() => (texts.length > 0 ? texts : ['']), [texts])
  const [state, setState] = useState<MorphState>(() => initialMorphState(safeTexts.length, coolDownTime))

  useEffect(() => {
    if (safeTexts.length <= 1) {
      setState(initialMorphState(safeTexts.length, coolDownTime))
      return
    }
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setState({ textIndex1: 0, textIndex2: 0, morph: 0, cooldown: Number.POSITIVE_INFINITY })
      return
    }

    let frame = 0
    let last = performance.now()
    let current = initialMorphState(safeTexts.length, coolDownTime)
    const animate = (now: number): void => {
      const delta = Math.min((now - last) / 1000, 0.1)
      last = now
      if (current.cooldown > 0) {
        current = { ...current, cooldown: Math.max(0, current.cooldown - delta) }
      } else {
        const morph = current.morph + delta / Math.max(0.01, morphTime)
        if (morph >= 1) {
          current = {
            textIndex1: current.textIndex2,
            textIndex2: (current.textIndex2 + 1) % safeTexts.length,
            morph: 0,
            cooldown: coolDownTime,
          }
        } else {
          current = { ...current, morph }
        }
      }
      setState(current)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => { cancelAnimationFrame(frame) }
  }, [coolDownTime, morphTime, safeTexts])

  const fraction = Math.min(1, Math.max(0, state.morph))
  const outgoingBlur = fraction * 1.6
  const incomingBlur = (1 - fraction) * 1.6

  return (
    <span
      className={css.root}
      aria-label={safeTexts[0]}
      data-morphing-text="true"
    >
      <span
        className={css.text}
        style={{ filter: `blur(${outgoingBlur}px)`, opacity: 1 - fraction }}
      >
        {safeTexts[state.textIndex1] ?? ''}
      </span>
      <span
        className={css.text}
        style={{ filter: `blur(${incomingBlur}px)`, opacity: fraction }}
        aria-hidden="true"
      >
        {safeTexts[state.textIndex2] ?? ''}
      </span>
    </span>
  )
}
