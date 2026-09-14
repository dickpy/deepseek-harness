/**
 * 企业门禁（fork 补丁）：桌面端启动的硬登录关卡。
 *
 * 职责：
 *  1. 企业独立数据目录：设置 DSH_HOME 指向应用私有目录，与用户自装的官方 dsh 完全隔离
 *  2. 登录门禁：无有效会话时显示登录窗，凭据调企业管理台 /client/enroll 换设备令牌，
 *     登录成功前不启动 dsh 后端（不登录不能用）；登录窗被直接关闭则退出应用
 *  3. 凭据注入：把企业服务器地址与设备令牌写入进程环境，dsh host 子进程继承，
 *     企业插件（@deepseek-ai/dsh-plugin-enterprise）经 credentials 的继承环境层直接命中
 *
 * 环境配置来源（打包时烘进 resources/enterprise.json，运行时 env 兜底）：
 *   default + environments: [{ key, label, url }] —— 普通用户锁定 default 指向的唯一通道，
 *   登录窗只在内部模式（DSH_ENTERPRISE_INTERNAL=1）显示切换下拉。
 *   清单结构或地址非法时抛错，绝不静默退化成「无通道」——那会跳过整个门禁。
 *   清单缺失时回落到 DSH_ENTERPRISE_SERVER_URL / DSH_ENTERPRISE_TEST_SERVER_URL（仅开发模式）。
 *
 * 离线策略：本机有已保存会话但服务器不可达时放行（记警告），
 * 企业插件侧仍以本地缓存/环境变量工作。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, safeStorage, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

import {
  assertLoginSender,
  LOGIN_PAGE_URL,
  manifestFromEnvironment,
  parseEnterpriseManifest,
  resolveEnterpriseChannel,
  type EnterpriseEnvironment,
  type EnterpriseManifest,
} from './enterprise-environments.ts'

/** 登录页可选通道；保留旧名以免破坏 fork 内既有引用。 */
export type EnvironmentOption = EnterpriseEnvironment

export interface EnterpriseUser {
  readonly email: string
  readonly name: string
  readonly role: string | null
}

export interface EnterpriseSession {
  readonly serverUrl: string
  readonly token: string
  readonly user: EnterpriseUser
  readonly menus: string[] | null
}

export interface LoginContext {
  readonly environments: readonly EnvironmentOption[]
  readonly defaultUrl: string
  readonly savedEmail: string
  readonly appName: string
  /** 内部模式才显示环境切换（普通用户锁定默认环境） */
  readonly internal: boolean
}

interface LoginSubmit {
  readonly serverUrl: string
  readonly email: string
  readonly password: string
}

interface StoredSession {
  serverUrl: string
  tokenEnc: string | null
  tokenPlain: string | null
  user: EnterpriseUser
  menus: string[] | null
  savedAt: string
}

const REQUEST_TIMEOUT_MS = 20_000
/** 登录成功到渲染层播完动效之间的兜底时长；渲染层不回调时也会放行启动。 */
const LOGIN_SUCCESS_ANIMATION_TIMEOUT_MS = 2_500

function gateDir(): string {
  return join(app.getPath('userData'), 'enterprise')
}

/**
 * 内部模式解锁：DSH_ENTERPRISE_INTERNAL=1 或 userData/enterprise/internal 文件存在。
 * 仅影响登录窗是否显示环境下拉，普通用户始终锁定默认（生产）环境。
 */
function internalUnlocked(env: NodeJS.ProcessEnv): boolean {
  if (env.DSH_ENTERPRISE_INTERNAL === '1') return true
  try {
    return readFileSync(join(gateDir(), 'internal'), 'utf8') !== undefined
  } catch {
    return false
  }
}

function sessionFile(): string {
  return join(gateDir(), 'session.json')
}

/**
 * 读取打包烘进 resources/enterprise.json 的通道清单。
 * @param env - 进程环境，无清单文件时用于运行时兜底。
 * @returns 已校验的清单；未配置任何通道时为 null。
 * @throws 清单文件存在但结构或地址非法时抛出，绝不静默跳过门禁。
 */
export function readEnterpriseManifest(env: NodeJS.ProcessEnv): EnterpriseManifest | null {
  const manifestPath = app.isPackaged
    ? join(process.resourcesPath, 'enterprise.json')
    : join(app.getAppPath(), 'enterprise.json')
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  }
  catch {
    // 无清单文件（非企业部署或开发模式）：回落到运行时环境变量
    return manifestFromEnvironment(env)
  }
  return parseEnterpriseManifest(text)
}

function encryptToken(token: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  return safeStorage.encryptString(token).toString('base64')
}

function decryptStoredToken(stored: StoredSession): string | null {
  if (stored.tokenEnc !== null) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.tokenEnc, 'base64'))
    } catch {
      return null
    }
  }
  return stored.tokenPlain
}

function readStoredSession(): StoredSession | null {
  try {
    return JSON.parse(readFileSync(sessionFile(), 'utf8')) as StoredSession
  } catch {
    return null
  }
}

