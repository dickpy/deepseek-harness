/**
 * 用户上传技能包的解析：把浏览器 File API 读出的文本文件整理成
 * `dsh-enterprise.userSkills` 里的一个条目。
 *
 * 只做文本文件的规整，不解析 zip：桌面端让用户直接选一个目录
 * （`<input type="file" webkitdirectory>`）或单个 SKILL.md，
 * 读出的相对路径已经能还原技能包结构。
 */
import { strFromU8, unzip } from 'fflate/browser'
import type { UserSkillFile, UserSkillUpload } from './enterprise-store.ts'

/** 技能名语法（与 dsh 的 `isSkillName` 一致：kebab-case）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 浏览器读出的一个文本文件（path 是用户选择时的相对路径或文件名）。 */
export interface UploadedSkillFile {
  readonly path: string
  readonly content: string
  readonly encoding?: 'utf8' | 'base64'
}

/** 取路径最后一段。 */
/** Text extensions retained as UTF-8; all other ZIP entries remain binary. */
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'sh', 'toml', 'xml', 'html', 'css', 'svg', 'csv', 'ini', 'cfg', 'conf',
])

function isTextPath(path: string): boolean {
  const name = baseName(path)
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  return TEXT_EXTENSIONS.has(extension)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** Decode one ZIP skill package locally, preserving folder paths and binary files. */
export function skillUploadFromZip(data: Uint8Array): Promise<UserSkillUpload> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, archive) => {
      if (error !== null) {
        reject(error)
        return
      }
      try {
        const files: UploadedSkillFile[] = []
        for (const [path, bytes] of Object.entries(archive)) {
          if (path.endsWith('/') || path.startsWith('__MACOSX/') || baseName(path) === '.DS_Store') continue
          const encoding = isTextPath(path) ? 'utf8' : 'base64'
          files.push({
            path,
            encoding,
            content: encoding === 'utf8' ? strFromU8(bytes) : bytesToBase64(bytes),
          })
        }
        resolve(skillUploadFromFiles(files))
      } catch (cause) {
        reject(cause)
      }
    })
  })
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

/** 去掉一层成对的引号（frontmatter 里 `name: "x"` 与 `name: x` 等价）。 */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * 从 SKILL.md 的 YAML frontmatter 里读一个顶层字符串字段。
 *
 * 只按行匹配 `key: value`，不做完整 YAML 解析：技能 frontmatter 里
 * `name` / `description` / `version` 都是标量，够用且不需要额外依赖。
 *
 * @param content - SKILL.md 全文。
 * @param key - 字段名（如 `name`）。
 * @returns 字段值；缺失或不是标量时返回空串。
 */
export function parseFrontmatterField(content: string, key: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)
  if (frontmatter?.[1] === undefined) return ''
  const pattern = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im')
  const match = pattern.exec(frontmatter[1])
  if (match?.[1] === undefined) return ''
  return unquote(match[1].trim())
}

/** 把任意名字规整成 kebab-case 技能名（非法字符折叠成单个连字符）。 */
export function slugifySkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 把用户选中的文本文件整理成一个可落盘的技能包。
 *
 * 规则：
 *  - 以第一个 `SKILL.md`（大小写不敏感）为技能根，其余文件按相对该根的
 *    路径收录；只选散文件时根为空，SKILL.md 直接落在技能目录根。
 *  - 没有 SKILL.md 时退化成「把选中的第一个 Markdown 文件当成 SKILL.md」。
 *  - 技能名取 frontmatter `name` → 目录名 → 文件名，三者都规整成 kebab-case。
 *
 * @param files - 用户选中的文本文件。
 * @returns 规范化后的上传记录（`installed` 由 host 落盘后回填）。
 * @throws 当没有任何可用的 Markdown 文件时抛出。
 */
export function skillUploadFromFiles(files: readonly UploadedSkillFile[]): UserSkillUpload {
  const normalized = files
    .map(file => ({
      path: file.path.replace(/\\/g, '/').replace(/^\.\//, ''),
      content: file.content,
      encoding: file.encoding ?? 'utf8' as const,
    }))
    .filter(file => file.path !== '' && !file.path.split('/').includes('..'))
  const entries = normalized.filter(file => baseName(file.path).toLowerCase() === 'skill.md')
  const entry = entries[0] ?? normalized.find(file => /\.md$/i.test(file.path))
  if (entry === undefined) throw new Error('no Markdown entry found')

  const root = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : ''
  const collected: UserSkillFile[] = []
  const seen = new Set<string>()
  for (const file of normalized) {
    if (file.path !== entry.path && !file.path.startsWith(root)) continue
    const relative = file.path === entry.path && baseName(file.path).toLowerCase() === 'skill.md'
      ? 'SKILL.md'
      : file.path.slice(root.length)
    if (relative === '' || seen.has(relative)) continue
    seen.add(relative)
    collected.push({ path: relative, content: file.content, encoding: file.encoding })
  }
  if (!collected.some(file => file.path === 'SKILL.md')) {
    collected.unshift({ path: 'SKILL.md', content: entry.content, encoding: 'utf8' })
  }

  const fromFrontmatter = parseFrontmatterField(entry.content, 'name')
  const directory = root === '' ? baseName(entry.path).replace(/\.md$/i, '') : baseName(root.replace(/\/$/, ''))
  const fallback = fromFrontmatter !== '' ? fromFrontmatter : directory
  const name = slugifySkillName(fallback)
  if (name === '' || !SKILL_NAME.test(name)) throw new Error(`无法从文件名推断合法技能名：${fallback}`)

  const version = parseFrontmatterField(entry.content, 'version')
  return {
    name,
    displayName: fromFrontmatter !== '' ? fromFrontmatter : name,
    description: parseFrontmatterField(entry.content, 'description'),
    version: version === '' ? '1.0.0' : version,
    files: collected,
    installed: false,
  }
}
