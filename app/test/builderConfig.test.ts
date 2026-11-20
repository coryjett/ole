import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Windows checks the file out with CRLF line endings
const config = readFileSync(join(__dirname, '../electron-builder.yml'), 'utf8').replaceAll('\r\n', '\n')

it('uninstalling on Windows never deletes the profile: it holds every meeting', () => {
  expect(config).toMatch(/^nsis:\n(?:  .*\n)*  deleteAppDataOnUninstall: false$/m)
  expect(config).not.toMatch(/deleteAppDataOnUninstall: true/)
})

it('Windows and Linux builds have fixed file names, like the Mac one', () => {
  expect(config).toContain('artifactName: Ole-mac-${arch}.${ext}')
  expect(config).toContain('artifactName: Yogurt-windows-${arch}.${ext}')
  expect(config).toContain('artifactName: Yogurt-linux-${arch}.${ext}')
})

it("only Windows and Linux carry the colour tray icons (the Mac's package keeps its own files)", () => {
  const block = (name: string) => config.match(new RegExp(`^${name}:\\n((?:  .*\\n|\\n)*)`, 'm'))?.[1] ?? ''
  for (const os of ['win', 'linux']) expect(block(os)).toContain('filter: ["tray-color*.png", "tray-recording*.png"]')
  expect(config.split(/^win:$/m)[0]).not.toContain('tray-color')
})

it("only Windows and Linux carry the speed check's clip: a Mac never times its speech model", () => {
  const block = (name: string) => config.match(new RegExp(`^${name}:\\n((?:  .*\\n|\\n)*)`, 'm'))?.[1] ?? ''
  for (const os of ['win', 'linux']) expect(block(os)).toContain('{ from: resources/speed, to: speed }')
  expect(config.split(/^win:$/m)[0]).not.toContain('resources/speed')
})

it('the Linux build starts through the launcher that picks X11 on Wayland (#8)', () => {
  expect(config).toMatch(/^afterPack: scripts\/linux-launcher\.cjs$/m)
})

it("Ole updates from its own release feed, never Yogurt's", () => {
  const publish = config.match(/^publish:\n((?:  .*\n)*)/m)?.[1] ?? ''
  expect(publish).toContain('provider: github')
  expect(publish).toMatch(/^  owner: coryjett$/m)
  expect(publish).toMatch(/^  repo: ole$/m)
  expect(publish).not.toMatch(/frigadehq|yogurt/i)
})
