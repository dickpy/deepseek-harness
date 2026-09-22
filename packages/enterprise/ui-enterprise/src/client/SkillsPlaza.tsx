import { useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  EnterpriseBadgeState, EnterpriseConnector, EnterpriseSkill, UserSkillUpload,
} from './enterprise-store.ts'
import { ConnectorsPanel } from './ConnectorsPanel.tsx'
import { skillUploadFromFiles, skillUploadFromZip, type UploadedSkillFile } from './skill-upload.ts'
import { NS } from './locales.ts'
import css from './SkillsPlaza.module.css'

/** 技能广场的注入面：hooks.home 绑定企业设置节，其余动作写回同一设置节。 */
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
   * 用内置的 skill-creator 技能开一段新对话，让用户自己描述要做的技能。
   * @param prompt - 已经本地化的提示词模板（用户会在输入框里补全要求）。
   */
  createSkill: (prompt: string) => void
  /**
   * 打开/关闭一个技能：写 `dsh-enterprise` 设置节的 `disabledSkills`，
   * host 插件据此调整技能文件的模型可见性
   * （关闭 = 不进模型可见的技能目录，用户手打 `/技能名` 仍可显式调用）。
   * @param skill - 技能标识。
   * @param enabled - true = 启用。
   * @returns 写入结算；失败时界面提示可重试。
   */
  setSkillEnabled: (skill: string, enabled: boolean) => Promise<void>
  /**
   * 上传一个自己写的技能：写 `dsh-enterprise` 设置节的 `userSkills`，
   * host 插件把整包落到本机技能目录。
   * @param upload - 解析好的技能包。
   * @returns 写入结算。
   */
  uploadSkill: (upload: UserSkillUpload) => Promise<void>
  /**
   * 删除一个自己上传的技能（不影响企业管理台下发的技能）。
   * @param name - 技能名。
   * @returns 写入结算。
   */
  removeUserSkill: (name: string) => Promise<void>
  /**
   * 新增/覆盖一个 MCP 连接器。
   * @param connectors - validated connector list from the JSON editor.
   * @returns 写入结算。
   */
  saveConnectors: (connectors: readonly EnterpriseConnector[]) => Promise<void>
  /**
   * 删除一个 MCP 连接器。
   * @param name - MCP serverName。
   * @returns 写入结算。
   */
  removeConnector: (name: string) => Promise<void>
  /**
   * 启用/停用一个 MCP 连接器（host 据此挂载或卸载）。
   * @param name - MCP serverName。
   * @param enabled - true = 挂载。
   * @returns 写入结算。
   */
  setConnectorEnabled: (name: string, enabled: boolean) => Promise<void>
}

export type SkillsPlazaProps =
  & PropsRuntime<'main'>
  & PropsLocale<typeof NS>
  & InjectFace<SkillsPlazaInjected>

/** 面板级 tab：技能广场 / 连接器。 */
/** Text skill assets stay UTF-8; binaries are preserved as base64. */
const TEXT_SKILL_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'sh', 'toml', 'xml', 'html', 'css', 'svg', 'csv', 'ini', 'cfg', 'conf',
])

function isTextSkillFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : ''
  return TEXT_SKILL_EXTENSIONS.has(extension)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

async function readSkillFile(file: File): Promise<UploadedSkillFile> {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
  if (isTextSkillFile(file)) return { path, content: await file.text(), encoding: 'utf8' }
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { path, content: bytesToBase64(bytes), encoding: 'base64' }
}

const TABS = [
  { id: 'skills', label: 'skills.tab.skills' },
  { id: 'connectors', label: 'skills.tab.connectors' },
] as const

/** 启用状态筛选项：id 用于比较，label 是词典 key（界面文案全部走词典） */
const FILTERS = [
  { id: 'all', label: 'skills.filter.all' },
  { id: 'enabled', label: 'skills.filter.enabled' },
  { id: 'disabled', label: 'skills.filter.disabled' },
] as const

/** 把一个技能按当前搜索词/筛选条件判断是否可见。 */
function matchesSkill(skill: EnterpriseSkill, needle: string, filter: 'all' | 'enabled' | 'disabled'): boolean {
  if (filter === 'enabled' && !skill.enabled) return false
  if (filter === 'disabled' && skill.enabled) return false
  if (needle === '') return true
  return `${skill.displayName} ${skill.name} ${skill.description}`.toLowerCase().includes(needle)
}

