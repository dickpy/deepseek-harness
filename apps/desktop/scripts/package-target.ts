/** Build one release target with matching Electron and dsh architecture. */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import {
  desktopBuildRecordFilename,
  resolveDesktopAutoUpdateConfig,
} from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { parseEnterpriseManifest, resolveEnterpriseChannel } from '../src/enterprise-environments.ts'
import { packageMacOSArtifacts, type DesktopPrepackagedArtifact } from './package-macos.ts'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createPackagingRun } from './packaging-run.mjs'
import { withMacOSSigningKeychain } from './macos-signing-keychain.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const WINDOWS_SIGNING_ENV_PREFIX = 'DSH_DESKTOP_WINDOWS_'
const WINDOWS_SIGNING_ENV_NAMES = [
  'DSH_DESKTOP_WINDOWS_CER_FILE',
  'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
  'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_WINDOWS_TOKEN_PIN',
] as const
const DESKTOP_UPLOAD_CREDENTIAL_ENV_NAMES = new Set([
  'DOWNLOAD_TEST_COS_SECRET_ID',
  'DOWNLOAD_TEST_COS_SECRET_KEY',
  'DOWNLOAD_PROD_COS_SECRET_ID',
  'DOWNLOAD_PROD_COS_SECRET_KEY',
])
/** Overrides how many release tarballs pack at once; see `desktopPackConcurrency`. */
const DESKTOP_PACK_CONCURRENCY_ENV = 'DSH_DESKTOP_PACK_CONCURRENCY'
/** Upper bound for the derived worker count so packing cannot starve the build host. */
const DESKTOP_PACK_CONCURRENCY_LIMIT = 8

/** Fixed platform and architecture identifiers exposed by package scripts. */
export type DesktopPackageTargetName = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** One supported release target and its electron-builder selectors. */
export interface DesktopPackageTarget {
  readonly name: DesktopPackageTargetName
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly builderPlatform: '--mac' | '--win'
  readonly builderArch: '--arm64' | '--x64'
}

const TARGETS: Record<DesktopPackageTargetName, DesktopPackageTarget> = {
  'mac-arm64': {
    name: 'mac-arm64',
    platform: 'darwin',
    arch: 'arm64',
    builderPlatform: '--mac',
    builderArch: '--arm64',
  },
  'mac-x64': {
    name: 'mac-x64',
    platform: 'darwin',
    arch: 'x64',
    builderPlatform: '--mac',
    builderArch: '--x64',
  },
  'win-x64': {
    name: 'win-x64',
    platform: 'win32',
    arch: 'x64',
    builderPlatform: '--win',
    builderArch: '--x64',
  },
}

/**
 * Remove Windows signing configuration from package preparation subprocesses.
 * @param environment - Packaging command environment.
 * @returns A copy without Windows signing fields.
 */
export function withoutWindowsSigningEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !name.startsWith(WINDOWS_SIGNING_ENV_PREFIX)))
}

/**
 * Select signing and NSIS-compatible archive filters for electron-builder.
 * @param environment - Target packaging environment.
 * @param unsigned - Whether to create a local unsigned Windows artifact.
 * @returns Packaging environment without certificate inputs for unsigned builds.
 */
export function desktopElectronBuilderEnvironment(environment: NodeJS.ProcessEnv, unsigned: boolean): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { ...environment, DSH_DESKTOP_UNSIGNED: unsigned ? '1' : '0' }
  // The bundled NSIS decoder cannot extract 7-Zip's automatic ARM64-filtered entries.
  if (environment.DSH_DESKTOP_TARGET_PLATFORM === 'win32') selected.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
  if (!unsigned) return selected
  return {
    ...Object.fromEntries(Object.entries(withoutWindowsSigningEnvironment(selected))
      .filter(([name]) => !/^(?:WIN_)?CSC_/iu.test(name))),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    DSH_DESKTOP_UNSIGNED: '1',
  }
}

/**
 * Remove upload-only COS credentials from every packaging subprocess.
 * @param environment - Packaging command environment.
 * @returns A copy without Desktop upload credentials.
 */
export function withoutDesktopUploadCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !DESKTOP_UPLOAD_CREDENTIAL_ENV_NAMES.has(name)))
}

function isTargetName(value: string): value is DesktopPackageTargetName {
  return Object.hasOwn(TARGETS, value)
}

function packageVersion(path: string, label: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`desktop package: ${label} has no version`)
  }
  return manifest.version
}

