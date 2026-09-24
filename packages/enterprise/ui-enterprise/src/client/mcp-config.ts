import type { EnterpriseConnector } from './enterprise-store.ts'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

interface McpServerConfig {
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
  type?: unknown
  transport?: unknown
  description?: unknown
  enabled?: unknown
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} must be a string`)
    out[key] = item
  }
  return out
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label} must be an array of strings`)
    result.push(item)
  }
  return result
}

/**
 * Pretty-print the current connector list in the standard MCP `mcpServers`
 * envelope. URL entries become streamable-http servers; command entries become
 * stdio servers. `description` and `enabled: false` are optional extensions
 * used by the visual connector list.
 */
export function formatMcpConfig(connectors: readonly EnterpriseConnector[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const connector of connectors) {
    const server: Record<string, unknown> = {}
    if (connector.transport === 'streamable-http') {
      server.url = connector.url
      if (Object.keys(connector.headers).length > 0) server.headers = { ...connector.headers }
    } else {
      server.command = connector.command
      if (connector.args.length > 0) server.args = [...connector.args]
      if (Object.keys(connector.env).length > 0) server.env = { ...connector.env }
    }
    if (connector.description !== '') server.description = connector.description
    if (!connector.enabled) server.enabled = false
    mcpServers[connector.name] = server
  }
  return JSON.stringify({ mcpServers }, null, 2)
}

/**
 * Parse the standard MCP JSON shape. Unknown keys are ignored so pasted
 * configurations from other MCP clients remain accepted.
 */
export function parseMcpConfig(text: string): EnterpriseConnector[] {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('root must be a JSON object')
  }
  const servers = (root as { mcpServers?: unknown }).mcpServers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error('mcpServers must be an object')
  }

  const connectors: EnterpriseConnector[] = []
  for (const [name, raw] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) throw new Error(`invalid server name: ${name}`)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`server ${name} must be an object`)
    }
    const config = raw as McpServerConfig
    const command = typeof config.command === 'string' ? config.command.trim() : ''
    const url = typeof config.url === 'string' ? config.url.trim() : ''
    const explicitHttp = config.type === 'http'
      || config.type === 'streamable-http'
      || config.transport === 'streamable-http'
    if (command === '' && url === '') throw new Error(`server ${name} needs a command or url`)

    if (url !== '' || explicitHttp) {
      if (url === '') throw new Error(`server ${name} needs a url`)
      connectors.push({
        name,
        transport: 'streamable-http',
        description: typeof config.description === 'string' ? config.description.trim() : '',
        command: '',
        args: [],
        env: {},
        url,
        headers: stringMap(config.headers, `server ${name}.headers`),
        enabled: config.enabled !== false,
      })
    } else {
      connectors.push({
        name,
        transport: 'stdio',
        description: typeof config.description === 'string' ? config.description.trim() : '',
        command,
        args: stringArray(config.args, `server ${name}.args`),
        env: stringMap(config.env, `server ${name}.env`),
        url: '',
        headers: {},
        enabled: config.enabled !== false,
      })
    }
  }
  return connectors.sort((left, right) => left.name.localeCompare(right.name))
}