/**
 * 技能广场（主区域面板）：管理台下发的技能 + 用户自己上传的技能，
 * 顶部用「技能 / 连接器」双 tab 切换——连接器面板由 {@link ConnectorsPanel} 渲染。
 *
 * 数据来自 `dsh-enterprise` 设置节：`skills` 是管理台按角色下发的清单，
 * `userSkills` 是用户在本页面自己上传的技能包，`connectors` 是自定义 MCP。
 * 三个字段都是「客户端写、host 读并落盘」的桥，所以这里不做本地乐观状态，
 * 一律以设置节回读的结果为准。
 *
 * 技能开关的语义：关闭**不卸载**技能、也不影响管理台授权，只是把它从模型可见的
 * 技能目录里摘掉；用户手打 `/技能名` 仍然能显式调用。真正的落盘动作在 host 插件
 * （写技能文件的 `disable-model-invocation`），这里只负责把用户意图写进设置。
 */
export function SkillsPlaza(props: SkillsPlazaProps): ReactNode {
  const {
    useHome, useSkill, createSkill, setSkillEnabled, uploadSkill, removeUserSkill,
    saveConnectors, removeConnector, setConnectorEnabled, t,
  } = props
  const snapshot = useHome(current => current)
  const [tab, setTab] = useState<'skills' | 'connectors'>('skills')
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [detailName, setDetailName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; name: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  if (snapshot.status === 'loading') {
    return <div className={css.root}><p className={css.placeholder}>{t('skills.loading')}</p></div>
  }
  if (snapshot.status === 'unavailable') {
    return <div className={css.root}><p className={css.placeholder}>{t('skills.unavailable')}</p></div>
  }

  const all = snapshot.skills
  const enabledCount = all.filter(skill => skill.enabled).length
  const needle = keyword.trim().toLowerCase()
  const visible = all.filter(skill => matchesSkill(skill, needle, filter))
  const mine = visible.filter(skill => skill.source === 'user')
  const enterprise = visible.filter(skill => skill.source === 'enterprise')
  const detail = detailName === null ? undefined : all.find(skill => skill.name === detailName)
  const kindOf = (skill: EnterpriseSkill): string => (skill.kind !== 'bundle'
    ? t('skills.kind.single')
    : t('skills.kind.bundle', { count: String(skill.fileCount) }))
  const describeError = (reason: unknown): string => {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (message.includes('no Markdown entry found')) return t('skills.upload.missingSkill')
    if (message.includes('invalid zip data')) return t('skills.upload.invalidZip')
    return message
  }

  const toggle = (skill: EnterpriseSkill): void => {
    setError(null)
    void setSkillEnabled(skill.name, !skill.enabled).catch((reason: unknown) => {
      setError(t('skills.toggle.failed', { message: describeError(reason) }))
    })
  }

  /** 读取用户选中的文本文件（目录上传时会带上相对路径），整理成技能包后写设置节。 */
  const onPickSkillFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const list = event.target.files
    event.target.value = ''
    if (list === null || list.length === 0) {
      setError(t('skills.upload.empty'))
      return
    }
    void (async () => {
      setError(null)
      setBusy(true)
      try {
        const picked = Array.from(list)
        setUploadProgress({ current: 0, total: picked.length, name: picked[0]?.name ?? '' })
        const files: UploadedSkillFile[] = []
        for (const [index, file] of picked.entries()) {
          setUploadProgress({ current: index, total: picked.length, name: file.name })
          files.push(await readSkillFile(file))
        }
        setUploadProgress({ current: picked.length, total: picked.length, name: t('skills.upload.saving') })
        await uploadSkill(skillUploadFromFiles(files))
      } catch (reason) {
        setError(t('skills.upload.failed', { message: describeError(reason) }))
      } finally {
        setBusy(false)
        setUploadProgress(null)
      }
    })()
  }

  /** Upload the preferred ZIP package form; parsing and saving expose progress. */
  const onPickSkillZip = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) {
      setError(t('skills.upload.empty'))
      return
    }
    void (async () => {
      setError(null)
      setBusy(true)
      setUploadProgress({ current: 0, total: 1, name: file.name })
      try {
        const upload = await skillUploadFromZip(new Uint8Array(await file.arrayBuffer()))
        setUploadProgress({ current: 1, total: 1, name: t('skills.upload.saving') })
        await uploadSkill(upload)
      } catch (reason) {
        setError(t('skills.upload.failed', { message: describeError(reason) }))
      } finally {
        setBusy(false)
        setUploadProgress(null)
      }
    })()
  }

  const removeMine = (skill: EnterpriseSkill): void => {
    setError(null)
    void removeUserSkill(skill.name)
      .then(() => { setDetailName(null) })
      .catch((reason: unknown) => { setError(t('skills.remove.failed', { message: describeError(reason) })) })
  }

  /** 分组卡片墙：标题 + 数量 + 卡片网格（筛掉空组，避免出现无意义的标题）。 */
  const renderGroup = (id: string, label: string, skills: readonly EnterpriseSkill[]): ReactNode => (
    <section key={id} className={css.group}>
      <div className={css.groupHead}>
        <h3 className={css.groupTitle}>{label}</h3>
        <span className={css.groupCount}>{t('skills.group.count', { count: String(skills.length) })}</span>
      </div>
      {skills.length === 0
        ? <p className={css.groupEmpty}>{id === 'mine' ? t('skills.group.mine.empty') : t('skills.group.enterprise.empty')}</p>
        : (
          <div className={css.grid}>
            {skills.map(skill => (
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
    </section>
  )
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

      <div className={css.tabs} role="tablist" aria-label={t('skills.tabs.aria')}>
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? `${css.tab} ${css.tabActive}` : css.tab}
            onClick={() => { setTab(item.id); setError(null) }}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      {tab === 'connectors'
        ? (
          <ConnectorsPanel
            t={t}
            connectors={snapshot.connectors}
            saveConnectors={saveConnectors}
            removeConnector={removeConnector}
            setConnectorEnabled={setConnectorEnabled}
          />
        )
        : (
          <>
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
              <span className={css.actions}>
                <button
                  type="button"
                  className={css.primaryButton}
                  title={t('skills.create.hint')}
                  onClick={() => { createSkill(t('skills.create.prompt')) }}
                >
                  {t('skills.create')}
                </button>
                <button
                  type="button"
                  className={css.outlineButton}
                  disabled={busy}
                  title={t('skills.upload.hint')}
                  onClick={() => { fileRef.current?.click() }}
                >
                  {t('skills.upload')}
                </button>
                <button
                  type="button"
                  className={css.outlineButton}
                  disabled={busy}
                  title={t('skills.upload.folderHint')}
                  onClick={() => { folderRef.current?.click() }}
                >
                  {t('skills.upload.folder')}
                </button>
              </span>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                className={css.fileInput}
                onChange={onPickSkillZip}
              />
              <input
                ref={folderRef}
                type="file"
                multiple
                {...{ webkitdirectory: '', directory: '' }}
                className={css.fileInput}
                onChange={onPickSkillFiles}
              />
            </div>

            {uploadProgress !== null && (
              <div className={css.uploadProgress} role="status" aria-live="polite">
                <div className={css.uploadProgressText}>
                  {t('skills.upload.progress', {
                    current: String(uploadProgress.current),
                    total: String(uploadProgress.total),
                    name: uploadProgress.name,
                  })}
                </div>
                <div className={css.uploadProgressTrack} aria-hidden="true">
                  <span
                    className={css.uploadProgressBar}
                    style={{ width: `${uploadProgress.total === 0 ? 0 : uploadProgress.current / uploadProgress.total * 100}%` }}
                  />
                </div>
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
                  <>
                    {renderGroup('mine', t('skills.group.mine'), mine)}
                    {renderGroup('enterprise', t('skills.group.enterprise'), enterprise)}
                  </>
                )}
          </>
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
                  <dd>{detail.source === 'user' ? t('skills.detail.source.user') : t('skills.detail.source.value')}</dd>
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
              {detail.source === 'user' && (
                <button
                  type="button"
                  className={css.outlineButton}
                  onClick={() => { removeMine(detail) }}
                >
                  {t('skills.remove')}
                </button>
              )}
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
