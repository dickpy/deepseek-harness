/** `ui-enterprise` 命名空间词典（zh 为 key 源，en key 一致）。 */
export const NS = 'ui-enterprise'

export const zh = {
  'badge.tooltip': '当前用户：{name}',
  'user.menu.aria': '账号菜单',
  'user.switch': '切换账号',
  'user.logout': '退出登录',
  'home.aria': '模块与技能',
  'skills.sidebar': '技能广场',
  'skills.title': '技能广场',
  'skills.intro': '已为你开通 {count} 个技能。点「试一试」会带着这个技能开一段新对话，你可以补充要求后再发送。',
  'skills.intro.empty': '管理台还没有为你开通任何技能。',
  'skills.loading': '正在读取技能清单…',
  'skills.unavailable': '暂时读不到技能清单：桌面端还没有完成一次企业配置同步，请稍后重试或重新登录。',
  'skills.empty.title': '还没有可用的技能',
  'skills.empty.hint': '技能由企业管理台「技能广场」发布并按角色下发；发布后点管理台的「同步到客户端」，这里就会出现。',
  'skills.noDescription': '这个技能没有填写描述。',
  'skills.kind.bundle': '技能包 · {count} 个附属文件',
  'skills.try': '试一试',
  'skills.try.hint': '带着这个技能开一段新对话（会把 /技能名 填进输入框，不会自动发送）',
} as const

export type EnterpriseLocaleKey = keyof typeof zh

export const en: Record<EnterpriseLocaleKey, string> = {
  'badge.tooltip': 'Current user: {name}',
  'user.menu.aria': 'Account menu',
  'user.switch': 'Switch account',
  'user.logout': 'Sign out',
  'home.aria': 'Modules and skills',
  'skills.sidebar': 'Skills',
  'skills.title': 'Skills',
  'skills.intro': '{count} skills are available to you. “Try it” starts a new conversation with that skill already invoked — add your request, then send.',
  'skills.intro.empty': 'No skills have been enabled for you yet.',
  'skills.loading': 'Loading skills…',
  'skills.unavailable': 'The skill list is unavailable: this desktop has not completed an enterprise configuration sync yet. Try again shortly, or sign in again.',
  'skills.empty.title': 'No skills available yet',
  'skills.empty.hint': 'Skills are published in the enterprise admin console and delivered by role. Publish one, then use “Sync to clients” there and it appears here.',
  'skills.noDescription': 'This skill has no description.',
  'skills.kind.bundle': 'Package · {count} supporting files',
  'skills.try': 'Try it',
  'skills.try.hint': 'Start a new conversation with this skill invoked (fills /skill-name into the composer, without sending)',
}
