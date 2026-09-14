/**
 * 会话首页「样例」目录（输入框下方那块可换一批的案例区）。
 *
 * 数据由 host 企业插件写入 `dsh-enterprise` 设置节（`examples` 字段），来源是
 * 企业管理台「首页配置 → 首页样例配置」。样例图以 data URL 下发——桌面端渲染的
 * 是普通 `<img>`，带不上设备令牌，走 data URL 就没有第二个鉴权面。
 *
 * 这里**没有**内置默认样例：样例是管理员自己上传的内容，平台上没有就是没有，
 * 客户端不替他编一批出来（与首页 tab 的内置默认目录语义不同）。
 */

/** 样例的一条「相关产物」 */
export interface HomeExampleArtifact {
  readonly label: string
  readonly note?: string
}

/** 一个首页样例 */
export interface HomeExample {
  readonly id: string
  readonly label: string
  /** 一句话说明（卡片副标题与详情顶部） */
  readonly summary: string
  /** 「做同款」填进输入框的提示词 */
  readonly prompt: string
  /** 关联的技能名；缺省表示只填提示词 */
  readonly skill: string | null
  /** 样例图（data URL） */
  readonly image: string
  readonly artifacts: readonly HomeExampleArtifact[]
  readonly order: number
}

/**
 * 点击「做同款」后填进输入框的文本。
 *
 * 与首页二级 tab 同一条规则：关联技能时统一走 `/技能名 [提示词]`——
 * 它是桌面端唯一被识别的用户显式技能调用形式。
 * @param example - 被操作的样例。
 * @returns 填入输入框的草稿文本。
 */
export function exampleDraft(example: Pick<HomeExample, 'skill' | 'prompt'>): string {
  const prompt = example.prompt.trim()
  if (example.skill === null || example.skill === '') return prompt
  return prompt === '' ? `/${example.skill}` : `/${example.skill} ${prompt}`
}

/**
 * 宽松解码服务端下发的样例：结构不对整表丢弃，单项畸形只剔除该项。
 * @param value - 设置节里的 `examples` 字段。
 * @returns 样例列表（可能为空）；按 order 稳定排序。
 */
export function decodeExamples(value: unknown): readonly HomeExample[] {
  if (!Array.isArray(value)) return []
  const examples: HomeExample[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const {
      id, label, summary, prompt, skill, image, artifacts, order,
    } = entry as {
      id?: unknown
      label?: unknown
      summary?: unknown
      prompt?: unknown
      skill?: unknown
      image?: unknown
      artifacts?: unknown
      order?: unknown
    }
    if (typeof id !== 'string' || id === '') continue
    if (typeof label !== 'string' || label === '') continue
    // 没有样例图就没有卡片可点（详情是「左预览图 + 右详情」的形态）
    if (typeof image !== 'string' || image === '') continue
    examples.push({
      id,
      label,
      summary: typeof summary === 'string' ? summary : '',
      prompt: typeof prompt === 'string' ? prompt : '',
      skill: typeof skill === 'string' && skill !== '' ? skill : null,
      image,
      artifacts: decodeArtifacts(artifacts),
      order: typeof order === 'number' && Number.isFinite(order) ? order : 0,
    })
  }
  return examples.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
}

/** 相关产物：没有标签的条目直接丢掉（它们在详情里只是一行没有文字的图标） */
function decodeArtifacts(value: unknown): readonly HomeExampleArtifact[] {
  if (!Array.isArray(value)) return []
  const out: HomeExampleArtifact[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { label, note } = entry as { label?: unknown; note?: unknown }
    if (typeof label !== 'string' || label === '') continue
    out.push(typeof note === 'string' && note !== '' ? { label, note } : { label })
  }
  return out
}
