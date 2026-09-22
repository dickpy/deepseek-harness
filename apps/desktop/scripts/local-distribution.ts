/** Local unsigned distribution metadata matching electron-updater's latest.yml shape. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopArtifactBasename, resolveDesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'

export interface LocalDistributionInput {
  readonly version: string
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly output: string
}

/** Write latest.yml and SHA256SUMS.txt beside one local installer. */
export function writeLocalDistributionMetadata(input: LocalDistributionInput): void {
  const target = resolveDesktopAutoUpdateTarget(input.platform, input.arch)
  const os = target.startsWith('mac-') ? 'mac' : 'win'
  const artifact = desktopArtifactBasename(input.version, os, input.arch)
  const installer = join(input.output, `${artifact}.exe`)
  if (!existsSync(installer)) throw new Error(`desktop distribution: missing installer ${installer}`)
  const bytes = readFileSync(installer)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const releaseDate = new Date().toISOString()
  const filename = `${artifact}.exe`
  const latest = [
    `version: ${input.version}`,
    'files:',
    `  - url: ${filename}`,
    `    sha512: ${sha512}`,
    `    size: ${String(bytes.length)}`,
    `path: ${filename}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
  writeFileSync(join(input.output, 'latest.yml'), latest)
  writeFileSync(join(input.output, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`)
}
