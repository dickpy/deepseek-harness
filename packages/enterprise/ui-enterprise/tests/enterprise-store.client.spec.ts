import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  EnterpriseSessionStore,
  decodeDisabledSkills,
  decodeSkills,
  type EnterpriseSection,
} from '../src/client/enterprise-store.ts'
import { decodeExamples, exampleDraft } from '../src/client/home-examples.ts'
import { actionDraft, decodeHome } from '../src/client/home-catalog.ts'

/**
 * 「技能广场」的开关是**客户端写、host 读**的一条设置字段：
 * 客户端只写 `disabledSkills`，host 插件据此调整技能文件的模型可见性。
 * 这里钉住两侧共用的两个约定：
 *   1. 技能清单怎么解码（畸形项剔除、开关映射到 enabled）；
 *   2. 开关一次只写这一个字段（不整段覆盖设置节，否则会把 host 同步的身份/菜单冲掉）。
 */

const SKILLS = [
  { name: 'doc-polish', displayName: '文档润色', description: '整理并润色', version: '1.2.0' },
  { name: 'meeting-minutes', displayName: '会议纪要', description: '整理会议', version: '2.0.0', kind: 'bundle', fileCount: 3, installed: true },
]

/** 一个可写的假设置作用域：记录 set/unset 调用并按需发布新快照。 */
function fakeScope(section: EnterpriseSection) {
  let snapshot: SettingsScopeSnapshot<EnterpriseSection> = {
    status: 'ready',
    value: section,
    base: undefined,
    user: section,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  const writes: { field: string; value: unknown }[] = []
  const scope: SettingsScope<EnterpriseSection> = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async mutate() {},
    async set(field: string, next: unknown) {
      writes.push({ field, value: next })
      const value = { ...(snapshot.value ?? {}), [field]: next }
      snapshot = { ...snapshot, value, user: value }
      for (const listener of listeners) listener()
    },
    async unset() {},
  }
  return { scope, writes }
}

/** 只带技能清单的设置节（其余字段由具体用例补充） */
function withSkills(extra: EnterpriseSection = {}): EnterpriseSection {
  return { skills: SKILLS, ...extra }
}

describe('enterprise skill plaza state', () => {
  it('decodes the skill list and maps disabled names onto the enabled flag', () => {
    const skills = decodeSkills(SKILLS, new Set(['meeting-minutes']))
    expect(skills.map(skill => [skill.name, skill.enabled, skill.kind, skill.fileCount, skill.installed])).toEqual([
      ['doc-polish', true, 'single', 0, false],
      ['meeting-minutes', false, 'bundle', 3, true],
    ])
  })

  it('drops malformed skill entries and malformed disabled names', () => {
    // 结构不对的整表丢弃；单项畸形只剔除该项（host 下发的字段随版本演进）
    expect(decodeSkills('nope')).toEqual([])
    expect(decodeSkills([null, { displayName: '没有名字' }, ...SKILLS]).map(skill => skill.name))
      .toEqual(['doc-polish', 'meeting-minutes'])
    // 关闭清单里只有合法 kebab-case 技能名会被采纳
    expect([...decodeDisabledSkills(['doc-polish', 'Bad_Name', 42, ''])]).toEqual(['doc-polish'])
    expect([...decodeDisabledSkills(undefined)]).toEqual([])
  })

  it('writes only the disabledSkills field when a skill is switched off and on', async () => {
    const { scope, writes } = fakeScope(withSkills())
    const store = new EnterpriseSessionStore(scope)
    await store.load()
    expect(store.store.getSnapshot().skills.map(skill => skill.enabled)).toEqual([true, true])

    await store.setSkillEnabled('meeting-minutes', false)
    expect(writes).toEqual([{ field: 'disabledSkills', value: ['meeting-minutes'] }])
    expect(store.store.getSnapshot().skills.map(skill => skill.enabled)).toEqual([true, false])

    await store.setSkillEnabled('doc-polish', false)
    expect(writes.at(-1)).toEqual({ field: 'disabledSkills', value: ['doc-polish', 'meeting-minutes'] })
    expect(store.store.getSnapshot().skills.every(skill => !skill.enabled)).toBe(true)

    await store.setSkillEnabled('doc-polish', true)
    expect(writes.at(-1)).toEqual({ field: 'disabledSkills', value: ['meeting-minutes'] })
    expect(store.store.getSnapshot().skills.map(skill => skill.enabled)).toEqual([true, false])
  })

  it('ignores invalid skill names instead of writing them into the settings document', async () => {
    const { scope, writes } = fakeScope(withSkills())
    const store = new EnterpriseSessionStore(scope)
    await store.load()

    await store.setSkillEnabled('Bad_Name', false)
    await store.setSkillEnabled('', false)
    expect(writes).toEqual([])
  })

  it('keeps reporting loading and unavailable without publishing a skill list', () => {
    const loading = fakeScope(withSkills())
    loading.scope.getSnapshot = () => ({
      status: 'loading', value: undefined, base: undefined, user: undefined,
      revision: undefined, writable: false, mode: 'host',
    })
    const store = new EnterpriseSessionStore(loading.scope)
    void store.load()
    expect(store.store.getSnapshot().status).toBe('loading')

    const unavailable = fakeScope(withSkills())
    unavailable.scope.getSnapshot = () => ({
      status: 'unavailable', value: undefined, base: undefined, user: undefined,
      revision: undefined, writable: false, mode: 'host',
    })
    const other = new EnterpriseSessionStore(unavailable.scope)
    void other.load()
    expect(other.store.getSnapshot().status).toBe('unavailable')
    // dispose 幂等：面板卸载时不会因为没 load 过就抛错
    expect(() => { other.dispose(); other.dispose() }).not.toThrow()
  })
})

