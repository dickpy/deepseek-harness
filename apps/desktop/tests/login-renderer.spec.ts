import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { resolveDesktopLocale } from '../src/locale.ts'

interface LoginContextFixture {
  environments: { key: string; label: string; url: string }[]
  defaultUrl: string
  savedEmail: string
  appName: string
  internal: boolean
}

const LOCKED = { key: 'test', label: '测试', url: 'http://localhost:8080/api/v1' }
const OTHER = { key: 'production', label: '生产', url: 'https://dsh.example.com/api/v1' }

function login(
  context: Partial<LoginContextFixture> = {},
  submit: (payload: unknown) => Promise<{ ok: boolean; message?: string }> = async () => ({ ok: true }),
) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/login.html', import.meta.url), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  onTestFinished(() => { dom.window.close() })
  // jsdom 无 canvas 实现；彩带在自己的 getContext 为 null 时静默跳过。
  dom.window.HTMLCanvasElement.prototype.getContext = () => null
  const complete = vi.fn(async () => {})
  const submitMock = vi.fn(submit)
  const api = {
    context: async () => ({
      environments: [LOCKED],
      defaultUrl: LOCKED.url,
      savedEmail: '',
      appName: '维小智',
      internal: false,
      ...context,
    }),
    submit: submitMock,
    complete,
  }
  Object.defineProperty(dom.window, 'dshDesktop', {
    value: { locale: async () => resolveDesktopLocale('zh-CN'), enterprise: api },
  })
  runInContext(readFileSync(new URL('../renderer/login.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const document = dom.window.document
  const element = (id: string): HTMLElement => {
    const node = document.getElementById(id)
    if (node === null) throw new Error(`Missing login element: ${id}`)
    return node
  }
  const ready = async (): Promise<void> => {
    await expect.poll(() => element('email-label').textContent).not.toBe('')
  }
  const paint = async (email: string, password: string): Promise<void> => {
    ;(element('email') as HTMLInputElement).value = email
    ;(element('password') as HTMLInputElement).value = password
    element('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }))
  }
  return { dom, document, element, complete, submit: submitMock, ready, paint }
}

it('locks ordinary users to the shipped channel without rendering a switcher', async () => {
  const page = login()
  await page.ready()
  expect(page.element('env-field').hidden).toBe(true)
  expect(page.element('internal-badge').hidden).toBe(true)
  expect(page.document.querySelectorAll('#env option')).toHaveLength(1)
  expect((page.element('env') as HTMLSelectElement).value).toBe(LOCKED.url)
  expect(page.element('submit-label').textContent).toBe('登 录')
})

it('offers every channel only in internal mode', async () => {
  const page = login({ internal: true, environments: [LOCKED, OTHER] })
  await page.ready()
  expect(page.element('env-field').hidden).toBe(false)
  expect(page.element('internal-badge').hidden).toBe(false)
  expect([...page.document.querySelectorAll('#env option')].map(option => option.textContent)).toEqual(['测试', '生产'])
})

it('prefills the saved account without exposing the password', async () => {
  const page = login({ savedEmail: 'zhangsan@company.com' })
  await page.ready()
  expect((page.element('email') as HTMLInputElement).value).toBe('zhangsan@company.com')
  expect((page.element('password') as HTMLInputElement).value).toBe('')
})

it('reveals and hides the password through the labelled toggle', async () => {
  const page = login()
  await page.ready()
  const password = page.element('password') as HTMLInputElement
  const reveal = page.element('reveal')
  expect(password.type).toBe('password')
  expect(reveal.getAttribute('aria-label')).toBe('显示密码')
  reveal.click()
  expect(password.type).toBe('text')
  expect(reveal.getAttribute('aria-pressed')).toBe('true')
  expect(reveal.getAttribute('aria-label')).toBe('隐藏密码')
  reveal.click()
  expect(password.type).toBe('password')
})

it('celebrates only after the server accepts the credentials', async () => {
  const page = login()
  await page.ready()
  await page.paint('zhangsan@company.com', 'secret')
  await expect.poll(() => page.element('card').className).toContain('is-success')
  expect(page.submit).toHaveBeenCalledWith({
    serverUrl: LOCKED.url,
    email: 'zhangsan@company.com',
    password: 'secret',
  })
  expect(page.element('heading').textContent).toBe('欢迎回来')
  expect(page.element('description').textContent).toContain('登录成功')
  // 主进程已落盘令牌，渲染层播完动效后回调放行启动
  await expect.poll(() => page.complete.mock.calls.length, { timeout: 5_000 }).toBe(1)
})

it('keeps the window open, shows the reason, and never celebrates on rejection', async () => {
  const page = login({}, async () => ({ ok: false, message: '账号或密码错误' }))
  await page.ready()
  await page.paint('zhangsan@company.com', 'wrong')
  await expect.poll(() => page.element('error').hidden).toBe(false)
  expect(page.element('error').textContent).toBe('账号或密码错误')
  expect(page.element('card').className).not.toContain('is-success')
  expect(page.element('spinner').hidden).toBe(true)
  expect(page.element('submit-label').textContent).toBe('登 录')
  expect(page.complete).not.toHaveBeenCalled()
})

it('surfaces a transport failure instead of silently staying busy', async () => {
  const page = login({}, async () => { throw new Error('fetch failed') })
  await page.ready()
  await page.paint('zhangsan@company.com', 'secret')
  await expect.poll(() => page.element('error').textContent).toBe('Error: fetch failed')
  expect(page.element('submit-label').textContent).toBe('登 录')
  expect(page.complete).not.toHaveBeenCalled()
})
