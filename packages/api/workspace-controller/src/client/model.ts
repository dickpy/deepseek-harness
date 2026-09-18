/** Client-side Workspace state model shared by Remote transport and UI projection. */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteValue,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionValue,
  WorkspaceSetSessionPinnedRequest,
  WorkspaceSetPinnedRequest,
  WorkspaceValue,
  WorkspaceId,
  WorkspaceView,
} from '../types.ts'

/** Complete generated `ctx.remote.workspace` namespace. */
export type WorkspaceRemote = TypertClientRemote['workspace']

/** Monotone Workspace-list arrival lifecycle. */
export type WorkspaceListPhase = 'pending' | 'ready'

/** Immutable Client Workspace state. */
export interface WorkspaceSnapshot {
  readonly items: readonly WorkspaceView[]
  /** Complete registry-global archive set in Host order. */
  readonly archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']
  /**
   * Pinned Workspaces in display order: the leading prefix of `items`. Pin
   * state is never carried per row — a row's `updatedAt` does not move when
   * it is pinned, so a per-row flag would go stale against the changes the
   * archive and order frames already describe.
   */
  readonly pinnedWorkspaceIds: readonly WorkspaceId[]
  /**
   * Pinned Sessions in pin order, newest first. Membership is registry-global:
   * a pinned Session leads the group that already owns it, so this set decides
   * nothing about which group that is.
   */
  readonly pinnedSessionIds: WorkspacePinSessionValue['pinnedSessionIds']
  readonly state: 'idle' | 'loading' | 'error'
  readonly phase: WorkspaceListPhase
  readonly error: RemoteFailure | null
}

/** State operations emitted by a decoded Workspace follow generation. */
export interface WorkspaceFollowSink {
  /** Replace all state from the generation baseline. */
  replaceBaseline(value: WorkspaceBaseline): void
  /** Merge one Workspace row. */
  upsertView(workspace: WorkspaceView): void
  /** Remove one Workspace row. */
  removeView(workspaceId: WorkspaceId): void
  /** Replace the Host-confirmed Workspace order and its pinned prefix. */
  replaceOrder(workspaceIds: readonly WorkspaceId[], pinnedWorkspaceIds: readonly WorkspaceId[]): void
  /** Replace the complete archived Session set. */
  replaceArchived(sessionIds: WorkspaceArchiveValue['archivedSessionIds']): void
  /** Replace the complete pinned Session set. */
  replacePinned(pinnedSessionIds: WorkspacePinSessionValue['pinnedSessionIds']): void
}

/**
 * Owns the Client Workspace projection, mutation echoes, and stream/unary race resolution.
 */
export class ClientWorkspaceModel implements WorkspaceFollowSink {
  private items: readonly WorkspaceView[] = []
  private archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds'] = []
  private pinnedSessionIds: WorkspacePinSessionValue['pinnedSessionIds'] = []
  private pinnedWorkspaceIds: readonly WorkspaceId[] = []
  private state: WorkspaceSnapshot['state'] = 'loading'
  private phase: WorkspaceListPhase = 'pending'
  private error: RemoteFailure | null = null
  /** Latest local reorder request; only its unary echo may install order. */
  private orderRequestGeneration = 0
  /** Increments on stream orders so a later remote commit outranks an older unary echo. */
  private orderFrameGeneration = 0
  /** Last complete order accepted from a baseline, increment, or current unary echo. */
  private committedOrder: WorkspaceId[] = []
  /** Pinned prefix of `committedOrder`, so a rejected pin can restore both together. */
  private committedPinned: WorkspaceId[] = []
  /** Host Workspace ids are never reused, so delayed data cannot resurrect a removed row. */
  private readonly removedIds = new Set<WorkspaceId>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: WorkspaceSnapshot
  private snapshotDirty = false
  private notificationPending = false
  private notificationScheduled = false
  private notificationGeneration = 0

