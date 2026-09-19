import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  resolveWindowsUpdatePublisher,
  scrubWindowsSigningEnvironment,
} from './windows-sign.mjs'
import { DESKTOP_ARTIFACT_PREFIX, resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { installWindowsDirectoryInstaller } from './windows-directory-installer.mjs'
import { preserveWindowsRuntimeSignature } from './windows-runtime-signature.mjs'
import {
  resolveMacOSAppUpdateFeed,
  verifyMacOSAppUpdateConfig,
  writeMacOSAppUpdateConfig,
} from './macos-app-update-config.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Verified private dsh tree for installed-update qualification; ordinary releases use the target tree.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
) {
  const appId = resolveDesktopAppId(env)
  const policy = resolveDesktopPolicyEnvironment(env)
  // fork: 安装器形态。classic = electron-builder 经典 NSIS 界面，没有任何现场编译的
  // 原生 DLL，安全软件（Symantec 的 Heur.AdvML.B 等）不会拦；custom = 上游 0.1.6 的
  // 自绘目录安装器，需要 window-frame.dll，未签名时容易被启发式引擎拦截。
  const customInstaller = env.DSH_DESKTOP_INSTALLER === 'custom'
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  if (unsigned && resolvedPlatform !== 'win32') throw new Error('desktop package: unsigned builds require Windows')
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = resolvedPlatform === 'win32'
  if (resolvedPlatform === 'win32' && customInstaller) installWindowsDirectoryInstaller()
  const macOSSigning = packagesMacOS ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS) resolveMacOSNotarizationEnvironment(env)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  let primaryRuntimeDestination
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
        preserveSignature: async path => primaryRuntimeDestination === undefined ? false : preserveWindowsRuntimeSignature(path, {
          sourceRoot: join(buildPaths.runtime, 'primary-runtime'),
          destinationRoot: primaryRuntimeDestination,
          runDirectory: env.DSH_DESKTOP_PACKAGING_RUN_DIR,
        }),
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  // Fork patch: unsigned enterprise builds still embed the auto-update feed when
  // DSH_ENTERPRISE_UPDATE_ORIGIN is set (electron-updater skips signature
  // verification for unsigned Windows installs, so unsigned -> unsigned works).
  const update = unsigned && !env.DSH_ENTERPRISE_UPDATE_ORIGIN
    ? undefined
    : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  // fork: 桌面产品版本（appInfo.version，决定安装包名与更新版本）与内置 dsh 运行时版本已解耦；
  // 运行时描述符与 package set 记录的始终是 dsh 版本，所以这些 hook 必须读仓库根清单。
  const runtimeVersion = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
  ).version
  if (preparedRuntime !== undefined) buildPaths.dsh = preparedRuntime
  return {
    appId,
    extraMetadata: { dshDesktopAppId: appId, dshMandatoryUpdatePolicy: policy },
    productName: '维小智',
    // `artifactName` 是 electron-builder 的模板：单引号里的 `${...}` 保持字面量，
    // 由 builder 自己替换。前缀与 desktopArtifactBasename() 共用同一个常量。
    artifactName: DESKTOP_ARTIFACT_PREFIX + '-${version}-${os}-${arch}.${ext}',
    // fork: 免签名产物目录可用 DSH_DESKTOP_UNSIGNED_OUT_DIR 指到仓库外（避开工作区索引器的文件锁）
    directories: {
      output: unsigned
        ? (env.DSH_DESKTOP_UNSIGNED_OUT_DIR ?? join(buildPaths.root, 'unsigned-out'))
        : buildPaths.artifacts,
    },
    asar: true,
    electronDist: buildPaths.electron,
    electronFuses: { runAsNode: true },
    beforeBuild: async () => {
      // 经典安装器不用自绘资源，自然也不需要 Visual Studio 编译 window-frame.dll。
      if (resolvedPlatform !== 'win32' || !customInstaller) return true
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),
        '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {
        env: scrubWindowsSigningEnvironment(env), windowsHide: true,
      })
      if (windowsSigner !== undefined) {
        await windowsSigner({ path: join(buildPaths.root, 'installer-ui', 'window-frame.dll'), hash: 'sha256', isNest: false })
      }
      // A falsy result tells electron-builder to omit its production node_modules collection.
      return true
    },
    files: [
      'lib/main.js',
      'lib/preload-app.cjs',
      'lib/preload-mandatory.cjs',
      'lib/preload-update-dialog.cjs',
      'renderer/**/*',
      'package.json',
      { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    asarUnpack: [
      '**/*.{node,dylib,dll,so,exe}',
      '**/*.so.*',
      '**/spawn-helper',
      '**/@vscode/ripgrep/bin/rg',
    ],
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      // fork: 企业登录通道清单。打包期由 package-target.ts 按 DSH_ENTERPRISE_ENVIRONMENT
      // 烘焙到构建目录；直接调用 electron-builder 时回落到仓库内的源清单。
      {
        from: existsSync(join(buildPaths.root, 'enterprise.json'))
          ? join(buildPaths.root, 'enterprise.json')
          : 'enterprise.json',
        to: 'enterprise.json',
      },
      { from: fileURLToPath(new URL('../build/icon.png', import.meta.url)), to: 'icon.png' },
    ],
    mac: {
      icon: fileURLToPath(new URL('../build/icon.png', import.meta.url)),
      category: 'public.app-category.developer-tools',
      identity: macOSSigning?.signingIdentity,
      forceCodeSigning: true,
      hardenedRuntime: true,
      // ASAR-unpacked native runtime files are pre-signed; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '/Contents/Resources/runtime/primary-runtime(?:/|$)', '\\.pak$'],
      notarize: true,
      target: ['dmg', 'zip'],
    },
    dmg: {
      sign: true,
      writeUpdateInfo: false,
    },
    beforePack: async context => {
      if (windowsSigner !== undefined) primaryRuntimeDestination = join(context.appOutDir, 'resources', 'runtime', 'primary-runtime')
      if (policy === undefined) return
      const { resolveDesktopPolicyConfig } = await import('../lib/types/mandatory-update-policy.js')
      resolveDesktopPolicyConfig(policy)
    },
    afterPack: async context => {
      const { verifyDesktopRuntime, writeDesktopRuntime } = await import('../lib/types/runtime-tree.js')
      const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
      if (resolvedPlatform === 'darwin' && update !== undefined) {
        await writeMacOSAppUpdateConfig(resourcesDir, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      if (resolvedPlatform === 'win32' && !unsigned) {
        // Windows signs copied executable resources before afterPack runs.
        const prepared = await verifyDesktopRuntime(buildPaths.dsh,
          runtimeVersion, { platform: resolvedPlatform, arch: resolvedArch })
        writeDesktopRuntime(buildPaths.dsh, prepared.release, prepared.sharedPackages.map(entry => entry.name),
          { platform: resolvedPlatform, arch: resolvedArch })
      }
      await verifyDesktopRuntime(buildPaths.dsh,
        runtimeVersion, { platform: resolvedPlatform, arch: resolvedArch })
    },
    afterSign: async context => {
      if (context.electronPlatformName !== 'darwin') return
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      if (update !== undefined) {
        await verifyMacOSAppUpdateConfig(appPath, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (!artifact.file.endsWith('.dmg')) return
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      icon: fileURLToPath(new URL('../build/icon.ico', import.meta.url)),
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE),
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      category: 'Development',
      icon: fileURLToPath(new URL('../build/icon.png', import.meta.url)),
      target: ['AppImage'],
    },
    nsis: {
      // fork: 经典形态用随仓库带的品牌侧栏图；自绘形态用它自己生成的那套。
      installerSidebar: customInstaller
        ? join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp')
        : fileURLToPath(new URL('../installer/assets/sidebar.bmp', import.meta.url)),
      uninstallerSidebar: customInstaller
        ? join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp')
        : fileURLToPath(new URL('../installer/assets/sidebar.bmp', import.meta.url)),
      // 自绘页面与 DLL 只在自绘形态下注入。
      ...(customInstaller ? { include: fileURLToPath(new URL('./installer.nsh', import.meta.url)) } : {}),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      // 经典形态放开安装目录页（默认沿用上一次注册的安装目录）。
      allowToChangeInstallationDirectory: !customInstaller,
      installerLanguages: ['en_US', 'zh_CN'],
      differentialPackage: true,
    },
    detectUpdateChannel: false,
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: update.channel }],
  }
}