function writeReleaseRecord(
  target: DesktopPackageTarget,
  environment: NodeJS.ProcessEnv,
  artifactsRoot: string,
): void {
  // fork: 产品版本与 dsh 运行时版本已解耦，两者不再要求相等。
  // 记录同时保留二者：version 标识这次发布（决定产物名与频道路径），
  // dshVersion 保留「这一版绑定哪个 dsh」的既有保证。
  const desktopVersion = packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = packageVersion(join(REPOSITORY_ROOT, 'package.json'), 'dsh package')
  const update = resolveDesktopAutoUpdateConfig(environment, target.platform, target.arch)
  const recordPath = join(artifactsRoot, desktopBuildRecordFilename(target.name))
  const temporaryPath = `${recordPath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify({
    schemaVersion: 1,
    target: target.name,
    version: desktopVersion,
    dshVersion,
    environment: update.environment,
    publicUrl: update.publicUrl,
  }, null, 2)}\n`)
  renameSync(temporaryPath, recordPath)
}

/**
 * Resolve a named release target and reject hosts that cannot execute its packaged runtime.
 * @param name - One of the fixed Desktop release target names.
 * @param hostPlatform - Build-host Node.js platform.
 * @param hostArch - Build-host Node.js architecture.
 * @returns The target selectors shared by runtime preparation and electron-builder.
 */
export function resolveDesktopPackageTarget(
  name: string,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopPackageTarget {
  if (!isTargetName(name)) {
    throw new Error(`desktop package: unsupported target ${JSON.stringify(name)}; expected ${Object.keys(TARGETS).join(', ')}`)
  }
  const target = TARGETS[name]
  if (target.platform === 'win32' && (hostPlatform !== 'win32' || hostArch !== 'x64')) {
    throw new Error('desktop package: win-x64 requires a Windows x64 build host')
  }
  if (target.platform === 'darwin' && hostPlatform !== 'darwin') {
    throw new Error(`desktop package: ${name} requires a macOS build host`)
  }
  if (name === 'mac-arm64' && hostArch !== 'arm64') {
    throw new Error('desktop package: mac-arm64 requires an Apple Silicon build host')
  }
  if (name === 'mac-x64' && hostArch !== 'arm64' && hostArch !== 'x64') {
    throw new Error('desktop package: mac-x64 requires an Intel Mac or Apple Silicon with Rosetta')
  }
  return target
}

interface DesktopPackageInvocation {
  readonly target: DesktopPackageTarget
  readonly directory: boolean
  readonly prepareOnly: boolean
  readonly unsigned: boolean
  readonly check: boolean
}

function hostTargetName(platform: NodeJS.Platform, arch: string): DesktopPackageTargetName {
  const name = `${platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform}-${arch}`
  if (!isTargetName(name)) throw new Error(`desktop package: unsupported build host ${platform}-${arch}`)
  return name
}

/**
 * Parse the fixed-target packaging command line.
 * @param argv - Arguments after the script entry point.
 * @param hostPlatform - Build-host Node.js platform.
 * @param hostArch - Build-host Node.js architecture.
 * @returns The validated target and whether to emit an unpacked directory.
 */
export function parseDesktopPackageInvocation(
  argv: readonly string[],
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopPackageInvocation {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      dir: { type: 'boolean', default: false },
      'prepare-only': { type: 'boolean', default: false },
      unsigned: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
    },
  })
  if (positionals.length > 1) throw new Error('desktop package: expected at most one target')
  const name = positionals[0] ?? hostTargetName(hostPlatform, hostArch)
  if (values.unsigned && name !== 'win-x64') throw new Error('desktop package: --unsigned requires win-x64')
  if (values.unsigned && values['prepare-only']) throw new Error('desktop package: --unsigned cannot use --prepare-only')
  return {
    target: resolveDesktopPackageTarget(name, hostPlatform, hostArch),
    directory: values.dir,
    prepareOnly: values['prepare-only'],
    unsigned: values.unsigned,
    check: values.check,
  }
}

/**
 * Build the electron-builder command arguments for one validated target.
 * @param target - Supported release target.
 * @param directory - Whether to stop at an unpacked application directory.
 * @param artifact - Optional single artifact built from an existing signed application.
 * @returns Arguments that keep publishing under the separate validated upload command.
 */
