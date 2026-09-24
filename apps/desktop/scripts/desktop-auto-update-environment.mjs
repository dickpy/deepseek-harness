/** Resolve the Desktop auto-update channel and its Tencent COS destination. */

import { valid } from 'semver'

/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV = 'DSH_DESKTOP_AUTO_UPDATE_ENV'

const UPDATE_ENVIRONMENTS = {
  // fork: 企业自托管更新源。产物由 IT 手动上传到自有 HTTPS 静态服务器，不走 COS。
  enterprise: {
    originEnvName: 'DSH_ENTERPRISE_UPDATE_ORIGIN',
    fixedOrigin: undefined,
    channel: 'latest',
    feedPath: '_/harness/desktop/stable',
    bucketEnvName: undefined,
    secretIdEnvName: undefined,
    secretKeyEnvName: undefined,
  },
  test: {
    originEnvName: 'DOWNLOAD_TEST_ORIGIN',
    fixedOrigin: undefined,
    channel: 'nightly',
    bucketEnvName: 'DOWNLOAD_TEST_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
  },
  production: {
    originEnvName: undefined,
    fixedOrigin: 'https://download.deepseek.com',
    channel: 'nightly',
    bucketEnvName: 'DOWNLOAD_PROD_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
  },
}

const UPDATE_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])

const UPDATE_CHANNELS = new Set(['latest', 'nightly'])

/** 维小智发布产物的文件名前缀，与 electron-builder 的 artifactName 共用。 */
export const DESKTOP_ARTIFACT_PREFIX = 'vtl-xiaozhi'

/**
 * Return the electron-builder artifact base name for one release target.
 * @param {string} version - Desktop semantic version.
 * @param {string} os - Target operating system segment (`mac` or `win`).
 * @param {string} arch - Target architecture segment.
 * @returns {string} Artifact base name without its extension.
 */
export function desktopArtifactBasename(version, os, arch) {
  return `${DESKTOP_ARTIFACT_PREFIX}-${version}-${os}-${arch}`
}

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @returns {'test' | 'production' | 'enterprise'} Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env) {
  const value = env[DESKTOP_AUTO_UPDATE_ENV]?.trim() || 'test'
  if (value !== 'test' && value !== 'production' && value !== 'enterprise') {
    throw new Error(`desktop auto-update: ${DESKTOP_AUTO_UPDATE_ENV} must be "test" or "production"`)
  }
  return value
}

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64'} Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return target
}

/**
 * Return the local completion record filename for one packaged target.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Supported release target.
 * @returns {string} Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target) {
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return `${target}-release.json`
}

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param {string} version - Desktop semantic version.
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {string} [channel] - Update channel prefix, for example 'latest' or 'nightly'.
 * @returns {string} Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version, platform, channel = 'nightly') {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop auto-update: unsupported metadata platform ${platform}`)
  }
  if (!UPDATE_CHANNELS.has(channel)) {
    throw new Error(`desktop auto-update: unsupported update channel ${JSON.stringify(channel)}`)
  }
  return `${channel}${platform === 'darwin' ? '-mac' : ''}.yml`
}

/**
 * Read one required release setting without accepting whitespace-only values.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} name - Environment variable to read.
 * @returns {string} Trimmed setting.
 */
function requiredEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop auto-update: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Normalize an HTTPS origin and reject paths or credentials.
 * @param {string} value - Candidate origin.
 * @param {string} name - Environment variable used in diagnostics.
 * @returns {string} Normalized HTTPS origin without a trailing slash.
 */
function httpsOrigin(value, name) {
  let parsed
  try {
    parsed = new URL(value)
  }
  catch {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin`)
  }
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== '') {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin without a path, credentials, query, or fragment`)
  }
  return parsed.origin
}

/**
 * Resolve the public updater URL and object prefixes for one release target.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string }} Resolved updater configuration.
 * @throws {Error} When the test deployment lacks a valid HTTPS origin or a 32-character lowercase hexadecimal release ID.
 */
export function resolveDesktopAutoUpdateConfig(env, platform, arch) {
  const environment = resolveDesktopAutoUpdateEnvironment(env)
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  const deployment = UPDATE_ENVIRONMENTS[environment]
  let origin = deployment.fixedOrigin
  if (origin === undefined) {
    const { originEnvName } = deployment
    if (originEnvName === undefined) throw new Error('desktop auto-update: selected deployment has no origin')
    origin = httpsOrigin(requiredEnvironmentValue(env, originEnvName), originEnvName)
  }
  let releasePrefix = 'dsh-desk'
  if (environment === 'test') {
    const releaseId = requiredEnvironmentValue(env, 'DOWNLOAD_TEST_RELEASE_ID')
    if (!/^[a-f0-9]{32}$/u.test(releaseId)) {
      throw new Error('desktop auto-update: DOWNLOAD_TEST_RELEASE_ID must contain 32 lowercase hexadecimal characters')
    }
    releasePrefix += `/${releaseId}`
  }
  const keyPrefix = environment === 'enterprise'
    ? `${deployment.feedPath}/${target}`
    : `${releasePrefix}/feeds/${target}`
  return {
    environment,
    target,
    channel: deployment.channel,
    origin,
    keyPrefix,
    binaryKeyPrefix: environment === 'enterprise'
      ? `${deployment.feedPath}/bin/${target}`
      : `${releasePrefix}/bin/${target}`,
    publicUrl: `${origin}/${keyPrefix}/`,
  }
}

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param {NodeJS.ProcessEnv} env - Upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string, bucket: string, secretIdEnvName: string, secretKeyEnvName: string }} Resolved upload configuration.
 * @throws {Error} When the selected deployment lacks a bucket or valid updater configuration.
 */
export function resolveDesktopUploadConfig(env, platform, arch) {
  const update = resolveDesktopAutoUpdateConfig(env, platform, arch)
  if (update.environment === 'enterprise') {
    throw new Error('desktop auto-update: enterprise deployment uses a self-hosted static server, not COS uploads')
  }
  const deployment = UPDATE_ENVIRONMENTS[update.environment]
  return {
    ...update,
    bucket: requiredEnvironmentValue(env, deployment.bucketEnvName),
    secretIdEnvName: deployment.secretIdEnvName,
    secretKeyEnvName: deployment.secretKeyEnvName,
  }
}
