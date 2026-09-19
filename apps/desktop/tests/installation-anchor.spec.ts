/**
 * The Desktop Host anchors profile resolution on the runtime project manifest,
 * because the Desktop installation is the runtime project: its manifest is the
 * only place that declares the union of the dsh and Desktop Host closures. This
 * spec pins the combination that regressed: a profile bundle the runtime
 * project carries but dsh itself does not depend on must still resolve from the
 * installation generation the Host enforces at boot.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProfileResolutionGeneration, type Profile } from '@deepseek-ai/dsh-app-boot'
import { desktopInstallAnchor } from '../../desktop-host/src/install-anchor.ts'
import { DESKTOP_PROFILE_BUNDLES } from '../src/project-manager.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Installation {
  readonly runtimeDir: string
  readonly dirs: ReadonlyMap<string, string>
}

function writePackage(modules: string, name: string, dependencies: Record<string, string> = {}): string {
  const dir = join(modules, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '0.0.0', type: 'module', main: './index.js', dependencies,
  }))
  writeFileSync(join(dir, 'index.js'), `export const packageName = ${JSON.stringify(name)}\n`)
  return dir
}

/** Stage the runtime project closure: dsh, the private Desktop Host, and every bundled profile layer. */
function stageInstallation(): Installation {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-anchor-'))
  roots.push(root)
  const runtimeDir = join(root, 'dsh')
  const modules = join(runtimeDir, 'node_modules')
  const dirs = new Map<string, string>()
  const stage = (name: string, dependencies: Record<string, string> = {}): void => {
    dirs.set(name, writePackage(modules, name, dependencies))
  }
  stage('@deepseek-ai/dsh', { '@deepseek-ai/dsh-base': '0.0.0', '@deepseek-ai/dsh-web-app': '0.0.0' })
  stage('@deepseek-ai/dsh-desktop-host', {
    '@deepseek-ai/dsh-client-ui-enterprise': '0.0.0',
    '@deepseek-ai/dsh-plugin-enterprise': '0.0.0',
  })
  stage('@deepseek-ai/dsh-base')
  stage('@deepseek-ai/dsh-web-app', { '@deepseek-ai/dsh-client-ui-enterprise': '0.0.0' })
  stage('@deepseek-ai/dsh-client-ui-enterprise')
  stage('@deepseek-ai/dsh-plugin-enterprise')
  stage('dsh-context')
  writeFileSync(join(runtimeDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': '0.0.0', '@deepseek-ai/dsh-desktop-host': '0.0.0', 'dsh-context': '0.0.0' },
  }))
  return { runtimeDir, dirs }
}

describe('desktop installation anchor', () => {
  it('anchors profile resolution on the Desktop runtime project manifest', () => {
    const { runtimeDir } = stageInstallation()
    expect(desktopInstallAnchor(runtimeDir)).toBe(join(runtimeDir, 'package.json'))
  })

  it('resolves every bundled profile layer and the enterprise client from the installation', async () => {
    const { runtimeDir, dirs } = stageInstallation()
    const home = join(runtimeDir, '..', 'home')
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    const profile: Profile = {
      name: 'desktop',
      dir: profileDir,
      layers: DESKTOP_PROFILE_BUNDLES.map((packageName) => {
        const packageDir = dirs.get(packageName) as string
        return { packageName, packageDir, patchPath: join(packageDir, 'cordis.patch.yml'), patches: [] }
      }),
      patchPath: join(profileDir, 'cordis.patch.yml'),
      patches: [],
    }
    const generation = await createProfileResolutionGeneration({
      installAnchor: desktopInstallAnchor(runtimeDir), home, profile,
    })
    const resolved = new Map(generation.entries.map(entry => [entry.name, entry.scope]))
    for (const name of [...DESKTOP_PROFILE_BUNDLES, '@deepseek-ai/dsh-client-ui-enterprise']) {
      expect(resolved.get(name), `${name} must resolve from the installation`).toBe('installation')
    }
  })
})
