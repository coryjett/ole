// Ole: secret names, masking and status. The keys themselves are sealed and stored by the host (OleHost.secrets).
import type { OleSettings, SecretStore } from './host'
import { serversOf } from './servers'
import type { SecretName } from './types'

export type SecretStatus = Partial<Record<SecretName, { set: boolean; masked: string }>>

/** an MCP server id: lowercase letters, digits and dashes, 1 to 40 characters */
export const SERVER_ID = /^[a-z0-9-]{1,40}$/

/** 'openai', 'custom' (the Custom server's key, #17), or `mcp:<id>` for an MCP server's key */
export function isSecretName(name: unknown): name is SecretName {
  if (name === 'openai' || name === 'custom') return true
  return typeof name === 'string' && name.startsWith('mcp:') && SERVER_ID.test(name.slice(4))
}

/** the names Settings asks about by default: the OpenAI key and one per configured server */
export function defaultSecretNames(settings: OleSettings): SecretName[] {
  return ['openai', ...serversOf(settings).map((s) => `mcp:${s.id}` as SecretName)]
}

export function maskSecret(plain: string): string {
  if (plain === '') return ''
  if (plain.length <= 8) return '…' + plain.slice(-2)
  return plain.slice(0, 3) + '…' + plain.slice(-4)
}

export function secretStatus(read: SecretStore['read'], names: SecretName[]): SecretStatus {
  const status: SecretStatus = {}
  for (const name of names) {
    if (!isSecretName(name)) throw new Error('Invalid secret')
    const plain = read(name)
    status[name] = plain ? { set: true, masked: maskSecret(plain) } : { set: false, masked: '' }
  }
  return status
}

/** names from the UI: an array of valid names, at most 20; undefined means the defaults */
export function secretNamesFrom(settings: OleSettings, names: unknown): SecretName[] {
  if (names === undefined || names === null) return defaultSecretNames(settings)
  if (!Array.isArray(names) || names.length > 20 || !names.every(isSecretName)) throw new Error('Invalid secret')
  return [...new Set(names)]
}
