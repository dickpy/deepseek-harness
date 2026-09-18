/**
 * The bundled third-party plugin table and the workspace manifest that
 * declares the same plugins are two halves of one fact: the manifest feeds the
 * workspace install, the dependency graph, and the third-party notices, while
 * the table feeds the packaging scripts. Drift between them ships a plugin
 * version nobody reviewed or discloses — this spec pins them together.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_BUNDLED_PLUGINS } from '../src/project-manager.ts'

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')

function desktopHostDependencies(): Record<string, string> {
  const path = resolve(repositoryRoot, 'apps', 'desktop-host', 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  return manifest.dependencies ?? {}
}

describe('bundled desktop plugins', () => {
  // fork: 外部 bundle 的 peer 指向工作区包时会让 pnpm 的 peer 解析与发布图分叉，
  // 所以内置插件只由桌面运行时项目从 registry 安装，绝不进工作区依赖图。
  it('keeps every bundled plugin out of the workspace dependency graph', () => {
    const declared = desktopHostDependencies()
    for (const name of Object.keys(DESKTOP_BUNDLED_PLUGINS)) {
      expect(declared[name], `${name} must not be a workspace dependency`).toBeUndefined()
    }
  })

  it('pins exact versions rather than ranges', () => {
    for (const [name, version] of Object.entries(DESKTOP_BUNDLED_PLUGINS)) {
      expect(version, `${name} must pin an exact version`).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u)
      expect(version, `${name} must not carry a range operator`).not.toMatch(/[\^~><=*|\s]/u)
    }
  })
})
