import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  /**
   * 打开/关闭一个技能：写 `dsh-enterprise` 设置节的 `disabledSkills`，
   * host 插件据此调整技能文件的模型可见性
   * （关闭 = 不进模型可见的技能目录，用户手打 `/技能名` 仍可显式调用）。
   * @param skill - 技能标识。
   * @param enabled - true = 启用。
   * @returns 写入结算；失败时界面提示可重试。
   */
  setSkillEnabled: (skill: string, enabled: boolean) => Promise<void>
}

export type SkillsPlazaProps =
  & PropsRuntime<'main'>
  & PropsLocale<typeof NS>
  & InjectFace<SkillsPlazaInjected>

/** 启用状态筛选项：id 用于比较，label 是词典 key（界面文案全部走词典） */
const FILTERS = [
  { id: 'all', label: 'skills.filter.all' },
  { id: 'enabled', label: 'skills.filter.enabled' },
  { id: 'disabled', label: 'skills.filter.disabled' },
] as const

/**
 * 技能广场（主区域面板）：管理台「技能广场」里已发布、且对当前用户角色可见的
 * 技能，按 WorkBuddy 技能广场的形态铺成卡片墙——搜索、按启用状态筛选、
 * 卡片右上角开关直接启用/关闭、点卡片看详情。
 *
 * 数据来自 `dsh-enterprise` 设置节的 skills 字段——host 插件每次同步企业配置时写入，
 * 所以这里不需要自己扫本机 skills 目录，也不会出现「管理台有、桌面端没有」的偏差。
 *
 * 开关的语义：关闭**不卸载**技能、也不影响管理台授权，只是把它从模型可见的
 * 技能目录里摘掉；用户手打 `/技能名` 仍然能显式调用。真正的落盘动作在 host 插件
 * （写技能文件的 `disable-model-invocation`），这里只负责把用户意图写进设置，
 * 并如实反映设置里的当前状态——不做乐观翻转，免得写失败时界面骗人。
 *
 * 搜索词、筛选与详情弹窗都是纯界面状态，随面板卸载即丢弃，因此用组件本地状态。
 */
