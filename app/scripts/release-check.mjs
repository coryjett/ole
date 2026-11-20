#!/usr/bin/env node
// Ole: release and update-feed checks (#26). Installed copies update from the newest release on coryjett/ole by
// reading its latest-mac.yml; a release must be complete, match what was built, be signed by the same certificate as
// the installed copies, point its feed at coryjett/ole, and be a higher version than the last one.
//
//   node scripts/release-check.mjs newer <version> [repo]        exit 1 unless <version> is above every published release
//   node scripts/release-check.mjs verify <tag> <identity-sha1> [repo]   download a (draft) release and check everything
//   node scripts/release-check.mjs feed [repo]                     read-only health check of what installed copies see
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'coryjett/ole'

/** semver order, pre-releases included: 0.1.0-alpha.9 < 0.1.0-alpha.10 < 0.1.0 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** the fields of electron-builder's latest-mac.yml that installed copies use */
export function parseLatestYml(text) {
  const out = { version: null, path: null, sha512: null, files: [] }
  let file = null
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    let m
    if ((m = line.match(/^version:\s*['"]?([^'"]+)['"]?$/))) out.version = m[1]
    else if ((m = line.match(/^path:\s*(.+)$/))) out.path = m[1].trim()
    else if ((m = line.match(/^sha512:\s*(.+)$/))) out.sha512 = m[1].trim()
    else if ((m = line.match(/^\s+-\s+url:\s*(.+)$/))) { file = { url: m[1].trim(), sha512: null, size: null }; out.files.push(file) }
    else if (file && (m = line.match(/^\s+sha512:\s*(.+)$/))) file.sha512 = m[1].trim()
    else if (file && (m = line.match(/^\s+size:\s*(\d+)$/))) file.size = Number(m[1])
  }
  return out
}

/** what's wrong with a release's update files, given its asset names and sizes; [] when installable */
export function feedProblems(yml, assets, tag) {
  const problems = []
  if (!yml.version) problems.push('latest-mac.yml has no version')
  else if (tag && `v${yml.version}` !== tag) problems.push(`latest-mac.yml says ${yml.version}, the release is ${tag}`)
  if (!yml.files.some(f => f.url.endsWith('.zip'))) problems.push('latest-mac.yml lists no .zip (the Mac updater installs the zip)')
  if (yml.path && !yml.files.some(f => f.url === yml.path)) problems.push(`latest-mac.yml path ${yml.path} is not in its files`)
  for (const f of yml.files) {
    const asset = assets.find(a => a.name === f.url)
    if (!asset) problems.push(`${f.url} is listed in latest-mac.yml but not uploaded`)
    else if (f.size != null && asset.size !== f.size) problems.push(`${f.url} is ${asset.size} bytes, latest-mac.yml says ${f.size}`)
    if (!f.sha512) problems.push(`${f.url} has no sha512 in latest-mac.yml`)
  }
  return problems
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64')

/** every release, drafts left out, newest version first */
function releases(repo) {
  const list = JSON.parse(sh('gh', ['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease']))
  return list.filter(r => !r.isDraft).map(r => r.tagName).sort((a, b) => compareVersions(b, a))
}

function assetsOf(repo, tag) {
  return JSON.parse(sh('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'])).assets.map(a => ({ name: a.name, size: a.size }))
}

/** download the release into a temp folder and check it end to end; returns the problems found */
export function verifyRelease(repo, tag, identitySha1) {
  // fail closed: the certificate check is the point, so a missing or malformed identity is an error, never "no constraint"
  if (!/^[0-9a-f]{40}$/i.test(String(identitySha1 ?? ''))) throw new Error('verify needs the 40-character SHA-1 of the "Ole Local" signing identity')
  const dir = mkdtempSync(join(tmpdir(), 'ole-verify-'))
  try {
    sh('gh', ['release', 'download', tag, '--repo', repo, '--dir', dir])
    const yml = parseLatestYml(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'))
    const problems = feedProblems(yml, assetsOf(repo, tag), tag)
    for (const f of yml.files) {
      const p = join(dir, f.url)
      try { if (sha512(p) !== f.sha512) problems.push(`${f.url} does not match its sha512 in latest-mac.yml`) } catch { /* reported above as missing */ }
    }
    const zip = yml.files.find(f => f.url.endsWith('.zip'))
    if (zip) {
      const out = join(dir, 'unzipped')
      sh('ditto', ['-x', '-k', join(dir, zip.url), out])
      const app = readdirSync(out).find(n => n.endsWith('.app'))
      if (!app) problems.push('the zip has no .app')
      else {
        const appPath = join(out, app)
        try { sh('codesign', ['--verify', '--deep', '--strict', appPath]) } catch (e) { problems.push(`codesign --verify failed: ${String(e.stderr || e.message).trim()}`) }
        // the designated requirement pins the signing certificate (certificate leaf = H"<sha1>"); codesign splits it across stdout and stderr
        const r = spawnSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8' })
        const req = `${r.stdout ?? ''}${r.stderr ?? ''}`
        if (/cdhash/.test(req) && !/certificate leaf/.test(req)) problems.push('the app has an ad-hoc signature (installed copies would refuse the update)')
        if (!req.toLowerCase().includes(identitySha1.toLowerCase())) problems.push('the app is not signed by the expected certificate (installed copies would refuse the update)')
        const feed = readFileSync(join(appPath, 'Contents/Resources/app-update.yml'), 'utf8')
        if (!/owner:\s*coryjett/.test(feed) || !/repo:\s*ole\s*$/m.test(feed) || /frigade|yogurt/i.test(feed)) problems.push('the app\'s update feed is not coryjett/ole')
        const v = sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(appPath, 'Contents/Info.plist')]).trim()
        if (`v${v}` !== tag) problems.push(`the app says version ${v}, the release is ${tag}`)
      }
    }
    return problems
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** what installed copies see now: the newest release and whether its update files are installable */
export function feedHealth(repo) {
  const tag = releases(repo)[0]
  if (!tag) return { tag: null, problems: ['no published release'] }
  const yml = parseLatestYml(sh('gh', ['release', 'download', tag, '--repo', repo, '--pattern', 'latest-mac.yml', '--output', '-']))
  return { tag, problems: feedProblems(yml, assetsOf(repo, tag), tag) }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b, c] = process.argv.slice(2)
  if (cmd === 'newer') {
    const newest = releases(b || REPO)[0]
    if (newest && compareVersions(a, newest) <= 0) { console.error(`${a} is not above the newest release ${newest}; installed copies would never update to it`); process.exit(1) }
    console.log(`${a} is above ${newest ?? 'nothing yet'}`)
  } else if (cmd === 'newest') {
    console.log(releases(a || REPO)[0] ?? '')
  } else if (cmd === 'verify') {
    const problems = verifyRelease(c || REPO, a, b)
    if (problems.length) { console.error(`${a} failed verification:\n- ${problems.join('\n- ')}`); process.exit(1) }
    console.log(`${a} verified: complete, matches its checksums, signed by the expected certificate, feed coryjett/ole`)
  } else if (cmd === 'feed') {
    const { tag, problems } = feedHealth(a || REPO)
    if (problems.length) { console.error(`update feed (${tag}) has problems:\n- ${problems.join('\n- ')}`); process.exit(1) }
    console.log(`update feed healthy: installed copies will update to ${tag}`)
  } else {
    console.error('usage: release-check.mjs newer <version> | verify <tag> <identity-sha1> | feed')
    process.exit(2)
  }
}
