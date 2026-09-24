/**
 * Composer launcher registry and per-session controller.
 *
 * The slash menu remains a text-trigger pipeline. This surface instead owns
 * the visual + menu: top-level actions and searchable panels are contributed
 * by the feature plugins that already own their data.
 */
import { Service } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientSessionContext, InputTriggerHit } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'

export const FILE_ACTION = 'file'
export const COMMANDS_PANEL = 'commands'
export const SKILLS_PANEL = 'skills'
export const CONNECTORS_PANEL = 'connectors'

export interface ComposerMenuContext {
  readonly session: ClientSessionContext
  /** Synthetic composer span captured when the + button opened the menu. */
  readonly hit: InputTriggerHit
}

export interface ComposerMenuRow {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly icon?: ComponentType<IconProps>
  readonly section?: string
  readonly active?: boolean
  readonly disabled?: boolean
  /** Keep the menu open and reload the panel after this row settles. */
  readonly closeOnSelect?: boolean
  onSelect(context: ComposerMenuContext): void | Promise<void>
}

export interface ComposerMenuPanelAction {
  readonly id: string
  readonly label: string
  readonly icon?: ComponentType<IconProps>
  run(context: ComposerMenuContext): void | Promise<void>
}

export interface ComposerMenuPanelData {
  readonly searchPlaceholder: string
  readonly rows: readonly ComposerMenuRow[]
  readonly actions?: readonly ComposerMenuPanelAction[]
  readonly emptyText?: string
}

export interface ComposerMenuPanelContribution {
  readonly id: string
  readonly label: () => string
  readonly icon?: ComponentType<IconProps>
  readonly order?: number
  load(context: ComposerMenuContext, signal: AbortSignal): Promise<ComposerMenuPanelData>
}

export interface ComposerMenuActionContribution {
  readonly id: string
  readonly label: () => string
  readonly icon?: ComponentType<IconProps>
  readonly order?: number
  available?(session: ClientSessionContext): boolean
  run(context: ComposerMenuContext): void | Promise<void>
}

export interface ComposerMenuNavPanel {
  readonly kind: 'panel'
  readonly id: string
  readonly label: string
  readonly icon?: ComponentType<IconProps>
}

export interface ComposerMenuNavAction {
  readonly kind: 'action'
  readonly id: string
  readonly label: string
  readonly icon?: ComponentType<IconProps>
}

export type ComposerMenuNavItem = ComposerMenuNavPanel | ComposerMenuNavAction

export interface ComposerMenuState {
  readonly open: boolean
  readonly nav: readonly ComposerMenuNavItem[]
  readonly activeId: string | null
  readonly status: 'idle' | 'pending' | 'ready' | 'failed'
  readonly data: ComposerMenuPanelData | null
  readonly search: string
  readonly highlightId: string | null
  readonly error: string | null
}

const CLOSED: ComposerMenuState = {
  open: false,
  nav: [],
  activeId: null,
  status: 'idle',
  data: null,
  search: '',
  highlightId: null,
  error: null,
}

