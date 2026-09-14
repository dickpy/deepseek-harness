import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { EnterpriseBadgeState } from './enterprise-store.ts'
import { exampleDraft, type HomeExample } from './home-examples.ts'
import { NS } from './locales.ts'
import css from './HomeGallery.module.css'

/** 「换一批」每批展示的样例数：一排四张，与 WorkBuddy 的案例墙一致 */
const PAGE_SIZE = 4

/** 首页样例区的注入面：hooks.home 绑定企业设置节。 */
export interface HomeGalleryInjected {
  hooks: {
    home: ObservableSnapshot<EnterpriseBadgeState>
  }
}

export type HomeGalleryProps =
  & PropsRuntime<'conversation.hero.gallery'>
  & PropsLocale<typeof NS>
  & InjectFace<HomeGalleryInjected>

/**
 * 从样例列表里挑一批展示。
 *
 * 「换一批」是**随机换**而不是翻页：样例之间没有先后叙事关系，管理员配置的
 * 顺序已经被首屏那一批用掉了，后续再来回翻页反而比随机更没惊喜。
 * 只有一批可换（样例数 ≤ {@link PAGE_SIZE}）时按钮禁用，免得点了没反应。
 *
 * @param examples - 全部样例。
 * @param offset - 本轮的起始偏移（每次「换一批」在总长度上滑动一个随机量）。
 * @returns 本批展示的样例与是否还能换。
 */
function pickBatch(examples: readonly HomeExample[], offset: number): {
  batch: readonly HomeExample[]
  canShuffle: boolean
} {
  if (examples.length <= PAGE_SIZE) return { batch: examples, canShuffle: false }
  const batch: HomeExample[] = []
  for (let index = 0; index < PAGE_SIZE; index += 1) {
    batch.push(examples[(offset + index) % examples.length] as HomeExample)
  }
  return { batch, canShuffle: true }
}

/**
 * 会话首页的样例区（输入框下方）。
 *
 * 结构照 WorkBuddy 的「不知道做什么，试试最佳实践案例」：标题行右侧是
 * 「换一批」与「关闭」，下面一排样例卡片。点卡片弹出预览窗——左边样例图、
 * 右边详情（技能、提示词、相关产物），底部「做同款」把
 * `/技能名 + 提示词` 填进输入框（不自动发送，用户可继续补充）。
 *
 * 样例由管理台「首页样例配置」下发，因此这里不做任何兜底内容：
 * 管理台一张都没配就整块不渲染，用户看到的是干净的首页而不是一堆假案例。
 * 「关闭」只影响本次会话（组件本地状态），刷新页面后重新出现——
 * 它服务的是「我现在想安静地写点东西」，不是一份需要持久化的偏好。
 */
export function HomeGallery(props: HomeGalleryProps): ReactNode {
  const { useHome, inputActions, t } = props
  const state = useHome(current => current)
  const [offset, setOffset] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const examples = state.examples
  const { batch, canShuffle } = useMemo(() => pickBatch(examples, offset), [examples, offset])
  const open = openId === null ? undefined : examples.find(example => example.id === openId)

  if (dismissed || examples.length === 0) return null

  const applyExample = (example: HomeExample): void => {
    setOpenId(null)
    if (inputActions === undefined) return
    inputActions.setDraft(exampleDraft(example))
  }

  return (
    <section className={css.root} aria-label={t('gallery.aria')}>
      <div className={css.head}>
        <span className={css.title}>{t('gallery.title')}</span>
        <div className={css.headActions}>
          <button
            type="button"
            className={css.ghost}
            disabled={!canShuffle}
            title={canShuffle ? t('gallery.shuffle.hint') : t('gallery.shuffle.exhausted')}
            onClick={() => { setOffset(current => current + PAGE_SIZE) }}
          >
            <span aria-hidden="true">↻</span> {t('gallery.shuffle')}
          </button>
          <button
            type="button"
            className={css.ghost}
            aria-label={t('gallery.close')}
            title={t('gallery.close')}
            onClick={() => { setDismissed(true) }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className={css.grid}>
        {batch.map(example => (
          <button
            key={example.id}
            type="button"
            className={css.card}
            title={t('gallery.card.hint')}
            onClick={() => { setOpenId(example.id) }}
          >
            <span className={css.thumb}>
              <img src={example.image} alt="" loading="lazy" />
            </span>
            <span className={css.cardLabel}>{example.label}</span>
          </button>
        ))}
      </div>

      {open !== undefined && (
        <div
          className={css.overlay}
          role="presentation"
          onClick={() => { setOpenId(null) }}
        >
          <div
            className={css.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={open.label}
            onClick={(event) => { event.stopPropagation() }}
          >
            <div className={css.preview}>
              <img src={open.image} alt="" />
            </div>
            <div className={css.detail}>
              <div className={css.detailHead}>
                <h3 className={css.detailTitle}>{open.label}</h3>
                <button
                  type="button"
                  className={css.ghost}
                  aria-label={t('gallery.close')}
                  onClick={() => { setOpenId(null) }}
                >
                  ✕
                </button>
              </div>
              {open.summary !== '' && <p className={css.detailSummary}>{open.summary}</p>}

              <div className={css.detailBody}>
                <section>
                  <h4 className={css.sectionTitle}>{t('gallery.detail.skill')}</h4>
                  {open.skill === null
                    ? <p className={css.sectionText}>{t('gallery.detail.skill.none')}</p>
                    : (
                      <p className={css.sectionText}>
                        <span className={css.chip}>{open.skill}</span>
                      </p>
                    )}
                </section>

                <section>
                  <h4 className={css.sectionTitle}>{t('gallery.detail.prompt')}</h4>
                  <pre className={css.prompt}>{open.prompt}</pre>
                </section>

                {open.artifacts.length > 0 && (
                  <section>
                    <h4 className={css.sectionTitle}>
                      {t('gallery.detail.artifacts', { count: String(open.artifacts.length) })}
                    </h4>
                    <ul className={css.artifacts}>
                      {open.artifacts.map(artifact => (
                        <li key={artifact.label}>
                          <span className={css.artifactLabel}>{artifact.label}</span>
                          {artifact.note !== undefined && <span className={css.artifactNote}>{artifact.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              <div className={css.detailFoot}>
                <button
                  type="button"
                  className={css.primary}
                  disabled={inputActions === undefined}
                  title={t('gallery.apply.hint', { name: open.skill ?? '' })}
                  onClick={() => { applyExample(open) }}
                >
                  {t('gallery.apply')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
