import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorTransport, EnterpriseConnector } from './enterprise-store.ts'
import { formatMcpConfig, parseMcpConfig } from './mcp-config.ts'
import { NS } from './locales.ts'
import css from './SkillsPlaza.module.css'

/** Shared enterprise locale translator. */
type Translate = PropsLocale<typeof NS>['t']

export interface ConnectorsPanelProps {
  readonly t: Translate
  readonly connectors: readonly EnterpriseConnector[]
  readonly saveConnectors: (connectors: readonly EnterpriseConnector[]) => Promise<void>
  readonly removeConnector: (name: string) => Promise<void>
  readonly setConnectorEnabled: (name: string, enabled: boolean) => Promise<void>
}

/**
 * MCP connector panel: card list for daily toggles plus one standard
 * `mcpServers` JSON editor for add/edit operations.
 */
export function ConnectorsPanel(props: ConnectorsPanelProps): ReactNode {
  const { t, connectors, saveConnectors, removeConnector, setConnectorEnabled } = props
  const [keyword, setKeyword] = useState('')
  const [jsonDraft, setJsonDraft] = useState<string | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const gutterRef = useRef<HTMLPreElement>(null)

  const needle = keyword.trim().toLowerCase()
  const visible = connectors.filter(connector => needle === ''
    || `${connector.name} ${connector.description} ${connector.command} ${connector.url}`.toLowerCase().includes(needle))
  const enabledCount = connectors.filter(connector => connector.enabled).length
  const describeError = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))
  const transportLabel = (transport: ConnectorTransport): string => (transport === 'streamable-http'
    ? t('skills.connector.transport.http')
    : t('skills.connector.transport.stdio'))
  const endpointOf = (connector: EnterpriseConnector): string => (connector.transport === 'streamable-http'
    ? t('skills.connector.endpoint.http', { url: connector.url })
    : t('skills.connector.endpoint.stdio', { command: connector.command }))

  const currentJson = formatMcpConfig(connectors)
  const jsonChanged = jsonDraft !== null && jsonDraft !== currentJson
  const lineNumbers = jsonDraft === null
    ? ''
    : jsonDraft.split('\n').map((_, index) => String(index + 1)).join('\n')

  const openCreate = (): void => {
    setError(null)
    setEditingName(null)
    setJsonDraft('{\n  "mcpServers": {}\n}')
  }

  const openEdit = (connector: EnterpriseConnector): void => {
    setError(null)
    setEditingName(connector.name)
    setJsonDraft(formatMcpConfig([connector]))
  }

  const closeConfig = (): void => {
    if (busy) return
    setError(null)
    setEditingName(null)
    setJsonDraft(null)
  }

  const toggle = (connector: EnterpriseConnector): void => {
    setError(null)
    void setConnectorEnabled(connector.name, !connector.enabled).catch((reason: unknown) => {
      setError(t('skills.connector.toggle.failed', { message: describeError(reason) }))
    })
  }

  const remove = (connector: EnterpriseConnector): void => {
    setError(null)
    void removeConnector(connector.name).catch((reason: unknown) => {
      setError(t('skills.connector.remove.failed', { message: describeError(reason) }))
    })
  }

  const saveConfig = (): void => {
    if (jsonDraft === null) return
    let next: EnterpriseConnector[]
    try {
      next = parseMcpConfig(jsonDraft)
      if (next.length !== 1) throw new Error(t('skills.connector.config.one'))
      if (editingName !== null && next[0]?.name !== editingName) {
        throw new Error(t('skills.connector.config.editName', { name: editingName }))
      }
    } catch (reason) {
      setError(t('skills.connector.config.invalid', { message: describeError(reason) }))
      return
    }
    setError(null)
    setBusy(true)
    void saveConnectors(next)
      .then(() => { setJsonDraft(null) })
      .catch((reason: unknown) => {
        setError(t('skills.connector.config.save.failed', { message: describeError(reason) }))
      })
      .finally(() => { setBusy(false) })
  }

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <input
          className={css.search}
          type="search"
          value={keyword}
          aria-label={t('skills.connector.search.aria')}
          placeholder={t('skills.connector.search.placeholder')}
          onChange={(event) => { setKeyword(event.target.value) }}
        />
        <span className={css.count}>
          {visible.length === connectors.length
            ? t('skills.connector.count', { count: String(connectors.length), enabled: String(enabledCount) })
            : t('skills.connector.count.filtered', { count: String(visible.length), total: String(connectors.length) })}
        </span>
        <span className={css.actions}>
          <button
            type="button"
            className={css.outlineButton}
            title={t('skills.connector.create.hint')}
            onClick={openCreate}
          >
            {t('skills.connector.create')}
          </button>
        </span>
      </div>

      <p className={css.subtitle}>
        {connectors.length === 0
          ? t('skills.connector.intro.empty')
          : t('skills.connector.intro', { count: String(connectors.length), enabled: String(enabledCount) })}
      </p>

      {error !== null && jsonDraft === null && <p className={css.error} role="alert">{error}</p>}

      {connectors.length === 0
        ? (
          <div className={css.empty}>
            <p className={css.emptyTitle}>{t('skills.connector.empty.title')}</p>
            <p className={css.placeholder}>{t('skills.connector.empty.hint')}</p>
          </div>
        )
        : visible.length === 0
          ? (
            <div className={css.empty}>
              <p className={css.emptyTitle}>{t('skills.connector.emptyFiltered.title')}</p>
              <p className={css.placeholder}>{t('skills.connector.emptyFiltered.hint')}</p>
            </div>
          )
          : (
            <div className={css.grid}>
              {visible.map(connector => (
                <article
                  key={connector.name}
                  className={connector.enabled ? css.card : `${css.card} ${css.cardOff}`}
                >
                  <div className={css.cardHead}>
                    <span className={css.glyph} aria-hidden="true">{connector.name.slice(0, 1).toUpperCase()}</span>
                    <div className={css.cardTitle}>
                      <span className={css.name}>{connector.name}</span>
                      <span className={css.slug}>{transportLabel(connector.transport)}</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={connector.enabled}
                      aria-label={t('skills.connector.toggle.aria', { name: connector.name })}
                      title={connector.enabled ? t('skills.connector.toggle.on') : t('skills.connector.toggle.off')}
                      className={connector.enabled ? `${css.switch} ${css.switchOn}` : css.switch}
                      onClick={() => { toggle(connector) }}
                    >
                      <span className={css.switchKnob} />
                    </button>
                  </div>
                  <p className={css.description}>
                    {connector.description === '' ? t('skills.connector.description.none') : connector.description}
                  </p>
                  <div className={css.cardFoot}>
                    <span className={`${css.meta} ${css.mono}`}>{endpointOf(connector)}</span>
                    <span className={css.actions}>
                      <button type="button" className={css.tryButton} onClick={() => { openEdit(connector) }}>
                        {t('skills.connector.edit')}
                      </button>
                      <button type="button" className={css.outlineButton} onClick={() => { remove(connector) }}>
                        {t('skills.connector.remove')}
                      </button>
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}

      {jsonDraft !== null && (
        <div className={css.overlay} role="presentation" onClick={closeConfig}>
          <div
            className={`${css.dialog} ${css.mcpDialog}`}
            role="dialog"
            aria-modal="true"
            aria-label={t(editingName === null ? 'skills.connector.config.newTitle' : 'skills.connector.config.editTitle')}
            onClick={(event) => { event.stopPropagation() }}
          >
            <div className={css.mcpDialogHead}>
              <div>
                <h2 className={css.mcpTitle}>{t(editingName === null ? 'skills.connector.config.newTitle' : 'skills.connector.config.editTitle')}</h2>
                <p className={css.mcpSubtitle}>{t(editingName === null ? 'skills.connector.config.newSubtitle' : 'skills.connector.config.editSubtitle')}</p>
              </div>
              <button type="button" className={css.outlineButton} disabled={busy} onClick={closeConfig}>
                {t('skills.connector.config.back')}
              </button>
            </div>

            <div className={css.mcpPath}>
              {t('skills.connector.config.path', { path: 'dsh-enterprise.connectors' })}
            </div>
            <p className={css.mcpHint}>{t('skills.connector.config.mergeHint')}</p>

            <div className={css.jsonEditor}>
              <pre ref={gutterRef} className={css.jsonGutter} aria-hidden="true">{lineNumbers}</pre>
              <textarea
                className={css.jsonTextarea}
                aria-label={t(editingName === null ? 'skills.connector.config.newTitle' : 'skills.connector.config.editTitle')}
                spellCheck={false}
                value={jsonDraft}
                onChange={(event) => { setJsonDraft(event.target.value) }}
                onScroll={(event) => {
                  if (gutterRef.current !== null) gutterRef.current.scrollTop = event.currentTarget.scrollTop
                }}
              />
            </div>

            {error !== null && <p className={css.mcpError} role="alert">{error}</p>}

            <div className={css.mcpDialogFoot}>
              <button type="button" className={css.outlineButton} disabled={busy} onClick={closeConfig}>
                {t('skills.connector.form.cancel')}
              </button>
              <button
                type="button"
                className={css.primaryButton}
                disabled={busy || !jsonChanged}
                onClick={saveConfig}
              >
                {t('skills.connector.form.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