  /** @param remote - generated Workspace Remote namespace. */
  constructor(private readonly remote: WorkspaceRemote) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Create or resolve a Workspace and merge the unary result immediately.
   * @param input - existing absolute path to adopt.
   * @returns generated Remote result.
   */
  async create(input: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    const result = await this.remote.create(input)
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Rename a Workspace and merge the unary result immediately.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns generated Remote result.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.rename({ workspaceId, title })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Delete a Workspace and remove it from the local projection immediately.
   * @param workspaceId - target Workspace.
   * @returns generated Remote result.
   */
  async delete(workspaceId: WorkspaceId): Promise<RemoteResult<WorkspaceDeleteValue>> {
    const result = await this.remote.delete({ workspaceId })
    if (result.ok) this.remove(workspaceId, true)
    return result
  }

  /**
   * Optimistically move a Workspace and reconcile the returned complete order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   * @returns generated Remote result.
   */
  async insertBefore(
    workspaceId: WorkspaceId,
    beforeWorkspaceId?: WorkspaceId,
  ): Promise<RemoteResult<WorkspaceOrderValue>> {
    const requestGeneration = ++this.orderRequestGeneration
    const frameGeneration = this.orderFrameGeneration
    const localOrder = this.items.map(workspace => workspace.workspaceId)
    const pinned = new Set(this.pinnedWorkspaceIds)
    // The optimistic order repeats the Host's region rule: a move never
    // changes which Workspaces are pinned, so an anchor across the pin
    // boundary parks the target at the nearest edge of its own group rather
    // than crossing it. Without this the row would visibly cross and then
    // snap back on the unary echo.
    const moved = reorderByRegion(insertIdBefore(localOrder, workspaceId, beforeWorkspaceId), pinned)
    this.installOrder(moved, moved.filter(id => pinned.has(id)))
    const result = await this.remote.insertBefore({
      workspaceId,
      ...beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId },
    })
    if (requestGeneration === this.orderRequestGeneration
      && frameGeneration === this.orderFrameGeneration) {
      this.installOrder(
        result.ok ? result.value.workspaceIds : this.committedOrder,
        result.ok ? result.value.pinnedWorkspaceIds : this.committedPinned,
        result.ok,
      )
    }
    return result
  }

  /**
   * Pin one Workspace to the top of the list, or release it, and install the
   * returned order. Not optimistic: like every other Workspace mutation but
   * reordering, the Host is a local process and the authoritative order is
   * both cheaper to trust and simpler than a second implementation of the
   * pin boundary on the client.
   * @param workspaceId - Workspace whose pin changes.
   * @param pinned - requested pin state.
   * @returns generated Remote result.
   */
  async setPinned(
    workspaceId: WorkspaceSetPinnedRequest['workspaceId'],
    pinned: boolean,
  ): Promise<RemoteResult<WorkspaceOrderValue>> {
    const requestGeneration = ++this.orderRequestGeneration
    const frameGeneration = this.orderFrameGeneration
    const result = await this.remote.setPinned({ workspaceId, pinned })
    if (requestGeneration === this.orderRequestGeneration
      && frameGeneration === this.orderFrameGeneration) {
      this.installOrder(
        result.ok ? result.value.workspaceIds : this.committedOrder,
        result.ok ? result.value.pinnedWorkspaceIds : this.committedPinned,
        result.ok,
      )
    }
    return result
  }

  /**
   * Move a Session within its Workspace and merge the returned row.
   * @param workspaceId - owning Workspace.
   * @param sessionId - accounted Session to move.
   * @param beforeSessionId - accounted anchor; omitted appends.
   * @returns generated Remote result.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceInsertSessionBeforeRequest['workspaceId'],
    sessionId: WorkspaceInsertSessionBeforeRequest['sessionId'],
    beforeSessionId?: WorkspaceInsertSessionBeforeRequest['beforeSessionId'],
  ): Promise<RemoteResult<WorkspaceValue>> {
    const result = await this.remote.insertSessionBefore({
      workspaceId,
      sessionId,
      ...beforeSessionId === undefined ? {} : { beforeSessionId },
    })
    if (result.ok) this.upsert(result.value.workspace)
    return result
  }

  /**
   * Archive one Session and install the returned complete archive set.
   * @param sessionId - Session to archive.
   * @returns generated Remote result.
   */
  async archiveSession(
    sessionId: WorkspaceArchiveSessionRequest['sessionId'],
  ): Promise<RemoteResult<WorkspaceArchiveValue>> {
    const result = await this.remote.archiveSession({ sessionId })
    if (result.ok) this.installArchived(result.value.archivedSessionIds)
    return result
  }

  /**
   * Pin one Session to the head of the group that owns it, or release it, and
   * install the returned set. Not optimistic: like archiving, the Host is a
   * local process and the committed set is what every surface re-derives from.
   * @param sessionId - Session whose pin changes.
   * @param pinned - requested pin state.
   * @returns generated Remote result.
   */
  async setSessionPinned(
    sessionId: WorkspaceSetSessionPinnedRequest['sessionId'],
    pinned: boolean,
  ): Promise<RemoteResult<WorkspacePinSessionValue>> {
    const result = await this.remote.setSessionPinned({ sessionId, pinned })
    if (result.ok) this.installPinnedSessions(result.value.pinnedSessionIds)
    return result
  }

