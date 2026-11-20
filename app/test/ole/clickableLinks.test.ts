import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const panel = readFileSync(join(__dirname, '../../src/renderer/src/ole/OlePanel.tsx'), 'utf8')

it('Prepare for… is a button; Someone else… and Not right? use the accent link style (#146)', () => {
  expect(panel).toMatch(/data-testid="ole-prepare-for-link" className="workspace-button"/)
  expect(panel).toMatch(/data-testid="ole-someone-else-link" className="ole-link/)
  expect(panel).toMatch(/data-testid="ole-not-right" className="ole-link/)
  expect(readFileSync(join(__dirname, '../../src/renderer/src/styles.css'), 'utf8')).toMatch(/\.ole-link \{[^}]*color:var\(--accent\)/)
})
