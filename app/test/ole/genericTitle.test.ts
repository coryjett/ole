// core/titles.ts's English default-title check agrees with Yogurt's titles.ts in English (#97): the core uses it only
// when the host gives no check of its own, and the replay export and auto-prepare tests run on it.
import { describe, expect, it } from 'vitest'
import { englishGenericTitle } from '../../src/main/ole/core/titles'
import { genericTitle } from '../../src/main/titles'

describe('default titles', () => {
  it('match Yogurt in English', () => {
    const titles = ['', '  ', 'Meeting', 'meeting', 'Untitled', 'New note', 'Google Meet', 'Zoom meeting', 'Microsoft Teams meeting', 'Slack meeting',
      'Zoom call', 'FaceTime call', 'Webex call', 'Acme: security review', 'Weekly sync', 'Call with Sam', 'Zoom  call', 'Meeting notes', 'a'.repeat(41) + ' call']
    for (const t of titles) expect([t, englishGenericTitle(t)]).toEqual([t, genericTitle(t)])
  })
})