export function filteredComposerRows(
  data: ComposerMenuPanelData | null,
  search: string,
): readonly ComposerMenuRow[] {
  if (data === null) return []
  const query = search.trim().toLowerCase()
  if (query === '') return data.rows
  return data.rows.filter(row => row.label.toLowerCase().includes(query)
    || (row.description?.toLowerCase().includes(query) ?? false))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One retained session's composer-locator state. */
export class ComposerMenuController {
  readonly launcher: SnapshotStore<string | null> = createSnapshotStore<string | null>(null)
  readonly state: SnapshotStore<ComposerMenuState> = createSnapshotStore<ComposerMenuState>(CLOSED)
  private hit: InputTriggerHit | null = null
  private generation = 0
  private abort: AbortController | null = null

  constructor(
    private readonly runtime: ComposerMenuRuntime,
    private readonly session: ClientSessionContext,
    private readonly focusComposer: () => void,
  ) {}

  toggle(hit: InputTriggerHit): void {
    if (this.state.getSnapshot().open) this.dismiss()
    else this.open(hit)
  }

  open(hit: InputTriggerHit): void {
    this.hit = hit
    const nav = this.runtime.nav(this.session)
    const active = nav.some(item => item.kind === 'panel' && item.id === SKILLS_PANEL)
      ? SKILLS_PANEL
      : nav.find(item => item.kind === 'panel')?.id ?? null
    this.state.set({
      open: true,
      nav,
      activeId: active,
      status: active === null ? 'ready' : 'pending',
      data: null,
      search: '',
      highlightId: null,
      error: null,
    })
    this.launcher.set('command')
    if (active !== null) void this.load(active)
  }

  dismiss(): void {
    if (!this.state.getSnapshot().open) return
    this.abort?.abort()
    this.abort = null
    this.generation += 1
    this.hit = null
    this.launcher.set(null)
    this.state.set(CLOSED)
    this.focusComposer()
  }

  dispose(): void {
    this.abort?.abort()
    this.abort = null
    this.generation += 1
    this.hit = null
    this.launcher.set(null)
    this.state.set(CLOSED)
  }

  selectNav(id: string): void {
    const nav = this.state.getSnapshot().nav.find(item => item.id === id)
    if (nav === undefined) return
    if (nav.kind === 'panel') {
      void this.load(id)
      return
    }
    const action = this.runtime.action(id)
    if (action === undefined || this.hit === null) return
    void Promise.resolve(action.run({ session: this.session, hit: this.hit }))
      .then(() => { this.dismiss() })
      .catch((error: unknown) => { this.fail(error) })
  }

  setSearch(search: string): void {
    const state = this.state.getSnapshot()
    if (!state.open) return
    const rows = filteredComposerRows(state.data, search)
    this.state.set({ ...state, search, highlightId: rows[0]?.id ?? null })
  }

  move(delta: 1 | -1): void {
    const state = this.state.getSnapshot()
    if (!state.open) return
    const rows = filteredComposerRows(state.data, state.search)
    if (rows.length === 0) return
    const current = state.highlightId === null ? -1 : rows.findIndex(row => row.id === state.highlightId)
    const next = rows[(current < 0 ? (delta === 1 ? 0 : rows.length - 1) : current + delta + rows.length) % rows.length]
    if (next !== undefined) this.state.set({ ...state, highlightId: next.id })
  }

  highlight(id: string): void {
    const state = this.state.getSnapshot()
    if (state.open && state.highlightId !== id) this.state.set({ ...state, highlightId: id })
  }

  async selectHighlighted(): Promise<void> {
    const id = this.state.getSnapshot().highlightId
    if (id !== null) await this.selectRow(id)
  }

  async selectRow(id: string): Promise<void> {
    const state = this.state.getSnapshot()
    const row = state.data?.rows.find(item => item.id === id)
    if (row === undefined || row.disabled === true || this.hit === null) return
    try {
      await row.onSelect({ session: this.session, hit: this.hit })
      if (row.closeOnSelect === false && state.activeId !== null) await this.load(state.activeId, state.search)
      else this.dismiss()
    } catch (error) {
      this.fail(error)
    }
  }

  async runAction(id: string): Promise<void> {
    const action = this.state.getSnapshot().data?.actions?.find(item => item.id === id)
    if (action === undefined || this.hit === null) return
    try {
      await action.run({ session: this.session, hit: this.hit })
      this.dismiss()
    } catch (error) {
      this.fail(error)
    }
  }

  retry(): void {
    const id = this.state.getSnapshot().activeId
    if (id !== null) void this.load(id)
  }

  private async load(id: string, search = ''): Promise<void> {
    const panel = this.runtime.panel(id)
    const hit = this.hit
    if (panel === undefined || hit === null) return
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    const generation = ++this.generation
    const previous = this.state.getSnapshot()
    this.state.set({
      ...previous,
      activeId: id,
      status: 'pending',
      data: previous.activeId === id ? previous.data : null,
      search,
      highlightId: null,
      error: null,
    })
    try {
      const data = await panel.load({ session: this.session, hit }, abort.signal)
      if (abort.signal.aborted || generation !== this.generation) return
      const rows = filteredComposerRows(data, search)
      this.state.set({
        ...this.state.getSnapshot(),
        status: 'ready',
        data,
        search,
        highlightId: rows[0]?.id ?? null,
        error: null,
      })
    } catch (error) {
      if (abort.signal.aborted || generation !== this.generation) return
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    const state = this.state.getSnapshot()
    if (!state.open) return
    this.state.set({ ...state, status: 'failed', error: errorText(error) })
  }
}

interface Registration<T> {
  readonly spec: T
  readonly sequence: number
}

/** Root service: panel/action registry plus retained per-session controllers. */
export class ComposerMenuRuntime extends Service {
  static inject = ['sessions']

  private sequence = 0
  private readonly panels = new Map<string, Registration<ComposerMenuPanelContribution>>()
  private readonly actions = new Map<string, Registration<ComposerMenuActionContribution>>()
  private readonly controllers = new WeakMapWithValues<SessionBinding, ComposerMenuController>()

  constructor(ctx: ClientContext) {
    super(ctx, 'composerMenu')
  }

  registerPanel(panel: ComposerMenuPanelContribution): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.panels.has(panel.id) || this.actions.has(panel.id)) {
        throw new Error(`composerMenu: duplicate contribution ${panel.id}`)
      }
      this.panels.set(panel.id, { spec: panel, sequence: this.sequence++ })
      return () => { this.panels.delete(panel.id) }
    }, 'composerMenu.registerPanel()')
    return () => { void dispose() }
  }

  registerAction(action: ComposerMenuActionContribution): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.panels.has(action.id) || this.actions.has(action.id)) {
        throw new Error(`composerMenu: duplicate contribution ${action.id}`)
      }
      this.actions.set(action.id, { spec: action, sequence: this.sequence++ })
      return () => { this.actions.delete(action.id) }
    }, 'composerMenu.registerAction()')
    return () => { void dispose() }
  }

  panel(id: string): ComposerMenuPanelContribution | undefined {
    return this.panels.get(id)?.spec
  }

  action(id: string): ComposerMenuActionContribution | undefined {
    return this.actions.get(id)?.spec
  }

  nav(session: ClientSessionContext): readonly ComposerMenuNavItem[] {
    const entries: Array<{ order: number; sequence: number; item: ComposerMenuNavItem }> = []
    for (const { spec, sequence } of this.panels.values()) {
      entries.push({
        order: spec.order ?? 0,
        sequence,
        item: { kind: 'panel', id: spec.id, label: spec.label(), ...(spec.icon === undefined ? {} : { icon: spec.icon }) },
      })
    }
    for (const { spec, sequence } of this.actions.values()) {
      if (spec.available?.(session) === false) continue
      entries.push({
        order: spec.order ?? 0,
        sequence,
        item: { kind: 'action', id: spec.id, label: spec.label(), ...(spec.icon === undefined ? {} : { icon: spec.icon }) },
      })
    }
    return entries.sort((left, right) => left.order - right.order || left.sequence - right.sequence).map(entry => entry.item)
  }

  launcherFor(sessionId: string): ObservableSnapshot<string | null> {
    return this.controllerFor(sessionId).launcher
  }

  toggleFor(sessionId: string, hit: InputTriggerHit): void {
    this.controllerFor(sessionId).toggle(hit)
  }

  controllerFor(sessionId: string): ComposerMenuController {
    const sessions: ISessions | undefined = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('composerMenu: sessions service unavailable')
    const scope = sessions.scope(sessionId as never)
    if (scope === undefined) throw new Error(`composerMenu: session ${sessionId} resolved no scope`)
    const session = sessions.sessionOf(scope)
    const binding = session === undefined ? undefined : sessions.binding(session.sessionId)
    if (session === undefined || binding === undefined || binding.session !== session) {
      throw new Error('composerMenu: retained Session scope required')
    }
    const existing = this.controllers.get(binding)
    if (existing !== undefined) return existing
    const controller = new ComposerMenuController(this, session, () => {
      binding.ctx.get('conversation')?.input.for(binding.ctx).focus()
    })
    this.controllers.set(binding, controller)
    binding.ctx.effect(() => () => {
      controller.dispose()
      this.controllers.delete(binding)
    }, 'composerMenu: session controller')
    return controller
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    composerMenu: ComposerMenuRuntime
  }
}
