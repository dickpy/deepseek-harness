import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

/**
 * The enterprise plugin's two client-facing bridges, driven through its real
 * `apply` entry with a fake Cordis context: the `dsh-enterprise` settings
 * section the browser half reads, and the skill bundle it writes to
 * `$DSH_HOME/skills`.
 *
 * `fetch` is the only stubbed boundary; the payloads below are the server
 * contract from `server/src/client/client.module.ts`.
 */

const HOME = [
  {
    id: 'general',
    label: '通用助手',
    actions: [
      { id: 'docs', label: '文档处理', skill: 'doc-polish', prompt: '帮我整理并润色这份文档：' },
      { id: 'minutes', label: '会议纪要', prompt: '帮我把以下会议记录整理成纪要：' },
    ],
  },
]

const SKILL_BUNDLE = {
  name: 'doc-polish',
  version: '1.2.0',
  content: '---\nname: doc-polish\ndescription: 整理并润色中文文档\n---\n\n正文说明。\n',
  files: [{ path: 'references/style.md', content: '文风约定：简体中文。', encoding: 'utf8' }],
}

/** 第二个技能：带二进制附属文件，验证 zip 导入的技能包按 base64 原样落盘 */
const BUNDLE_SKILL = {
  name: 'meeting-minutes',
  version: '2.0.0',
  content: '---\nname: meeting-minutes\ndescription: 整理会议记录\n---\n\n正文说明。\n',
  files: [
    { path: 'scripts/format.py', content: 'print("format")\n', encoding: 'utf8' },
    { path: 'assets/icon.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), encoding: 'base64' },
  ],
}

const CLOUD_CONFIG = {
  model: null,
  agents: [],
  plugins: [],
  user: { email: 'dev@company.com', name: '开发者', role: 'member' },
  menus: ['workspace.chat'],
  home: HOME,
  configRevision: 7,
  skills: [
    { name: 'doc-polish', displayName: '文档润色', description: '整理并润色', version: '1.2.0' },
    {
      name: 'meeting-minutes',
      displayName: '会议纪要',
      description: '整理会议记录',
      version: '2.0.0',
      kind: 'bundle',
      fileCount: 2,
    },
  ],
}

/** The published section as the browser half reads it. */
interface PublishedSection {
  user: { email: string; name: string; role: string }
  menus: string[]
  /**
   * 首页目录：字段缺省 = 平台没配置过（客户端用内置默认），
   * 空数组 = 管理员把 tab 删空了，有值 = 按配置渲染。
   */
  home?: { id: string; label: string; actions: { id: string; skill: string; prompt: string }[] }[]
  skills: {
    name: string
    displayName: string
    description: string
    version: string
    kind: string
    fileCount: number
    installed: boolean
  }[]
  configRevision: number
}

/** One registered settings namespace, as the real settings service hands it back. */
interface RegisteredNamespace {
  schema: (value?: unknown) => unknown
  base: unknown
  section: () => PublishedSection | undefined
}

function endpointOf(input: unknown): string {
  return new URL(String(input)).pathname
}

function createFakeContext() {
  const stored: Record<string, unknown> = {}
  const credentials = new Map<string, string>()
  const namespaces: Record<string, RegisteredNamespace> = {}

  const settings = {
    async update(ns: string, patch: object) {
      stored[ns] = { ...(stored[ns] as object ?? {}), ...patch }
    },
    get(ns: string) {
      return stored[ns]
    },
    register(ns: string, schema: (value?: unknown) => unknown, options?: { base?: unknown }) {
      namespaces[ns] = { schema, base: options?.base, section: () => stored[ns] as PublishedSection }
      return {
        async replace(section: object) {
          stored[ns] = schema(section)
        },
        async update(patch: object) {
          stored[ns] = schema({ ...(stored[ns] as object ?? {}), ...patch })
        },
        get: () => stored[ns],
      }
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    settings,
    credentials: {
      async resolve(ref: string) {
        return credentials.has(ref) ? { value: credentials.get(ref) } : undefined
      },
      async set(ref: string, value: string) {
        credentials.set(ref, value)
      },
    },
    inject(_names: string[], callback: (scoped: unknown) => void) {
      callback(ctx)
    },
    on() {},
    effect() {},
  }

  return { ctx, namespaces }
}

async function waitFor<T>(probe: () => T | undefined, attempts = 200): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
  throw new Error('timed out waiting for the plugin to publish')
}

async function startPlugin(overrides: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-enterprise-spec-'))
  process.env.DSH_HOME = home
  const fake = createFakeContext()
  const fetchMock = vi.fn(async (input: unknown) => {
    const path = endpointOf(input)
    if (path.endsWith('/client/enroll')) {
      return new Response(JSON.stringify({ deviceToken: 'dtk_spec', config: CLOUD_CONFIG }), { status: 201 })
    }
    if (path.endsWith('/client/config')) {
      return new Response(JSON.stringify(CLOUD_CONFIG), { status: 200 })
    }
    if (path.endsWith('/client/skills/doc-polish')) {
      return new Response(JSON.stringify(SKILL_BUNDLE), { status: 200 })
    }
    if (path.endsWith('/client/skills/meeting-minutes')) {
      return new Response(JSON.stringify(BUNDLE_SKILL), { status: 200 })
    }
    throw new Error(`unexpected request: ${String(input)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  apply(fake.ctx, {
    serverUrl: 'http://enterprise.test/api/v1',
    email: 'dev@company.com',
    password: 'Passw0rd!123',
    deviceName: 'spec',
    syncIntervalMs: 3600_000,
    telemetryEnabled: false,
    applyDefaultModel: false,
    // Only the skill test opts in: a sync in flight when the stub is removed
    // would reach the real network, so each test drives exactly one bridge.
    syncSkills: false,
    ...overrides,
  })

  // Registration publishes an empty section before the first sync resolves, so
  // wait for the synced identity rather than for the section to merely exist.
  const namespace = await waitFor(() => {
    const section = fake.namespaces['dsh-enterprise']?.section()
    return section?.user?.email === '' ? undefined : section
  })
  return { home, fetchMock, namespace, registered: fake.namespaces['dsh-enterprise'] as RegisteredNamespace }
}

describe('enterprise plugin client bridges', () => {
  const homes: string[] = []

  beforeEach(() => {
    homes.length = 0
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(homes.map(path => rm(path, { recursive: true, force: true })))
  })

  it('normalizes the published home catalog through the registered settings schema', async () => {
    const { home, registered } = await startPlugin()
    homes.push(home)

    // A home action's absent skill/prompt normalize to empty strings; the browser
    // half drops those while decoding, so an action without either stays label-only.
    const resolved = registered.schema({ ...registered.base as object, home: HOME }) as PublishedSection
    expect(resolved.home).toEqual([
      {
        id: 'general',
        label: '通用助手',
        actions: [
          { id: 'docs', label: '文档处理', skill: 'doc-polish', prompt: '帮我整理并润色这份文档：' },
          { id: 'minutes', label: '会议纪要', skill: '', prompt: '帮我把以下会议记录整理成纪要：' },
        ],
      },
    ])

    // 首页目录的三态必须在 schema 层就分得开：字段缺省 ≠ 空数组。
    // 缺省 = 平台没配置过（客户端回退内置默认），空数组 = 管理员删空了。
    // 这条约束靠 `z.array(...).default(undefined)` 保住：schemastery 对数组
    // schema 会默认物化 `[]`，只写 `z.array(...)` 会把两种语义又抹成一种。
    expect(registered.schema({ ...registered.base as object, home: [] })).toMatchObject({ home: [] })
    expect(Object.hasOwn(registered.schema(registered.base) as object, 'home')).toBe(false)
  })

  it('publishes the section the browser half reads, menus included', async () => {
    const { home, namespace } = await startPlugin()
    homes.push(home)

    expect(namespace.menus).toEqual(['workspace.chat'])
    expect(namespace.home?.[0]?.label).toBe('通用助手')
    expect(namespace.home?.[0]?.actions[0]).toMatchObject({ label: '文档处理', skill: 'doc-polish' })
    // 技能清单进设置节，供桌面端「技能广场」渲染卡片；kind/fileCount 缺省时收敛为单文件技能
    expect(namespace.skills).toEqual([
      {
        name: 'doc-polish',
        displayName: '文档润色',
        description: '整理并润色',
        version: '1.2.0',
        kind: 'single',
        fileCount: 0,
        installed: false,
      },
      {
        name: 'meeting-minutes',
        displayName: '会议纪要',
        description: '整理会议记录',
        version: '2.0.0',
        kind: 'bundle',
        fileCount: 2,
        installed: false,
      },
    ])
    expect(namespace.configRevision).toBe(7)
  })

  it('marks skills the sync actually wrote to disk as installed', async () => {
    const { home, namespace } = await startPlugin({ syncSkills: true })
    homes.push(home)

    // 同步是异步的：等两个技能都落盘，再确认客户端读到的清单把 installed 标对了
    await waitFor(() => (existsSync(join(home, 'enterprise-skills.json')) ? true : undefined))
    const installed = await waitFor(() =>
      namespace.skills.every(skill => skill.installed) ? namespace : undefined)
    expect(installed.skills.map(skill => skill.name)).toEqual(['doc-polish', 'meeting-minutes'])
    expect(installed.skills.every(skill => skill.installed)).toBe(true)
  })

  it('leaves skills outside the delivered set unmarked when sync is off', async () => {
    const { home, namespace } = await startPlugin({ syncSkills: false })
    homes.push(home)

    // 不下发技能时清单仍在（桌面端要能列出「没装」的技能），但一个都不该标已安装
    expect(namespace.skills.map(skill => skill.name)).toEqual(['doc-polish', 'meeting-minutes'])
    expect(namespace.skills.some(skill => skill.installed)).toBe(false)
  })

  it('materializes assigned skills under $DSH_HOME/skills and records the manifest', async () => {
    const { home } = await startPlugin({ syncSkills: true })
    homes.push(home)

    // The manifest is written after the skill directory, so its arrival is the
    // completion signal for the whole sync.
    const manifestPath = join(home, 'enterprise-skills.json')
    await waitFor(() => (existsSync(manifestPath) ? true : undefined))
    expect(await readFile(join(home, 'skills', 'doc-polish', 'SKILL.md'), 'utf8')).toContain('name: doc-polish')
    expect(await readFile(join(home, 'skills', 'doc-polish', 'references', 'style.md'), 'utf8'))
      .toContain('简体中文')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { skills: Record<string, string> }
    expect(manifest.skills).toEqual({ 'doc-polish': '1.2.0', 'meeting-minutes': '2.0.0' })
    // 二进制附属文件按 base64 原样落盘（zip 技能包里的图片、字体等）
    expect(await readFile(join(home, 'skills', 'meeting-minutes', 'assets', 'icon.png')))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await readFile(join(home, 'skills', 'meeting-minutes', 'scripts', 'format.py'), 'utf8'))
      .toContain('print("format")')
  })

  it('never requests a skill bundle when skill sync is disabled', async () => {
    const { home, fetchMock } = await startPlugin({ syncSkills: false })
    homes.push(home)

    expect(fetchMock.mock.calls.map(call => endpointOf(call[0])))
      .not.toContain('/api/v1/client/skills/doc-polish')
    expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(existsSync(join(home, 'enterprise-skills.json'))).toBe(false)
  })
})
