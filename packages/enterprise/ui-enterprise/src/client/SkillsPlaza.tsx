import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { EnterpriseBadgeState, EnterpriseSkill } from './enterprise-store.ts'
import { NS } from './locales.ts'
import css from './SkillsPlaza.module.css'

/** 技能广场的注入面：hooks.home 绑定企业设置节，useSkill 带技能开新对话。 */
export interface SkillsPlazaInjected {
  hooks: {
    home: ObservableSnapshot<EnterpriseBadgeState>
  }
  /**
   * 带着某个技能开一段新对话：把 `/技能名` 填进新会话的输入框（不自动发送）。
   * @param skill - 技能标识（SKILL.md frontmatter 的 name）。
   */
  useSkill: (skill: string) => void
}

export type SkillsPlazaProps =
  & PropsLocale<typeof NS>
  & InjectFace<SkillsPlazaInjected>

/** 技能包形态的中文说明（卡片元信息用） */
function kindLabel(skill: EnterpriseSkill, bundleLabel: (count: string) => string): string {
  return skill.kind !== 'bundle' ? '单文件技能' : bundleLabel(String(skill.fileCount))
}

/**
 * 技能广场（主区域面板）：管理台「技能广场」里已发布、且对当前用户角色可见的
 * 技能清单，卡片式展示。
 *
 * 数据来自 `dsh-enterprise` 设置节的 skills 字段——host 插件每次同步企业配置时
 * 写入，所以这里不需要自己扫本机 skills 目录，也不会出现「管理台有、桌面端没有」
 * 的偏差。卡片上的「试一试」是主操作：带着 `/技能名` 开一段新对话，
 * 用户补充要求后自己发送。
 */
export function SkillsPlaza(props: SkillsPlazaProps): ReactNode {
  const { useHome, useSkill, t } = props
  const state = useHome(current => current)

  if (state.status === 'loading') {
    return <div className={css.root}><p className={css.placeholder}>{t('skills.loading')}</p></div>
  }
  if (state.status === 'unavailable') {
    return <div className={css.root}><p className={css.placeholder}>{t('skills.unavailable')}</p></div>
  }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <div>
          <h2 className={css.title}>{t('skills.title')}</h2>
          <p className={css.subtitle}>
            {state.skills.length === 0
              ? t('skills.intro.empty')
              : t('skills.intro', { count: String(state.skills.length) })}
          </p>
        </div>
      </header>

      {state.skills.length === 0
        ? (
          <div className={css.empty}>
            <p className={css.emptyTitle}>{t('skills.empty.title')}</p>
            <p className={css.placeholder}>{t('skills.empty.hint')}</p>
          </div>
        )
        : (
          <div className={css.grid}>
            {state.skills.map(skill => (
              <article key={skill.name} className={css.card}>
                <div className={css.cardHead}>
                  <span className={css.glyph} aria-hidden="true">{skill.displayName.slice(0, 1)}</span>
                  <div className={css.cardTitle}>
                    <span className={css.name}>{skill.displayName}</span>
                    <span className={css.slug}>/{skill.name}</span>
                  </div>
                </div>
                <p className={css.description}>
                  {skill.description === '' ? t('skills.noDescription') : skill.description}
                </p>
                <div className={css.cardFoot}>
                  <span className={css.meta}>
                    {skill.version !== '' && `v${skill.version} · `}
                    {kindLabel(skill, count => t('skills.kind.bundle', { count }))}
                  </span>
                  <span className={css.actions}>
                    <button
                      type="button"
                      className={css.tryButton}
                      title={t('skills.try.hint')}
                      aria-label={`${t('skills.try')} ${skill.displayName}`}
                      onClick={() => { useSkill(skill.name) }}
                    >
                      {t('skills.try')}
                    </button>
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
    </div>
  )
}