describe('enterprise session badge', () => {
  it('derives identity, menus and revision from the settings section', async () => {
    const { scope } = fakeScope(withSkills({
      user: { email: 'dev@company.com', name: '开发者', role: 'member' },
      menus: ['workspace.skills'],
      disabledSkills: ['doc-polish'],
      configRevision: 9,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
    }))
    const store = new EnterpriseSessionStore(scope)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.name).toBe('开发者')
    expect(state.role).toBe('member')
    expect(state.menus).toEqual(['workspace.skills'])
    expect(state.configRevision).toBe(9)
    expect(state.lastSyncAt).toBe('2026-01-01T00:00:00.000Z')
    expect(state.skills.map(skill => [skill.name, skill.enabled])).toEqual([
      ['doc-polish', false],
      ['meeting-minutes', true],
    ])
  })

  it('subscribes on load and stops on dispose', async () => {
    const { scope } = fakeScope(withSkills())
    const subscribe = vi.spyOn(scope, 'subscribe')
    const store = new EnterpriseSessionStore(scope)
    await store.load()
    await store.load()
    // 重复 load 幂等：只订阅一次
    expect(subscribe).toHaveBeenCalledTimes(1)
    store.dispose()
    store.dispose()
    expect(() => { store.dispose() }).not.toThrow()
  })
})

const EXAMPLES = [  {
  id: 'ex-2',
  label: '第二个样例',
  summary: '副标题',
  prompt: '做点什么',
  skill: 'doc-polish',
  image: 'data:image/png;base64,AAAA',
  artifacts: [{ label: '一年报.html', note: '单文件' }, { label: '没有备注' }, { label: '' }],
  order: 2,
},
{
  id: 'ex-1',
  label: '第一个样例',
  summary: '',
  prompt: '只填提示词',
  image: 'data:image/png;base64,BBBB',
  order: 1,
},
]

