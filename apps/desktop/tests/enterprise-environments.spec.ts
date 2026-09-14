import { describe, expect, it } from 'vitest'
import {
  assertLoginSender,
  LOGIN_PAGE_URL,
  manifestFromEnvironment,
  normalizeEnvironmentUrl,
  parseEnterpriseManifest,
  resolveEnterpriseChannel,
} from '../src/enterprise-environments.ts'

const MANIFEST = JSON.stringify({
  default: 'test',
  environments: [
    { key: 'test', label: '测试', url: 'http://localhost:8080/api/v1' },
    { key: 'production', label: '生产', url: 'https://dsh.example.com/api/v1' },
  ],
})

describe('enterprise environment address', () => {
  it('keeps a deployment path prefix and drops a trailing slash', () => {
    expect(normalizeEnvironmentUrl('http://localhost:8080/api/v1/', 'url')).toBe('http://localhost:8080/api/v1')
    expect(normalizeEnvironmentUrl('https://host/dsh/api/v1', 'url')).toBe('https://host/dsh/api/v1')
  })

  it('rejects an address the client cannot append /client/enroll to', () => {
    expect(() => normalizeEnvironmentUrl('http://localhost:8080/', 'url')).toThrow(/must end with \/api\/v1/u)
    expect(() => normalizeEnvironmentUrl('http://localhost:8080', 'url')).toThrow(/must end with \/api\/v1/u)
    expect(() => normalizeEnvironmentUrl('dsh.example.com/api/v1', 'url')).toThrow(/must be an absolute URL/u)
    expect(() => normalizeEnvironmentUrl('ftp://host/api/v1', 'url')).toThrow(/must use http or https/u)
  })
})

describe('enterprise manifest parsing', () => {
  it('reads the declared default and every channel in order', () => {
    expect(parseEnterpriseManifest(MANIFEST)).toEqual({
      defaultKey: 'test',
      environments: [
        { key: 'test', label: '测试', url: 'http://localhost:8080/api/v1' },
        { key: 'production', label: '生产', url: 'https://dsh.example.com/api/v1' },
      ],
    })
  })

  it('names an entry without a key so it stays selectable', () => {
    const parsed = parseEnterpriseManifest(JSON.stringify({
      environments: [{ label: '默认', url: 'https://host/api/v1' }],
    }))
    expect(parsed.defaultKey).toBeNull()
    expect(parsed.environments[0]?.key).toBe('environment-1')
  })

  it('fails loud instead of degrading to a disabled gate', () => {
    expect(() => parseEnterpriseManifest('not json')).toThrow(/not valid JSON/u)
    expect(() => parseEnterpriseManifest('[]')).toThrow(/must contain a JSON object/u)
    expect(() => parseEnterpriseManifest('{}')).toThrow(/environments must be a non-empty array/u)
    expect(() => parseEnterpriseManifest('{"environments": ["x"]}')).toThrow(/must be an object/u)
    expect(() => parseEnterpriseManifest('{"environments": [{"label": "", "url": "https://h/api/v1"}]}'))
      .toThrow(/label must be a non-empty string/u)
    expect(() => parseEnterpriseManifest('{"environments": [{"label": "a", "url": "https://h/api/v1"}, {"key": "environment-1", "label": "b", "url": "https://h/api/v1"}]}'))
      .toThrow(/duplicate environment key/u)
    expect(() => parseEnterpriseManifest('{"default": "staging", "environments": [{"key": "test", "label": "t", "url": "https://h/api/v1"}]}'))
      .toThrow(/default "staging" is not one of test/u)
  })
})

describe('locked enterprise channel', () => {
  const manifest = parseEnterpriseManifest(MANIFEST)

  it('locks ordinary users to the declared default', () => {
    expect(resolveEnterpriseChannel(manifest).locked.key).toBe('test')
    expect(resolveEnterpriseChannel(manifest).all).toHaveLength(2)
  })

  it('lets the packaging environment override the default channel', () => {
    expect(resolveEnterpriseChannel(manifest, 'production').locked.url).toBe('https://dsh.example.com/api/v1')
    expect(resolveEnterpriseChannel(manifest, '  ').locked.key).toBe('test')
  })

  it('rejects a channel that is not in the shipped manifest', () => {
    expect(() => resolveEnterpriseChannel(manifest, 'staging')).toThrow(/channel "staging" is not one of test, production/u)
  })

  it('falls back to the first channel when the manifest declares no default', () => {
    const undeclared = parseEnterpriseManifest(JSON.stringify({
      environments: [{ key: 'only', label: '唯一', url: 'https://host/api/v1' }],
    }))
    expect(resolveEnterpriseChannel(undeclared).locked.key).toBe('only')
  })
})

describe('runtime environment fallback', () => {
  it('is absent when no address is configured', () => {
    expect(manifestFromEnvironment({})).toBeNull()
  })

  it('builds channels from the development environment variables', () => {
    const manifest = manifestFromEnvironment({
      DSH_ENTERPRISE_SERVER_URL: 'https://prod.example.com/api/v1',
      DSH_ENTERPRISE_TEST_SERVER_URL: 'http://localhost:8080/api/v1',
    })
    expect(manifest?.environments.map(entry => entry.key)).toEqual(['default', 'test'])
  })
})

describe('login page IPC guard', () => {
  const event = (url: string | null) => ({ senderFrame: url === null ? null : { url } })

  it('accepts the exact page the login window loads', () => {
    // 载入地址与发送方校验必须指向同一页面：历史上两者主机名不一致（shell vs login），
    // 导致登录页的每一次 IPC 都被拒绝、门禁永远无法通过。
    expect(new URL(LOGIN_PAGE_URL).hostname).toBe('shell')
    expect(new URL(LOGIN_PAGE_URL).pathname).toBe('/login.html')
    expect(() => assertLoginSender(event(LOGIN_PAGE_URL))).not.toThrow()
  })

  it('rejects every frame that is not the login page itself', () => {
    expect(() => assertLoginSender(event(null))).toThrow(/without a sender frame/u)
    expect(() => assertLoginSender(event('dsh-app://app/index.html'))).toThrow(/unowned renderer/u)
    expect(() => assertLoginSender(event('dsh-app://shell/startup.html'))).toThrow(/unowned renderer/u)
    expect(() => assertLoginSender(event('dsh-app://shell/plugin-manager.html'))).toThrow(/unowned renderer/u)
    expect(() => assertLoginSender(event('dsh-app://evil/login.html'))).toThrow(/unowned renderer/u)
    expect(() => assertLoginSender(event('https://shell/login.html'))).toThrow(/unowned renderer/u)
    expect(() => assertLoginSender(event('file:///C:/login.html'))).toThrow(/unowned renderer/u)
  })
})
