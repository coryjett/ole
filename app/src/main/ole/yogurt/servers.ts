// Ole on Yogurt: the MCP server list (core/servers.ts) over Yogurt's settings file, and its IPC.
import { ipcMain } from 'electron'
import type { McpServerConfig } from '../core/types'
import { idFromName, isValidServerUrl, MAX_NAME, MAX_SERVERS, MAX_URL, serversOf, setServers as set, type ServerTest, type ServerToolInfo } from '../core/servers'
import { serverHandlers } from '../core/settingsHandlers'
import { fileSecrets, fileSettings } from './settingsFile'

export { idFromName, isValidServerUrl, MAX_NAME, MAX_SERVERS, MAX_URL, serversOf, type ServerTest, type ServerToolInfo }

/** replaces the list. Throws on a list that is not an array or holds more than 10; drops the key of any removed server */
export const setServers = (file: string, list: unknown): McpServerConfig[] => set(fileSettings(file), fileSecrets(file).remove, list)

export function hookOleServers(d: { file: string; test: ServerTest }): void {
  const h = serverHandlers({ settings: fileSettings(d.file), secrets: fileSecrets(d.file), test: d.test })
  ipcMain.handle('ole:servers:get', () => h.get())
  ipcMain.handle('ole:servers:set', (_e, list: unknown) => h.set(list))
  ipcMain.handle('ole:servers:test', (_e, id: unknown) => h.test(id))
}
