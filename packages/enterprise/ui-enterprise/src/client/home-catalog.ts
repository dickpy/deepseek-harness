/**
 * 会话首页目录（一级 tab 模块 + 二级 tab 快捷操作）。
 *
 * 目录数据由 host 企业插件写入 `dsh-enterprise` 设置节（`home` 字段），来源是
 * 企业管理台「首页配置」——一级/二级 tab 与可见角色都在平台上配置与过滤；
 * 服务端未下发时回退到这份内置默认目录。
 */

/**
 * 一个二级 tab：点击后把 `draft` 文本填进输入框的快捷操作。
 *
 * `skill` 是技能广场里已下发的技能标识。绑定技能时点击会产生 `/<skill>` 这个
 * 显式技能调用手势（dsh 的 tool-skill 按空白分隔的 `/name` 词元识别），
 * 后接 `prompt` 作为这次调用的具体要求。
 */
export interface HomeAction {
  readonly id: string
  readonly label: string
  /** 绑定的技能名；缺省表示只填预设指令 */
  readonly skill?: string
  /** 预设指令：填进输入框、用户可继续补充的种子文本 */
  readonly prompt?: string
}

/** 一个一级 tab（模块）。 */
export interface HomeCategory {
  readonly id: string
  readonly label: string
  readonly actions: readonly HomeAction[]
}

export type EnterpriseHome = readonly HomeCategory[]

/**
 * 点击二级 tab 后填进输入框的文本。
 *
 * 绑定技能时统一走 `/技能名 [预设指令]` 这一条规则：它是桌面端唯一被识别的
 * 用户显式技能调用形式，且用户可以在指令后面继续补话、加附件。
 * @param action - 被点击的二级 tab。
 * @returns 填入输入框的草稿文本。
 */
export function actionDraft(action: HomeAction): string {
  const prompt = action.prompt?.trim() ?? ''
  if (action.skill === undefined) return prompt !== '' ? prompt : action.label
  return prompt === '' ? `/${action.skill}` : `/${action.skill} ${prompt}`
}

/** 服务端未下发目录时的内置默认：只填预设指令，不绑技能（平台上未必有这些技能）。 */
export const DEFAULT_HOME: EnterpriseHome = [
  {
    id: 'general',
    label: '通用助手',
    actions: [
      {
        id: 'docs',
        label: '文档处理',
        prompt: '帮我整理并润色这份文档：',
      },
      {
        id: 'analysis',
        label: '数据分析及可视化',
        prompt: '帮我分析这组数据，给出结论和可视化建议：',
      },
      {
        id: 'research',
        label: '深度研究',
        prompt: '请深入研究以下主题，并给出结构化报告：',
      },
      {
        id: 'minutes',
        label: '会议纪要',
        prompt: '帮我把以下会议记录整理成纪要：',
      },
    ],
  },
  {
    id: 'eam',
    label: 'EAM 设备管理',
    actions: [
      {
        id: 'eam-query',
        label: '数据查询',
        prompt: '查询最近的设备维修工单，并按状态汇总：',
      },
      {
        id: 'eam-analysis',
        label: '数据分析',
        prompt: '分析本月设备故障率趋势，给出结论：',
      },
      {
        id: 'eam-order',
        label: '工单处理',
        prompt: '帮我创建一张设备维修工单：',
      },
      {
        id: 'eam-spare',
        label: '备件查询',
        prompt: '查询以下备件的库存与供应商信息：',
      },
    ],
  },
  {
    id: 'qms',
    label: 'QMS 质量管理',
    actions: [
      {
        id: 'qms-iqc',
        label: '检验记录查询',
        prompt: '查询最近的来料检验记录：',
      },
      {
        id: 'qms-spc',
        label: 'SPC 分析',
        prompt: '对这批关键尺寸数据做 SPC 分析：',
      },
      {
        id: 'qms-ncr',
        label: '不合格评审',
        prompt: '帮我起草一份不合格品评审报告：',
      },
    ],
  },
]

/**
 * 宽松校验服务端下发的目录：结构不对整表丢弃，单项畸形只剔除该项。
 *
 * 返回 `null` 表示「这份目录里没有任何能显示的内容」——调用方据此关闭首页目录；
 * 是否回退到内置默认由「平台上有没有配置过首页目录」决定（见 enterprise-store
 * 的 `home: EnterpriseHome | null`），不在这里判断。
 * @param value - 设置节里的 `home` 字段。
 * @returns 可用的一级 tab 列表；无可显示内容时为 `null`。
 */
export function decodeHome(value: unknown): EnterpriseHome | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const categories: HomeCategory[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, label, actions } = entry as {
      id?: unknown
      label?: unknown
      actions?: unknown
    }
    if (typeof id !== 'string' || id === '' || typeof label !== 'string' || label === '') continue
    if (!Array.isArray(actions)) continue
    const decodedActions: HomeAction[] = []
    for (const action of actions) {
      if (typeof action !== 'object' || action === null) continue
      const {
        id: actionId, label: actionLabel, skill, prompt,
      } = action as {
        id?: unknown
        label?: unknown
        skill?: unknown
        prompt?: unknown
      }
      if (typeof actionId !== 'string' || actionId === '') continue
      if (typeof actionLabel !== 'string' || actionLabel === '') continue
      decodedActions.push({
        id: actionId,
        label: actionLabel,
        ...typeof skill === 'string' && skill !== '' ? { skill } : {},
        ...typeof prompt === 'string' && prompt !== '' ? { prompt } : {},
      })
    }
    if (decodedActions.length === 0) continue
    categories.push({ id, label, actions: decodedActions })
  }
  return categories.length > 0 ? categories : null
}