function loadStoredSession(): StoredSession | null {
  const parsed = readStoredSession()
  if (parsed === null || typeof parsed.serverUrl !== 'string' || parsed.serverUrl === '') return null
  if (decryptStoredToken(parsed) === null) return null
  return parsed
}

function saveSession(session: EnterpriseSession): void {
  mkdirSync(gateDir(), { recursive: true })
  const tokenEnc = encryptToken(session.token)
  const stored: StoredSession = {
    serverUrl: session.serverUrl,
    tokenEnc,
    tokenPlain: tokenEnc === null ? session.token : null,
    user: session.user,
    menus: session.menus,
    savedAt: new Date().toISOString(),
  }
  writeFileSync(sessionFile(), JSON.stringify(stored, undefined, 2), { mode: 0o600 })
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const json = (await res.json().catch(() => ({}))) as T & { message?: string }
  if (!res.ok) {
    const error = new Error(json.message ?? res.statusText) as Error & { status?: number }
    error.status = res.status
    throw error
  }
  return json
}

/** 校验已存令牌；失效返回 {ok:false,offline:false}，服务器不可达返回 {ok:false,offline:true} */
async function validateSession(
  serverUrl: string,
  token: string,
): Promise<{ ok: true; user: EnterpriseUser; menus: string[] | null } | { ok: false; offline: boolean }> {
  try {
    const config = await request<{ user?: EnterpriseUser; menus?: string[] | null }>(
      `${serverUrl.replace(/\/$/, '')}/client/config`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    return {
      ok: true,
      user: config.user ?? { email: '', name: '', role: null },
      menus: config.menus ?? null,
    }
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 401 || status === 403) return { ok: false, offline: false }
    return { ok: false, offline: true }
  }
}

