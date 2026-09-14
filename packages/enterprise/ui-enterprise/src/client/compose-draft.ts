/**
 * 「试一试」：带着某个技能开一段新对话。
 *
 * 技能广场的每张卡片都有一个「试一试」入口，点它要做三件事：
 *  1. 端上存在会话/工作区选择，先回到对话面板（技能广场占的是主区域）；
 *  2. 复用或新建当前（否则最近一个）工作区的空白会话；
 *  3. 把 `/技能名` 这个显式技能调用手势写进该会话的输入框草稿。
 *
 * 草稿只在输入框里、不自动发送：用户可以继续补充要求、加附件，再自己按发送。
 * 技能调用手势是 dsh 的 tool-skill 按空白分隔的 `/name` 词元识别的，
 * 所以这里只负责把文本填进去，不自己解析技能。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * 开新对话所需的导航面（ui-workspace 的服务）。按结构消费，避免为一个
 * 服务类型新增包边界。
 */
interface WorkspaceNavigation {
  /** 开始「新会话」流程并导航过去。 */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * 连接工作区并打开它的会话。
   * @param workspaceId - 目标工作区。
   * @param beforeOpen - 会话选定后的同步准备动作。
   * @returns 打开完成；被后续导航取代时不打开。
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
}

/**
 * 取「当前会话所属工作区」，没有当前会话时取最近使用的工作区。
 * 与侧边栏「新会话」的取值规则一致（ui-workspace 的 recentWorkspace）。
 * @param workspaces - 工作区列表。
 * @param sessions - 会话快照（current 与 byId）。
 * @returns 目标工作区 id；没有任何工作区时为 undefined。
 */
function targetWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState,
): WorkspaceId | undefined {
  const current = sessions.current
  const currentWorkspace = current === undefined
    ? undefined
    : workspaces.find(item => item.sessionIds.includes(current))?.workspaceId
  if (currentWorkspace !== undefined) return currentWorkspace
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions.byId[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

/**
 * 带一段草稿开新对话。
 * @param ctx - 客户端根上下文（需要 sessions / workspace UI / 对话输入注册表）。
 * @param draft - 填进输入框的文本，如 `/doc-polish`。
 * @returns 完成后 resolve；失败时打印告警并保持当前视图不变。
 */
export async function composeDraft(ctx: ClientContext, draft: string): Promise<void> {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const navigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  const conversation = ctx.get('conversation') as IConversation | undefined
  ctx.layout.selectPanel(null)
  const list = workspaces.list.getSnapshot()
  if (list.phase !== 'ready' || conversation === undefined) {
    navigation.startSession()
    return
  }
  const target = targetWorkspace(list.items, sessions.list.getSnapshot())
  if (target === undefined) {
    navigation.startSession()
    return
  }
  await navigation.openWorkspace(target, (sessionId) => {
    conversation.seedDraft(sessionId, draft)
  })
}
