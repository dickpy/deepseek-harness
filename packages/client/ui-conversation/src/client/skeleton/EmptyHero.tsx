// The composer remains in ConversationRoot so switching out of the blank-draft
// phase does not remount its textarea.

import { useMemo } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  BrandLogo, IconChevronDownOutline14, IconFolderClose16, IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { MorphingText } from './MorphingText.tsx'
import type { ConversationContentProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

const MORPH_TEXT_KEYS = [
  'hero.headline',
  'hero.morph.1',
  'hero.morph.2',
  'hero.morph.3',
  'hero.morph.4',
  'hero.morph.5',
  'hero.morph.6',
] as const

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationContentProps['t']

/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * The workspace chip (folder + label + chevron), always interactive: before
 * the first message the workspace stays switchable — picking another one
 * moves the New Session flow to that workspace's blank session. Without a
 * label the chip renders its placeholder state: closed folder + the
 * "Choose workspace" call to action.
 * @param props.label - chip label (see {@link workspaceLabel}); omitted → placeholder.
 * @param props.menuOpen - menu expansion echo.
 * @param props.onClick - menu toggle.
 * @returns the chip button element.
 */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label?: string | undefined
  menuOpen?: boolean
  onClick?: () => void
  t: HeroTranslate
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label={t('hero.chooseWorkspace')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={onClick}
    >
      {label === undefined
        ? <IconFolderClose16 className={css.folder} size={16} />
        : <IconFolderOpen16 className={css.folder} size={16} />}
      <span className={css.workspaceLabel}>{label ?? t('hero.chooseWorkspace')}</span>
      <IconChevronDownOutline14 className={css.chevron} size={12} />
    </button>
  )
}

/** Hero chrome props. The composer owns the workspace row and card header. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Rendered category tabs staged between the greeting and composer card. */
  catalog?: ReactNode
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/**
 * Render the hero chrome: a bold centered greeting, then the enterprise
 * module catalog slot (大类 tab + 技能 chips, WorkBuddy style). The composer
 * itself stays mounted outside this component, and the example gallery is
 * rendered by {@link ConversationRoot} *below* that composer card.
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
export function HeroShell({ t, catalog, children }: HeroShellProps) {
  const morphTexts = useMemo(() => MORPH_TEXT_KEYS.map(key => t(key)), [t])
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <h1 className={css.headline} data-testid="hero-headline">
          {/* fork: enterprise mark on the left; line-shadow is CSS-only. */}
          <BrandLogo size={40} className={css.brandLogo} />
          <span className={css.headlineText}>
            <MorphingText texts={morphTexts} />
          </span>
          <span className={css.previewBadge}>{t('hero.preview')}</span>
        </h1>
        {catalog}
      </div>
      {children}
    </div>
  )
}