/** 企业凭据注册设备，返回会话 */
export async function enrollDevice(
  serverUrl: string,
  email: string,
  password: string,
): Promise<EnterpriseSession> {
  const os = await import('node:os')
  const result = await request<{ deviceToken: string; config: { user?: EnterpriseUser; menus?: string[] | null } }>(
    `${serverUrl.replace(/\/$/, '')}/client/enroll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, deviceName: os.hostname(), platform: process.platform }),
    },
  )
  return {
    serverUrl,
    token: result.deviceToken,
    user: result.config.user ?? { email, name: email, role: null },
    menus: result.config.menus ?? null,
  }
}

/** 把企业会话应用到进程环境（dsh host 子进程继承；企业插件直接命中） */
export function applySessionEnvironment(app: Electron.App, session: EnterpriseSession): void {
  // 企业版独立数据目录：与用户自装的官方 dsh（默认 ~/.dsh）完全隔离
  const enterpriseHome = join(app.getPath('userData'), 'dsh-home')
  mkdirSync(enterpriseHome, { recursive: true })
  process.env.DSH_HOME = enterpriseHome
  process.env.DSH_ENTERPRISE_SERVER_URL = session.serverUrl
  process.env.DSH_ENTERPRISE_DEVICE_TOKEN = session.token
}

/** 门禁是否启用：打包应用默认启用；开发模式需 DSH_ENTERPRISE_GATE=1 显式开启，=0 强制关闭 */
export function gateEnabled(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  if (env.DSH_ENTERPRISE_GATE === '0') return false
  if (isPackaged) return true
  return env.DSH_ENTERPRISE_GATE === '1'
}

/**
 * 清除本机会话并保留登录预填信息。
 *  - logout：保留邮箱预填（用户大概率重登同一账号）；
 *  - switch：连邮箱一起清掉，登录窗留空等待另一个账号。
 * 两种模式都只清令牌，不落「已失效」状态——重启后门禁直接进登录窗。
 */
export function clearEnterpriseSession(mode: 'logout' | 'switch'): void {
  const email = mode === 'logout' ? readStoredSession()?.user.email ?? '' : ''
  mkdirSync(gateDir(), { recursive: true })
  const stored: StoredSession = {
    serverUrl: '',
    tokenEnc: null,
    tokenPlain: null,
    user: { email, name: '', role: null },
    menus: null,
    savedAt: new Date().toISOString(),
  }
  writeFileSync(sessionFile(), JSON.stringify(stored, undefined, 2), { mode: 0o600 })
}

export interface GateDeps {
  readonly app: Electron.App
  readonly env: NodeJS.ProcessEnv
  readonly isPackaged: boolean
  readonly warn: (message: string) => void
  /** 创建壳自有窗口（含 preload），供登录窗使用 */
  readonly createWindow: () => BrowserWindow
  readonly windowTitle: string
  /** 登录卡展示的品牌名；asar 内 package.json 无 productName，app.getName() 会读到 scoped 包名 */
  readonly appName: string
}

/** 显示登录窗直到登录成功；用户直接关闭窗口返回 null（调用方应退出应用） */
function showLoginWindowUntilSuccess(
  deps: GateDeps,
  context: LoginContext,
): Promise<EnterpriseSession | null> {
  return new Promise((resolve) => {
    let settled = false
    let pending: EnterpriseSession | null = null
    let animationTimer: NodeJS.Timeout | undefined
    const channel = 'dsh-desktop:enterprise-login-submit'
    const contextChannel = 'dsh-desktop:enterprise-login-context'
    const completeChannel = 'dsh-desktop:enterprise-login-complete'
    const win = deps.createWindow()
    win.setTitle(deps.windowTitle)
    // 令牌已落盘后先放行渲染层播成功动效，再由渲染层回调关闭；不回调时由计时器兜底。
    const finish = (): void => {
      if (settled || pending === null) return
      settled = true
      clearTimeout(animationTimer)
      const session = pending
      pending = null
      resolve(session)
      if (!win.isDestroyed()) win.close()
    }
    ipcMain.handle(contextChannel, (event: IpcMainInvokeEvent): LoginContext => {
      assertLoginSender(event)
      return context
    })

    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown): Promise<{ ok: boolean; message?: string }> => {
      assertLoginSender(event)
      const submit = payload as LoginSubmit
      if (typeof submit?.serverUrl !== 'string' || typeof submit?.email !== 'string' || typeof submit?.password !== 'string') {
        return { ok: false, message: 'invalid login payload' }
      }
      try {
        const session = await enrollDevice(submit.serverUrl, submit.email, submit.password)
        saveSession(session)
        pending = session
        animationTimer = setTimeout(finish, LOGIN_SUCCESS_ANIMATION_TIMEOUT_MS)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
    ipcMain.handle(completeChannel, (event: IpcMainInvokeEvent): void => {
      assertLoginSender(event)
      finish()
    })

    void win.loadURL(LOGIN_PAGE_URL).catch((error: unknown) => { console.error(error) })
    win.once('closed', () => {
      clearTimeout(animationTimer)
      ipcMain.removeHandler(channel)
      ipcMain.removeHandler(contextChannel)
      ipcMain.removeHandler(completeChannel)
      if (!settled) resolve(null)
    })
    win.once('ready-to-show', () => { win.show() })
  })
}

/** 门禁结果：session=已通过并注入环境；disabled=未启用；cancelled=用户关闭登录窗（应退出应用） */
export type EnterpriseGateResult =
  | { kind: 'session'; session: EnterpriseSession }
  | { kind: 'disabled' }
  | { kind: 'cancelled' }

/**
 * 执行企业门禁：确保存在有效会话，并把 DSH_HOME / 企业凭据写入进程环境。
 * 未配置任何通道且无已存会话时跳过（非企业部署向后兼容）。
 */
export async function ensureEnterpriseGate(deps: GateDeps): Promise<EnterpriseGateResult> {
  const manifest = readEnterpriseManifest(deps.env)
  const stored = loadStoredSession()

  if (stored !== null) {
    const token = decryptStoredToken(stored)
    if (token !== null) {
      const result = await validateSession(stored.serverUrl, token)
      const session: EnterpriseSession = {
        serverUrl: stored.serverUrl,
        token,
        user: result.ok ? result.user : stored.user,
        menus: result.ok ? result.menus : stored.menus,
      }
      if (!result.ok) {
        if (result.offline) {
          deps.warn('企业管理服务器不可达，以离线模式放行')
          applySessionEnvironment(deps.app, session)
          return { kind: 'session', session }
        }
        deps.warn('已保存的登录会话已失效，需要重新登录')
        // 令牌失效：清掉存储，落入登录窗流程
        try { writeFileSync(sessionFile(), '') } catch { /* ignore */ }
      } else {
        applySessionEnvironment(deps.app, session)
        return { kind: 'session', session }
      }
    }
  }

  if (manifest === null) return { kind: 'disabled' } // 非企业部署：不设门禁

  const channel = resolveEnterpriseChannel(manifest, deps.env.DSH_ENTERPRISE_ENVIRONMENT)
  const internal = internalUnlocked(deps.env)
  // 普通用户始终回到构建期锁定的通道，避免上一次登录把它粘在别的通道上；
  // 内部模式才沿用上次登录的通道（若仍在该构建的清单内）。
  const remembered = internal && stored !== null
    && channel.all.some(candidate => candidate.url === stored.serverUrl)
    ? stored.serverUrl
    : channel.locked.url

  while (true) {
    const session = await showLoginWindowUntilSuccess(deps, {
      environments: internal ? channel.all : [channel.locked],
      defaultUrl: remembered,
      // 退出登录后仍保留邮箱预填（readStoredSession 不要求令牌有效）
      savedEmail: readStoredSession()?.user.email ?? '',
      appName: deps.appName || deps.app.getName(),
      internal,
    })
    if (session === null) return { kind: 'cancelled' }
    applySessionEnvironment(deps.app, session)
    return { kind: 'session', session }
  }
}
