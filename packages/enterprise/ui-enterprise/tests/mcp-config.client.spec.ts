import { describe, expect, it } from 'vitest'
import { formatMcpConfig, parseMcpConfig } from '../src/client/mcp-config.ts'

describe('MCP JSON configuration', () => {
  it('formats and parses stdio and HTTP servers', () => {
    const text = formatMcpConfig([
      {
        name: 'local', transport: 'stdio', description: '', command: 'npx',
        args: ['-y', 'server'], env: { TOKEN: 'x' }, url: '', headers: {}, enabled: true,
      },
      {
        name: 'remote', transport: 'streamable-http', description: 'Remote', command: '',
        args: [], env: {}, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, enabled: false,
      },
    ])
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'x' } },
        remote: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
          description: 'Remote',
          enabled: false,
        },
      },
    })
    expect(parseMcpConfig(text)).toEqual([
      {
        name: 'local', transport: 'stdio', description: '', command: 'npx',
        args: ['-y', 'server'], env: { TOKEN: 'x' }, url: '', headers: {}, enabled: true,
      },
      {
        name: 'remote', transport: 'streamable-http', description: 'Remote', command: '',
        args: [], env: {}, url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' }, enabled: false,
      },
    ])
  })

  it('accepts an empty mcpServers object and rejects malformed servers', () => {
    expect(parseMcpConfig('{"mcpServers":{}}')).toEqual([])
    expect(() => parseMcpConfig('{"servers":{}}')).toThrow('mcpServers')
    expect(() => parseMcpConfig('{"mcpServers":{"bad name":{}}}')).toThrow('invalid server name')
    expect(() => parseMcpConfig('{"mcpServers":{"x":{}}}')).toThrow('command or url')
  })
})