describe('home catalog icons', () => {
  it('decodes tab and action icons, rejecting values that are not a short glyph', () => {
    const catalog = decodeHome([
      {
        id: 'general',
        label: '通用助手',
        icon: '💡',
        actions: [
          { id: 'docs', label: '文档处理', icon: '📄', prompt: '整理文档' },
          // 图标位塞了一整段文字：会把 tab 撑变形，直接丢掉这个字段
          { id: 'long', label: '超长图标', icon: '这是一整段说明文字不该出现在图标位', prompt: 'x' },
          // 图标字段类型不对：同样只丢图标，不影响这条 action 本身
          { id: 'bad', label: '畸形图标', icon: 42, prompt: 'y' },
        ],
      },
      { id: 'no-icon', label: '没配图标', actions: [{ id: 'a', label: 'A', prompt: 'z' }] },
    ])
    expect(catalog?.[0]?.icon).toBe('💡')
    expect(catalog?.[0]?.actions.map(action => action.icon)).toEqual(['📄', undefined, undefined])
    // 没配图标时字段缺省（而不是空串），模板据此决定要不要渲染图标节点
    expect(catalog?.[1]?.icon).toBeUndefined()
    expect('icon' in (catalog?.[1]?.actions[0] ?? {})).toBe(false)
  })

  it('keeps the draft rule independent from the icon', () => {
    expect(actionDraft({ id: 'a', label: '文档处理', icon: '📄', prompt: '整理文档' })).toBe('整理文档')
    expect(actionDraft({ id: 'a', label: '文档处理', icon: '📄', skill: 'doc-polish', prompt: '整理' }))
      .toBe('/doc-polish 整理')
  })
})

describe('home examples', () => {
  it('decodes examples, orders them, and drops entries that cannot render a card', () => {
    // 没有 id / 名称 / 样例图的条目都会被剔除：详情是「左预览图 + 右详情」的形态，
    // 缺图就没有可点开的东西。
    const decoded = decodeExamples([
      ...EXAMPLES,
      { id: '', label: '缺 id', image: 'data:image/png;base64,AAAA' },
      { id: 'ex-3', label: '缺图', prompt: 'x' },
      { id: 'ex-4', image: 'data:image/png;base64,AAAA' },
      null,
      'nope',
    ])
    expect(decoded.map(example => example.id)).toEqual(['ex-1', 'ex-2'])
    // 缺少 skill 时归一成 null（模板里要显式渲染「没有关联技能」）
    expect(decoded[0]?.skill).toBeNull()
    expect(decoded[0]?.artifacts).toEqual([])
    expect(decoded[1]?.skill).toBe('doc-polish')
    // 没有标签的相关产物被丢掉，只有备注的条目也不会变成一行没有文字的图标
    expect(decoded[1]?.artifacts).toEqual([
      { label: '一年报.html', note: '单文件' },
      { label: '没有备注' },
    ])
    // 结构不对时整表丢弃，而不是抛出
    expect(decodeExamples('nope')).toEqual([])
    expect(decodeExamples(undefined)).toEqual([])
  })

  it('builds the same /skill prompt draft as the home catalog', () => {
    expect(exampleDraft({ skill: 'doc-polish', prompt: '整理这份文档' })).toBe('/doc-polish 整理这份文档')
    expect(exampleDraft({ skill: 'doc-polish', prompt: '  ' })).toBe('/doc-polish')
    // 没有关联技能就只填提示词（不能被当成技能名去调用）
    expect(exampleDraft({ skill: null, prompt: '写一份周报' })).toBe('写一份周报')
  })

  it('publishes examples through the store and keeps them out of the skill list', async () => {
    const { scope } = fakeScope(withSkills({ examples: EXAMPLES }))
    const store = new EnterpriseSessionStore(scope)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.examples.map(example => example.id)).toEqual(['ex-1', 'ex-2'])
    // 样例是首页内容，不是技能：不能混进「技能广场」的清单
    expect(state.skills.every(skill => !skill.name.startsWith('ex-'))).toBe(true)

    // 平台没配样例 = 空数组 = 客户端整块不渲染案例区（没有内置默认样例）
    const empty = fakeScope(withSkills())
    const other = new EnterpriseSessionStore(empty.scope)
    await other.load()
    expect(other.store.getSnapshot().examples).toEqual([])
  })
})
