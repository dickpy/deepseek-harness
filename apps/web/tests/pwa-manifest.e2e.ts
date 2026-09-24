import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: '维小智',
    short_name: '维小智',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      {
        src: '/logo-256.png',
        sizes: '256x256',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/logo-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  })
})

it('ships the raster favicon assets the document references', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('href="./favicon.ico"')
  expect(index).toContain('href="./logo-128.png"')
  await expect(readFile(join(DIST_ROOT, 'favicon.ico'))).resolves.toBeDefined()
})