export function SkillsPlaza(props: SkillsPlazaProps): ReactNode {
  const { useHome, useSkill, setSkillEnabled, t } = props
  const snapshot = useHome(current => current)
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [detailName, setDetailName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (snapshot.status === 'loading') {
    return <div className={css.root}><p className={css.placeholder}>{t('skills.loading')}</p></div>
  }
  if (snapshot.status === 'unavailable') {
    return <div className={css.root}><p className={css.placeholder}>{t('skills.unavailable')}</p></div>
  }

  const all = snapshot.skills
  const enabledCount = all.filter(skill => skill.enabled).length
  const needle = keyword.trim().toLowerCase()
  const visible = all.filter((skill) => {
    if (filter === 'enabled' && !skill.enabled) return false
    if (filter === 'disabled' && skill.enabled) return false
    if (needle === '') return true
    return `${skill.displayName} ${skill.name} ${skill.description}`.toLowerCase().includes(needle)
  })
  const detail = detailName === null ? undefined : all.find(skill => skill.name === detailName)
  const kindOf = (skill: EnterpriseSkill): string => (skill.kind !== 'bundle'
    ? t('skills.kind.single')
    : t('skills.kind.bundle', { count: String(skill.fileCount) }))

  const toggle = (skill: EnterpriseSkill): void => {
    setError(null)
    void setSkillEnabled(skill.name, !skill.enabled).catch((reason: unknown) => {
      setError(t('skills.toggle.failed', {
        message: reason instanceof Error ? reason.message : String(reason),
      }))
    })
  }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <div>
          <h2 className={css.title}>{t('skills.title')}</h2>
          <p className={css.subtitle}>
            {all.length === 0
              ? t('skills.intro.empty')
              : t('skills.intro', { count: String(all.length), enabled: String(enabledCount) })}
          </p>
        </div>
      </header>

      {all.length > 0 && (
        <div className={css.toolbar}>
          <input
            className={css.search}
            type="search"
            value={keyword}
            aria-label={t('skills.search.aria')}
            placeholder={t('skills.search.placeholder')}
            onChange={(event) => { setKeyword(event.target.value) }}
          />
          <div className={css.filters} role="group" aria-label={t('skills.filter.aria')}>
            {FILTERS.map(key => (
              <button
                key={key.id}
                type="button"
                className={filter === key.id ? `${css.filter} ${css.filterActive}` : css.filter}
                aria-pressed={filter === key.id}
                onClick={() => { setFilter(key.id) }}
              >
                {t(key.label)}
              </button>
            ))}
          </div>
          <span className={css.count}>
            {visible.length === all.length
              ? t('skills.count', { count: String(all.length), enabled: String(enabledCount) })
              : t('skills.count.filtered', { count: String(visible.length), total: String(all.length) })}
          </span>
        </div>
      )}

      {error !== null && (
        <p className={css.error} role="alert">{error}</p>
      )}

      {all.length === 0
        ? (
          <div className={css.empty}>
            <p className={css.emptyTitle}>{t('skills.empty.title')}</p>
            <p className={css.placeholder}>{t('skills.empty.hint')}</p>
          </div>
        )
        : visible.length === 0
          ? (
            <div className={css.empty}>
              <p className={css.emptyTitle}>{t('skills.emptyFiltered.title')}</p>
              <p className={css.placeholder}>{t('skills.emptyFiltered.hint')}</p>
            </div>
          )
          : (
            <div className={css.grid}>
              {visible.map(skill => (
                <article key={skill.name} className={skill.enabled ? css.card : `${css.card} ${css.cardOff}`}>
                  <div className={css.cardHead}>
                    <span className={css.glyph} aria-hidden="true">{skill.displayName.slice(0, 1)}</span>
                    <button
                      type="button"
                      className={css.cardTitle}
                      onClick={() => { setDetailName(skill.name) }}
                    >
                      <span className={css.name}>{skill.displayName}</span>
                      <span className={css.slug}>/{skill.name}</span>
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={t('skills.toggle.aria', { name: skill.displayName })}
                      title={skill.enabled ? t('skills.toggle.on') : t('skills.toggle.off')}
                      className={skill.enabled ? `${css.switch} ${css.switchOn}` : css.switch}
                      onClick={() => { toggle(skill) }}
                    >
                      <span className={css.switchKnob} />
                    </button>
                  </div>
                  <p className={css.description}>
                    {skill.description === '' ? t('skills.noDescription') : skill.description}
                  </p>
                  <div className={css.cardFoot}>
                    <span className={css.meta}>
                      {skill.version !== '' && t('skills.meta.version', { version: skill.version })}
                      {kindOf(skill)}
                      {!skill.installed && ` · ${t('skills.state.notInstalled')}`}
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

      {detail !== undefined && (
        <div
          className={css.overlay}
          role="presentation"
          onClick={() => { setDetailName(null) }}
        >
          <div
            className={css.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={t('skills.detail.title')}
            onClick={(event) => { event.stopPropagation() }}
          >
            <div className={css.dialogHead}>
              <span className={css.glyph} aria-hidden="true">{detail.displayName.slice(0, 1)}</span>
              <div className={css.cardTitle}>
                <span className={css.name}>{detail.displayName}</span>
                <span className={css.slug}>/{detail.name}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={detail.enabled}
                aria-label={t('skills.toggle.aria', { name: detail.displayName })}
                title={detail.enabled ? t('skills.toggle.on') : t('skills.toggle.off')}
                className={detail.enabled ? `${css.switch} ${css.switchOn}` : css.switch}
                onClick={() => { toggle(detail) }}
              >
                <span className={css.switchKnob} />
              </button>
              <button
                type="button"
                className={css.dialogClose}
                aria-label={t('skills.detail.close')}
                onClick={() => { setDetailName(null) }}
              >
                ×
              </button>
            </div>

            <div className={css.dialogBody}>
              {!detail.enabled && (
                <p className={css.notice}>{t('skills.detail.disabledNotice', { name: detail.name })}</p>
              )}
              <h3 className={css.dialogTitle}>{t('skills.detail.about')}</h3>
              <p className={css.dialogText}>
                {detail.description === '' ? t('skills.noDescription') : detail.description}
              </p>

              <h3 className={css.dialogTitle}>{t('skills.detail.meta')}</h3>
              <dl className={css.metaList}>
                <div>
                  <dt>{t('skills.detail.identifier')}</dt>
                  <dd className={css.mono}>/{detail.name}</dd>
                </div>
                <div>
                  <dt>{t('skills.detail.version')}</dt>
                  <dd>{detail.version === '' ? t('skills.detail.version.none') : t('skills.meta.version', { version: detail.version }).trim()}</dd>
                </div>
                <div>
                  <dt>{t('skills.detail.kind')}</dt>
                  <dd>{kindOf(detail)}</dd>
                </div>
                <div>
                  <dt>{t('skills.detail.source')}</dt>
                  <dd>{t('skills.detail.source.value')}</dd>
                </div>
                <div>
                  <dt>{t('skills.detail.install')}</dt>
                  <dd>{detail.installed ? t('skills.detail.install.value') : t('skills.detail.install.pending')}</dd>
                </div>
                <div>
                  <dt>{t('skills.detail.invoke')}</dt>
                  <dd className={css.mono}>{t('skills.detail.invoke.value', { name: detail.name })}</dd>
                </div>
              </dl>
            </div>

            <div className={css.dialogFoot}>
              <button
                type="button"
                className={css.tryButton}
                onClick={() => { setDetailName(null); useSkill(detail.name) }}
              >
                {t('skills.try')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
