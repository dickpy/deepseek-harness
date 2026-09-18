/** Materialize the complete production runtime before publishing Desktop resources. */

import { spawn, execFile } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { createRuntimeProjectMetadata, DESKTOP_BUNDLED_PLUGINS } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { smokeDesktopRuntime } from './smoke-runtime.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { selectOfficeEngine } from '../../../scripts/libreoffice-engine.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
// fork: 工作目录与 store 都必须位于构建根所在磁盘。
// store 原先在系统临时目录里、每次构建重新下载全部依赖（实测 258 个包 / 2m41s）；
// 但它与临时目录分属不同盘时 pnpm 无法硬链接，只能逐文件复制。
// 两者同置于目标构建目录下即可同时获得「下载复用」与「硬链接物化」。
const BUILD_ROOT = BUILD_PATHS.dshRuntimeBuild
const STORE_ROOT = BUILD_PATHS.dshPnpmStore
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(BUILD_PATHS.electron, process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
const PNPM = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.mjs')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

/**
 * Require every bundled third-party plugin to be installed at its pinned
 * version, and report the names for the runtime inventory. A range in the
 * pinned table would let the lockfile drift past the version this build was
 * validated against, so the comparison is exact.
 * @param modules - Installed production `node_modules` of the runtime project.
 * @returns Bundled plugin names in deterministic order.
 */
function verifyBundledPlugins(modules: string): string[] {
  return Object.entries(DESKTOP_BUNDLED_PLUGINS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => {
      const manifest = join(modules, ...name.split('/'), 'package.json')
      if (!existsSync(manifest)) {
        throw new Error(`desktop runtime: bundled plugin ${name} was not installed`)
      }
      const installed = manifestVersion(manifest, `bundled plugin ${name}`)
      if (installed !== version) {
        throw new Error(`desktop runtime: bundled plugin ${name}@${installed} does not match the pinned ${version}`)
      }
      return name
    })
}

/**
 * Hardlinking is skipped on macOS: signing rewrites the materialized runtime in
 * place afterwards, which would mutate the shared pnpm store copy through the link.
 */
const MATERIALIZE_LINKS = process.platform !== 'darwin'

/**
 * Materialize installed modules into the runtime tree.
 *
 * The tree is roughly eleven thousand files. On Windows a byte copy costs
 * minutes because every write passes the filesystem filter drivers, while
 * linking the same bytes is metadata-only. Names, contents, and the resulting
 * file set are identical either way, so the runtime descriptor and its
 * integrity check describe the same tree; anything the filesystem refuses to
 * link falls back to a copy.
 * @param source - Installed `node_modules`.
 * @param destination - Runtime-tree `node_modules`.
 * @param include - Whether one source path belongs in the runtime tree.
 */
function materializeModules(
  source: string,
  destination: string,
  include: (source: string) => boolean,
): void {
  if (!include(source)) return
  const entry = lstatSync(source)
  if (entry.isSymbolicLink()) {
    // The previous copy dereferenced links, so follow one to the same result.
    materializeModules(realpathSync.native(source), destination, include)
    return
  }
  if (entry.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) {
      materializeModules(join(source, name), join(destination, name), include)
    }
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  if (MATERIALIZE_LINKS) {
    try {
      linkSync(source, destination)
      return
    } catch {
      // Fall through to the copy path below.
    }
  }
  copyFileSync(source, destination)
}

function desktopRelease(): DesktopRelease {
  // fork: 桌面产品版本（apps/desktop/package.json）与 dsh 运行时版本解耦。
  // 运行时身份始终是内置 @deepseek-ai/dsh 的版本：package set 按它校验，
  // 打包后的 Host 也上报它，因此这里不能改用产品版本。
  const version = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'dsh package')
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      '--expose-internals',
      PNPM,
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        ...desktopNodeEnvironment(NODE, join(RUNTIME_ROOT, 'bin'), {}),
        PATH: `${join(RUNTIME_ROOT, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

async function main(): Promise<void> {
  rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
  rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  // 固定路径而非 mkdtemp：必须与 store 同盘才能硬链接，且每次重建以丢弃上一轮残留。
  rmSync(BUILD_ROOT, { recursive: true, force: true })
  mkdirSync(BUILD_ROOT, { recursive: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  try {
    const release = desktopRelease()
    copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
    createRuntimeProjectMetadata(BUILD_ROOT, release)
    await runPnpm(['install', '--lockfile-only'])
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    await runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile'])
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: targetName.endsWith('arm64') ? 'arm64' : 'x64' }
    const modules = join(BUILD_ROOT, 'node_modules')
    const bundledPlugins = verifyBundledPlugins(modules)
    const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
    const officeEngine = selectOfficeEngine(officeManifest, target)
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    materializeModules(
      modules,
      join(DSH_OUTPUT_ROOT, 'node_modules'),
      source => desktopRuntimeFileExclusion(relative(modules, source), target, officeEngine) === undefined,
    )
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries([
        ...packageSet.packages.map(entry => [entry.name, entry.version]),
        ...Object.entries(DESKTOP_BUNDLED_PLUGINS),
      ]),
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'))) {
      throw new Error(`desktop runtime: missing required LibreOffice engine ${officeEngine}`)
    }
    if (process.platform === 'darwin') {
      await signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env))
      await signMacOSRuntime(join(RUNTIME_ROOT, 'primary-runtime'), resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env))
    }
    smokePrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))
    writeDesktopRuntime(
      DSH_OUTPUT_ROOT, release,
      [...packageSet.packages.map(entry => entry.name), ...bundledPlugins],
      target,
    )
    const descriptor = await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
    await new Promise<void>((accept, reject) => {
      execFile(NODE, ['--expose-internals', join(APP_ROOT, 'tests/fixtures/runtime-payload-smoke.mjs'), DSH_OUTPUT_ROOT],
        { timeout: 120_000, env: desktopNodeEnvironment(NODE, join(RUNTIME_ROOT, 'bin'), { ...process.env, NODE_OPTIONS: '' }) }, (error, stdout, stderr) => {
          if (error !== null) reject(new Error(`desktop native payload smoke failed: ${stderr}`, { cause: error }))
          else { process.stdout.write(stdout); accept() }
        })
    })
    await smokeDesktopRuntime(DSH_OUTPUT_ROOT, NODE, descriptor)
    await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
  } catch (error) {
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    // 清工作目录与 pnpm 状态；STORE_ROOT 刻意保留，它是跨构建复用的下载缓存。
    rmSync(BUILD_ROOT, { recursive: true, force: true })
    rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  }
}

await main()
