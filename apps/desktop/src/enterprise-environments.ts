/**
 * 企业登录通道解析（fork 补丁）：把打包烘入的 enterprise.json 收敛成普通用户锁定的单一通道。
 *
 * 普通用户只拿到 locked —— 登录页不渲染任何切换控件；内部模式（DSH_ENTERPRISE_INTERNAL=1）
 * 才拿到全部通道，用于在真实管理台上联调。通道选择在打包期由 DSH_ENTERPRISE_ENVIRONMENT
 * 写入清单的 default，运行时同名校验为最后一道兜底。
 *
 * 清单结构错误在解析时抛错：清单是构建期产物，写错地址必须立刻暴露，
 * 而不是静默退化成「没有通道」（那会让门禁被跳过）。
 */

/** 一个可登录的企业管理台通道。 */
export interface EnterpriseEnvironment {
  /** 清单内唯一的通道标识，供 DSH_ENTERPRISE_ENVIRONMENT 选择。 */
  readonly key: string
  /** 登录页展示的通道名，仅内部模式可见。 */
  readonly label: string
  /** 管理台 API 根地址，已去掉末尾斜杠且保证以 /api/v1 结尾。 */
  readonly url: string
}

/** enterprise.json 的解析结果。 */
export interface EnterpriseManifest {
  /** 清单声明的默认通道；缺省为 null，此时按通道顺序取第一个。 */
  readonly defaultKey: string | null
  /** 清单声明的全部通道，顺序即展示顺序。 */
  readonly environments: readonly EnterpriseEnvironment[]
}

/** 普通用户锁定的通道与内部模式可见的通道全集。 */
export interface EnterpriseChannelSet {
  /** 普通用户唯一可用的通道。 */
  readonly locked: EnterpriseEnvironment
  /** 内部模式可见的全部通道，顺序与清单一致。 */
  readonly all: readonly EnterpriseEnvironment[]
}

/** 客户端会在通道地址后拼接 /client/enroll 与 /client/config，路径前缀由服务端 globalPrefix 固定。 */
const API_SUFFIX = '/api/v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验并规范化一个通道地址。
 * @param value - 清单中声明的原始地址。
 * @param subject - 出错信息中定位该地址的字段路径。
 * @returns 去掉末尾斜杠、保留路径前缀的绝对地址。
 */
export function normalizeEnvironmentUrl(value: string, subject: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  }
  catch {
    throw new Error(`enterprise manifest: ${subject} must be an absolute URL, got ${JSON.stringify(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`enterprise manifest: ${subject} must use http or https, got ${JSON.stringify(value)}`)
  }
  const path = parsed.pathname.replace(/\/+$/u, '')
  if (!path.endsWith(API_SUFFIX)) {
    throw new Error(`enterprise manifest: ${subject} must end with ${API_SUFFIX} because the client appends /client/enroll, got ${JSON.stringify(value)}`)
  }
  return `${parsed.origin}${path}`
}

/**
 * 解析打包烘入的企业环境清单。
 * @param text - enterprise.json 的原始内容。
 * @returns 校验后的通道清单。
 * @throws 当清单不是合法 JSON、缺少通道、通道字段非法或默认通道不存在时抛出。
 */
export function parseEnterpriseManifest(text: string): EnterpriseManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    throw new Error('enterprise manifest: enterprise.json is not valid JSON')
  }
  if (!isRecord(raw)) throw new Error('enterprise manifest: enterprise.json must contain a JSON object')
  const entries = raw.environments
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('enterprise manifest: environments must be a non-empty array')
  }
  const environments: EnterpriseEnvironment[] = []
  const keys = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) throw new Error(`enterprise manifest: environments[${index}] must be an object`)
    const { label, url } = entry
    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error(`enterprise manifest: environments[${index}].label must be a non-empty string`)
    }
    if (typeof url !== 'string') {
      throw new Error(`enterprise manifest: environments[${index}].url must be a string`)
    }
    const key = typeof entry.key === 'string' && entry.key.trim() !== '' ? entry.key : `environment-${String(index + 1)}`
    if (keys.has(key)) throw new Error(`enterprise manifest: duplicate environment key ${JSON.stringify(key)}`)
    keys.add(key)
    environments.push({ key, label, url: normalizeEnvironmentUrl(url, `environments[${index}].url`) })
  }
  const defaultKey = typeof raw.default === 'string' && raw.default.trim() !== '' ? raw.default : null
  if (defaultKey !== null && !keys.has(defaultKey)) {
    throw new Error(`enterprise manifest: default ${JSON.stringify(defaultKey)} is not one of ${[...keys].join(', ')}`)
  }
  return { defaultKey, environments }
}

/**
 * 选择普通用户锁定的通道，并给出内部模式可见的通道全集。
 * @param manifest - 已解析的通道清单。
 * @param environment - DSH_ENTERPRISE_ENVIRONMENT 的取值，覆盖清单的 default。
 * @returns 锁定通道与全部通道。
 * @throws 当请求或默认的通道标识不在清单内时抛出。
 */
export function resolveEnterpriseChannel(manifest: EnterpriseManifest, environment?: string): EnterpriseChannelSet {
  const requested = environment?.trim()
  const lockedKey = requested !== undefined && requested !== '' ? requested : manifest.defaultKey
  const locked = lockedKey === null
    ? manifest.environments[0]
    : manifest.environments.find(candidate => candidate.key === lockedKey)
  if (locked === undefined) {
    throw new Error(`enterprise manifest: channel ${JSON.stringify(lockedKey)} is not one of ${manifest.environments.map(candidate => candidate.key).join(', ')}`)
  }
  return { locked, all: manifest.environments }
}

/**
 * 无清单文件时的运行时兜底通道（开发模式）。
 * @param env - 进程环境。
 * @returns 由 DSH_ENTERPRISE_SERVER_URL / DSH_ENTERPRISE_TEST_SERVER_URL 组成的清单；两者都缺失时为 null。
 */
export function manifestFromEnvironment(env: NodeJS.ProcessEnv): EnterpriseManifest | null {
  const entries: { key: string; label: string; url: string }[] = []
  if (env.DSH_ENTERPRISE_SERVER_URL !== undefined && env.DSH_ENTERPRISE_SERVER_URL !== '') {
    entries.push({ key: 'default', label: '默认', url: env.DSH_ENTERPRISE_SERVER_URL })
  }
  if (env.DSH_ENTERPRISE_TEST_SERVER_URL !== undefined && env.DSH_ENTERPRISE_TEST_SERVER_URL !== '') {
    entries.push({ key: 'test', label: '测试', url: env.DSH_ENTERPRISE_TEST_SERVER_URL })
  }
  if (entries.length === 0) return null
  return parseEnterpriseManifest(JSON.stringify({ environments: entries }))
}

/** 登录页在壳协议上的固定地址；登录窗加载与 IPC 发送方校验必须共用此常量。 */
export const LOGIN_PAGE_URL = 'dsh-app://shell/login.html'

/** 登录页 IPC 事件的最小结构（与 Electron IpcMainInvokeEvent 的发送方字段结构兼容）。 */
export interface LoginIpcSender {
  readonly senderFrame: { readonly url: string } | null
}

/**
 * 校验登录 IPC 确实来自壳协议上的登录页本身。
 * 登录页经 IPC 上送明文凭据，其他任何页面（包括 dsh-app://app 应用文档）都必须拒绝。
 */
export function assertLoginSender(event: LoginIpcSender): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== 'dsh-app:' || url.hostname !== 'shell' || url.pathname !== '/login.html') {
    throw new Error('rejected IPC from an unowned renderer')
  }
}
