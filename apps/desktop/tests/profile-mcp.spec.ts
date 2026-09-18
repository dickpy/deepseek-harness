/** MCP resource ownership in the shipped Desktop composition. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('retains one shared resource consumer in the Desktop Web profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-mcp-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    // fork: 桌面 profile 还挂着内置的 dsh-context（随桌面运行时项目从 registry 安装）。
    // 夹具补一个可解析的桩，否则 profile 装载会因为找不到它而失败。
    const bundledStub = join(profileDir, 'node_modules', 'dsh-context')
    mkdirSync(bundledStub, { recursive: true })
    writeFileSync(join(bundledStub, 'package.json'), `${JSON.stringify({
      name: 'dsh-context', version: '0.52.2', dsh: { bundle: { patch: './bundle.yml' } },
    })}\n`)
    writeFileSync(join(bundledStub, 'bundle.yml'), '[]\n')
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ], message => warnings.push(message))

    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@deepseek-ai/dsh-mcp-resources' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(rows.find(row => row.id === 'webserver')).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(rows.find(row => row.id === 'webserver')?.disabled).not.toBe(true)
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