export function desktopElectronBuilderArguments(
  target: DesktopPackageTarget,
  directory: boolean,
  artifact?: DesktopPrepackagedArtifact,
): readonly string[] {
  return [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.config.mjs',
    target.builderPlatform,
    ...(artifact === undefined ? [] : [artifact.format]),
    target.builderArch,
    '--publish',
    'never',
    ...(directory ? ['--dir'] : []),
    ...(artifact === undefined ? [] : [
      ...(target.platform === 'darwin' ? ['--config.mac.notarize=false'] : []),
      '--prepackaged', artifact.appPath,
      '--config.directories.output', artifact.output,
    ]),
  ]
}

/**
 * Resolve how many release tarballs pack at once.
 *
 * `release:pack` defaults to one worker because the credentialed publish
 * workflows require a serial prefix. Desktop packaging packs the whole family
 * only to consume it locally, and every member writes its own tarball, so the
 * members parallelize without changing what any tarball contains.
 * @param env - Packaging environment.
 * @returns Worker count from 1 through the host-derived limit.
 */
function desktopPackConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DESKTOP_PACK_CONCURRENCY_ENV]?.trim()
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`desktop package: ${DESKTOP_PACK_CONCURRENCY_ENV} must be a positive integer`)
    }
    return parsed
  }
  return Math.max(1, Math.min(DESKTOP_PACK_CONCURRENCY_LIMIT, availableParallelism()))
}