  /**
   * Replace the projection from one complete stream-generation baseline.
   * @param baseline - complete Workspace and archive projection.
   */
  replaceBaseline(baseline: WorkspaceBaseline): void {
    this.orderFrameGeneration++
    this.installViews(baseline.items)
    this.installArchived(baseline.archivedSessionIds)
    this.installPinnedSessions(baseline.pinnedSessionIds)
    this.installPinned(baseline.pinnedWorkspaceIds)
    this.state = 'idle'
    this.phase = 'ready'
    this.error = null
    this.invalidate()
  }

  /** Merge one decoded Workspace upsert from the current follow generation. */
  upsertView(workspace: WorkspaceView): void {
    this.upsert(workspace)
  }

  /** Apply one decoded Workspace removal from the current follow generation. */
  removeView(workspaceId: WorkspaceId): void {
    this.remove(workspaceId)
  }

  /**
   * Replace Host-confirmed order and pinned prefix from the current follow generation.
   * @param workspaceIds - complete Host-confirmed display order.
   * @param pinnedWorkspaceIds - pinned prefix of that order.
   */
  replaceOrder(workspaceIds: readonly WorkspaceId[], pinnedWorkspaceIds: readonly WorkspaceId[]): void {
    this.orderFrameGeneration++
    this.installOrder(workspaceIds, pinnedWorkspaceIds, true)
  }

