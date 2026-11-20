// Ole: the one way Ole's per-meeting files get a path (#156). Only a meeting UUID and a known Ole file name are
// accepted, and the result must stay under <data>/meetings/<id>/.
import { join, resolve, sep } from 'node:path'

const MEETING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const OLE_MEETING_FILES = ['ole-bullets.json', 'ole-answers.json', 'ole-call.json', 'ole-org.json', 'ole-briefing.md', 'ole-turns.json'] as const
export type OleMeetingFile = (typeof OLE_MEETING_FILES)[number]

export function oleMeetingFile(dataDir: string, id: string, name: OleMeetingFile): string {
  if (typeof id !== 'string' || !MEETING_ID.test(id)) throw new Error('not a meeting id')
  if (!(OLE_MEETING_FILES as readonly string[]).includes(name)) throw new Error('not an Ole meeting file')
  const root = resolve(join(dataDir, 'meetings'))
  const path = resolve(join(root, id, name))
  if (!path.startsWith(root + sep)) throw new Error('outside the meetings folder')
  return path
}