function runPnpm(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = APP_ROOT,
  run?: ReturnType<typeof createPackagingRun>,
): Promise<void> {
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined || pnpmEntry === '') {
    throw new Error('desktop package: invoke this script through a pnpm package command')
  }
  if (run !== undefined) return run.run(args.join(' '), process.execPath, [pnpmEntry, ...args], { cwd, env })
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [pnpmEntry, ...args], {
      cwd,
      env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop package: pnpm ${args.join(' ')} exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * 把构建期选定的通道写进随包发布的 enterprise.json。
 *
 * 普通用户锁定 default 指向的通道，登录页不渲染切换入口；internal 模式仍能看到全部通道。
 * @param root - 目标构建目录（清单与其它产物同级）。
 * @param environment - DSH_ENTERPRISE_ENVIRONMENT 的取值；缺省时不再写文件，源清单即最终清单。
 * @returns 烘焙后的清单路径（缺省通道时为构建目录下的目标路径，文件由 electron-builder 回落源清单）。
 * @throws 源清单结构/地址非法，或所选通道不存在时抛出，让打包直接失败。
 */
export function bakeEnterpriseManifest(root: string, environment?: string): string {
  const manifest = parseEnterpriseManifest(readFileSync(join(APP_ROOT, 'enterprise.json'), 'utf8'))
  const channel = resolveEnterpriseChannel(manifest, environment)
  const target = join(root, 'enterprise.json')
  // 没有构建期通道覆盖时，源清单的 default 就是最终结果：不写文件，
  // electron-builder 的 extraResources 会回落到 apps/desktop/enterprise.json。
  if (environment === undefined || environment === '') return target
  writeFileSync(target, `${JSON.stringify({
    '//': '由 apps/desktop/enterprise.json 于打包期生成；default 是普通用户锁定的通道，其余通道仅内部模式可见。',
    default: channel.locked.key,
    environments: manifest.environments,
  }, undefined, 2)}\n`)
  return target
}

async function main(): Promise<void> {
  const invocation = parseDesktopPackageInvocation(process.argv.slice(2))
  const { target } = invocation
  const environment = loadDesktopPackageEnvironment(target.platform)
  validateDesktopPackageEnvironment(environment, target, invocation)
  if (invocation.check) {
    process.stdout.write(`desktop package: ${target.name} local configuration valid; signing and notarization were not attempted\n`)
    return
  }
  const run = target.platform === 'win32'
    ? createPackagingRun(join(APP_ROOT, '.desktop-build', 'packaging-runs'), {
      target: target.name, unsigned: invocation.unsigned, version: packageVersion(join(APP_ROOT, 'package.json'), 'desktop package'),
    }) : undefined
  if (run !== undefined) console.log(`DESKTOP_PACKAGING_RECORD ${run.directory}`)
  let success = false
  try {
    if (target.platform === 'darwin') {
      await withMacOSSigningKeychain(environment, signingEnvironment => packageTarget(invocation, signingEnvironment, run))
    } else {
      await packageTarget(invocation, environment, run)
    }
    success = true
  } finally { run?.finish(success) }
}

/**
 * Prepare one release only after its signing preflight, without publishing from the builder.
 * @param invocation Validated host, target and packaging mode.
 * @param environment File-owned release configuration.
 * @param run Windows stage supervisor; required for signed Windows packaging.
 * @returns Resolves after preparation or complete packaging; any failed stage prevents a release record.
 */
export async function packageTarget(
  invocation: DesktopPackageInvocation,
  environment: NodeJS.ProcessEnv,
  run: ReturnType<typeof createPackagingRun> | undefined,
): Promise<void> {
  const { target } = invocation
  const execute = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string = APP_ROOT) => runPnpm(args, env, cwd, run)
  const buildPaths = desktopTargetBuildPaths(target.name)
  const releaseRecordPath = join(buildPaths.artifacts, desktopBuildRecordFilename(target.name))
  if (!invocation.prepareOnly && !invocation.unsigned) {
    rmSync(releaseRecordPath, { force: true })
    rmSync(`${releaseRecordPath}.tmp`, { force: true })
  }
  const buildEnv = withoutWindowsSigningEnvironment(withoutDesktopUploadCredentials(environment))
  const targetEnv: NodeJS.ProcessEnv = {
    ...buildEnv,
    DSH_DESKTOP_TARGET_PLATFORM: target.platform,
    DSH_DESKTOP_TARGET_ARCH: target.arch,
  }
  const electronBuilderEnv = desktopElectronBuilderEnvironment(targetEnv, invocation.unsigned)
  for (const name of WINDOWS_SIGNING_ENV_NAMES) {
    if (!invocation.unsigned && environment[name] !== undefined) electronBuilderEnv[name] = environment[name]
  }
  const signPrimaryRuntime = target.platform === 'win32' && !invocation.unsigned && !invocation.prepareOnly
  if (signPrimaryRuntime) {
    if (run === undefined) throw new Error('desktop package: signed Windows packaging requires a supervised run')
    await run.run('preflight:windows-signing', process.execPath,
      ['--import', 'tsx/esm', join(APP_ROOT, 'scripts/windows-signing-preflight.ts')],
      { cwd: APP_ROOT, env: electronBuilderEnv, timeoutMs: 60_000 })
  }
  const packConcurrency = desktopPackConcurrency()
  await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)
  await execute([
    'run', 'release:pack', '--family', 'dsh',
    '--out', buildPaths.packedDsh,
    '--concurrency', String(packConcurrency),
  ], buildEnv, REPOSITORY_ROOT)
  await execute([
    '--dir',
    'apps/desktop-host',
    'pack',
    '--pack-destination',
    buildPaths.packedDsh,
  ], buildEnv, REPOSITORY_ROOT)
  await execute([
    'run', 'release:pack', '--family', 'vendor',
    '--out', buildPaths.packedVendor,
    '--concurrency', String(packConcurrency),
  ], buildEnv, REPOSITORY_ROOT)
  rmSync(buildPaths.packedLandlock, { recursive: true, force: true })
  mkdirSync(buildPaths.packedLandlock, { recursive: true })
  await execute(['--dir', 'native/system', 'run', 'build:ts'], buildEnv, REPOSITORY_ROOT)
  await execute([
    '--dir',
    'native/system/packages/entry',
    'pack',
    '--pack-destination',
    buildPaths.packedLandlock,
  ], buildEnv, REPOSITORY_ROOT)
  await execute(['run', 'prepare:runtime', ...(signPrimaryRuntime ? ['--defer-primary-runtime-smoke'] : [])], targetEnv)
  if (signPrimaryRuntime) await execute(['run', 'sign:primary-runtime'], electronBuilderEnv)
  await execute(['run', 'prepare:packages'], targetEnv)
  await execute(['run', 'prepare:dsh'], targetEnv)
  // fork: 构建期通道烘焙必须先于 electron-builder（extraResources 引用该产物）
  bakeEnterpriseManifest(buildPaths.root, process.env.DSH_ENTERPRISE_ENVIRONMENT)
  if (invocation.prepareOnly) return
  if (target.platform === 'darwin' && !invocation.directory) {
    await execute([
      ...desktopElectronBuilderArguments(target, true),
      '--config.mac.notarize=false',
    ], electronBuilderEnv)
    await packageMacOSArtifacts({
      arch: target.arch,
      version: packageVersion(join(APP_ROOT, 'package.json'), 'desktop package'),
      artifactsRoot: buildPaths.artifacts,
      environment: electronBuilderEnv,
    }, artifact => execute(desktopElectronBuilderArguments(target, false, artifact), electronBuilderEnv))
  } else {
    await execute(desktopElectronBuilderArguments(target, invocation.directory), electronBuilderEnv)
  }
  if (!invocation.directory && !invocation.unsigned) writeReleaseRecord(target, electronBuilderEnv, buildPaths.artifacts)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
