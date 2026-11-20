// a default import, so plain Node (local recording checks) can load this file too
import electron from 'electron'
import { join } from 'node:path'
import { DATA_FOLDER } from '../shared/brand'

/** One profile folder however Ole is started (dev, packaged): ~/Library/Application Support/Ole, never Yogurt's. YOGURT_USER_DATA uses a separate one (tests) */
export const userDataDir = (): string => process.env.YOGURT_USER_DATA ?? join(electron.app.getPath('appData'), DATA_FOLDER)

/** Test mode: stand-ins for everything that needs a model, the microphone or a calendar */
export const isFake = (): boolean => process.env.YOGURT_FAKE === '1'
