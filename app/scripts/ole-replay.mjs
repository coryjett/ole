// Ole (#66): replay saved calls through the live bullets engine and report what it showed. Dev only, never packaged.
//   node scripts/ole-replay.mjs [--json] [--live] <fixture.json>...
// Recorded replies by default: no network, no keys. --live asks a real OpenAI-compatible model instead and sends it
// the fixture's transcript and briefing; it reads only OLE_REPLAY_API_KEY (required), OLE_REPLAY_BASE_URL (https,
// default OpenAI) and OLE_REPLAY_MODEL (default gpt-5.6-luna, the app's live default in providers.ts), never the
// OPENAI_* variables a shell may already hold. Lookups always answer from the fixture.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

const args = process.argv.slice(2)
const json = args.includes('--json'), live = args.includes('--live')
const files = args.filter(a => !a.startsWith('--'))
if (!files.length) {
  console.error('usage: node scripts/ole-replay.mjs [--json] [--live] <fixture.json>...')
  process.exit(2)
}

// the engine is TypeScript; vite's module runner loads it as the tests do
const load = async (rel) => (await runnerImport(fileURLToPath(new URL(rel, import.meta.url)), { configFile: false, logLevel: 'silent' })).module
const { replayCall, summarise } = await load('../src/main/ole/replay.ts')

let chat
if (live) {
  const { openaiChat, OPENAI_BASE_URL } = await load('../src/main/ole/openaiModel.ts')
  const key = process.env.OLE_REPLAY_API_KEY?.trim()
  if (!key) { console.error('--live needs OLE_REPLAY_API_KEY'); process.exit(2) }
  const baseUrl = process.env.OLE_REPLAY_BASE_URL?.trim() || OPENAI_BASE_URL
  let host
  try { const u = new URL(baseUrl); if (u.protocol !== 'https:') throw new Error(); host = u.host } catch {
    console.error('OLE_REPLAY_BASE_URL must be an https URL'); process.exit(2)
  }
  const model = process.env.OLE_REPLAY_MODEL?.trim() || 'gpt-5.6-luna'
  console.error(`--live: the fixture transcript and briefing are sent to ${host}`)
  chat = (req) => openaiChat({ key, model, baseUrl, ...req })
}

const reports = []
for (const file of files) {
  const report = await replayCall(JSON.parse(readFileSync(file, 'utf8')), chat ? { chat } : {})
  reports.push(report)
  if (!json) console.log(summarise(report) + '\n')
}
if (json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2))
