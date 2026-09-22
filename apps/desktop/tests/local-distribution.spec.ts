import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeLocalDistributionMetadata } from '../scripts/local-distribution.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local distribution metadata', () => {
  it('writes latest.yml and SHA256SUMS.txt for the packaged installer', async () => {
    const output = await mkdtemp(join(tmpdir(), 'dsh-local-distribution-'))
    roots.push(output)
    const bytes = Buffer.from('installer bytes')
    await writeFile(join(output, 'vtl-xiaozhi-0.0.6-win-x64.exe'), bytes)

    writeLocalDistributionMetadata({ version: '0.0.6', platform: 'win32', arch: 'x64', output })

    const latest = await readFile(join(output, 'latest.yml'), 'utf8')
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    expect(latest).toContain('version: 0.0.6')
    expect(latest).toContain('url: vtl-xiaozhi-0.0.6-win-x64.exe')
    expect(latest).toContain(`sha512: ${sha512}`)
    expect(latest).toContain(`size: ${String(bytes.length)}`)
    await expect(readFile(join(output, 'SHA256SUMS.txt'), 'utf8'))
      .resolves.toBe(`${sha256}  vtl-xiaozhi-0.0.6-win-x64.exe\n`)
  })
})