  /**
   * Replace the archived Session set from the current follow generation.
   * @param archivedSessionIds - complete Host-confirmed archive set.
   */
  replaceArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    this.installArchived(archivedSessionIds)
  }

  /**
   * Replace the pinned Session set from the current follow generation.
   * @param pinnedSessionIds - complete Host-confirmed pin set.
   */
  replacePinned(pinnedSessionIds: WorkspacePinSessionValue['pinnedSessionIds']): void {
    this.installPinnedSessions(pinnedSessionIds)
  }

  /** Keep the last complete projection visible while a lost carrier reconnects. */
  handleCarrierFailure(): void {
    this.state = 'loading'
    this.error = null
    this.invalidate()
  }

  /**
   * Publish a non-retryable stream or protocol failure.
   * @param error - terminal stream failure.
   */
  handleStreamFailure(error: unknown): void {
    if (!isRemoteFailure(error)) throw error
    this.state = 'error'
    this.error = error
    this.invalidate()
  }

  /**
   * Subscribe to Workspace state invalidation.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the cached state, rebuilding it first when necessary.
   * @returns the current stable Workspace list snapshot.
   */
  getSnapshot(): WorkspaceSnapshot {
    this.refreshSnapshot()
    return this.snapshotCache
  }

  private buildSnapshot(): WorkspaceSnapshot {
    return {
      items: this.items,
      archivedSessionIds: this.archivedSessionIds,
      pinnedWorkspaceIds: this.pinnedWorkspaceIds,
      pinnedSessionIds: this.pinnedSessionIds,
      state: this.state,
      phase: this.phase,
      error: this.error,
    }
  }

  private installPinnedSessions(pinnedSessionIds: WorkspacePinSessionValue['pinnedSessionIds']): void {
    if (pinnedSessionIds.length === this.pinnedSessionIds.length
      && pinnedSessionIds.every((id, index) => id === this.pinnedSessionIds[index])) return
    this.pinnedSessionIds = [...pinnedSessionIds]
    this.invalidate()
  }

  private installArchived(archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds']): void {
    if (archivedSessionIds.length === this.archivedSessionIds.length
      && archivedSessionIds.every((id, index) => id === this.archivedSessionIds[index])) return
    this.archivedSessionIds = [...archivedSessionIds]
    this.invalidate()
  }

  private installPinned(pinnedWorkspaceIds: readonly WorkspaceId[]): void {
    if (sameIds(pinnedWorkspaceIds, this.pinnedWorkspaceIds)) return
    this.pinnedWorkspaceIds = [...pinnedWorkspaceIds]
    this.invalidate()
  }

  private installOrder(
    workspaceIds: readonly WorkspaceId[],
    pinnedWorkspaceIds: readonly WorkspaceId[],
    committed = false,
  ): void {
    if (committed) {
      this.committedOrder = [...workspaceIds]
      this.committedPinned = [...pinnedWorkspaceIds]
    }
    this.installPinned(pinnedWorkspaceIds)
    const rank = new Map(workspaceIds.map((id, index) => [id, index]))
    const items = [...this.items].sort((left, right) =>
      (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER))
    if (items.every((item, index) => item === this.items[index])) return
    this.items = items
    this.invalidate()
  }

  private upsert(view: WorkspaceView): void {
    if (this.removedIds.has(view.workspaceId)) return
    const index = this.items.findIndex(item => item.workspaceId === view.workspaceId)
    const installed = this.items[index]
    // Unary responses and stream increments race on separate requests. Keep
    // the newest Host projection regardless of their arrival order.
    if (installed !== undefined && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) return
    if (index === -1) {
      // A workspace that arrives outside the order frames (a unary create echo)
      // still belongs below the pinned group: it has never been pinned, and the
      // Host's own order frame will confirm the same slot.
      const at = this.pinBoundary()
      this.items = [...this.items.slice(0, at), view, ...this.items.slice(at)]
      if (!this.committedOrder.includes(view.workspaceId)) {
        this.committedOrder = [
          ...this.committedOrder.slice(0, at),
          view.workspaceId,
          ...this.committedOrder.slice(at),
        ]
      }
    } else {
      this.items = this.items.map((item, position) => position === index ? view : item)
    }
    this.invalidate()
  }

  /** Index of the first unpinned row: where a never-pinned Workspace belongs. */
  private pinBoundary(): number {
    const pinned = new Set(this.pinnedWorkspaceIds)
    const at = this.items.findIndex(item => !pinned.has(item.workspaceId))
    return at === -1 ? this.items.length : at
  }

  private remove(workspaceId: WorkspaceId, immediate = false): void {
    this.removedIds.add(workspaceId)
    this.committedOrder = this.committedOrder.filter(id => id !== workspaceId)
    this.installPinned(this.pinnedWorkspaceIds.filter(id => id !== workspaceId))
    const items = this.items.filter(item => item.workspaceId !== workspaceId)
    if (items.length === this.items.length) {
      // A successful unary echo still publishes an earlier increment's
      // pending removal before the user operation resolves.
      if (immediate) this.invalidate(true)
      return
    }
    this.items = items
    this.invalidate(immediate)
  }

  private installViews(views: readonly WorkspaceView[]): void {
    const installed = new Map<WorkspaceId, WorkspaceView>()
    for (const view of views) {
      if (!this.removedIds.has(view.workspaceId)) installed.set(view.workspaceId, view)
    }
    this.items = [...installed.values()]
    this.committedOrder = views.map(view => view.workspaceId)
  }

  private invalidate(immediate = false): void {
    this.snapshotDirty = true
    this.notificationPending = true
    if (immediate) {
      this.notificationGeneration++
      this.notificationScheduled = false
      this.flush()
      return
    }
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    const generation = ++this.notificationGeneration
    queueMicrotask(() => {
      if (generation !== this.notificationGeneration) return
      this.notificationScheduled = false
      this.flush()
    })
  }

  private flush(): void {
    if (!this.notificationPending || this.listeners.size === 0) return
    this.notificationPending = false
    this.refreshSnapshot()
    notifySubscribers(this.listeners, '[workspace-controller]')
  }

  private refreshSnapshot(): void {
    if (!this.snapshotDirty) return
    this.snapshotDirty = false
    this.snapshotCache = this.buildSnapshot()
  }
}

function insertIdBefore(
  ids: readonly WorkspaceId[],
  id: WorkspaceId,
  beforeId?: WorkspaceId,
): WorkspaceId[] {
  if (!ids.includes(id) || (beforeId !== undefined && !ids.includes(beforeId)) || beforeId === id) {
    return [...ids]
  }
  const without = ids.filter(candidate => candidate !== id)
  const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
  return [...without.slice(0, at), id, ...without.slice(at)]
}

/**
 * Re-split one order so every pinned id precedes every unpinned one, keeping
 * each group's relative order. Membership is read from `pinned`, so a move can
 * never add or drop a pin — an anchor on the far side of the boundary parks the
 * moved id at the near edge of its own group, which is what the Host commits.
 */
function reorderByRegion(ids: readonly WorkspaceId[], pinned: ReadonlySet<WorkspaceId>): WorkspaceId[] {
  return [
    ...ids.filter(id => pinned.has(id)),
    ...ids.filter(id => !pinned.has(id)),
  ]
}

function sameIds(left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}
