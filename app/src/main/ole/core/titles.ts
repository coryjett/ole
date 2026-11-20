// Ole: whether a meeting title says nothing about the meeting ("Zoom call", "Meeting", "Untitled"). The host knows its
// own interface language and passes its own check (OleHost.genericTitle); this English one is the default when none is
// given, and matches Yogurt's titles.ts in English (a test pins that).

export type GenericTitle = (title: string) => boolean

/** what a call app or a calendar-less recording is named by default, in English */
const ENGLISH = /^(?:.{1,40} call|meeting|untitled|new note|google meet|(?:zoom|teams|microsoft teams|webex|slack) meeting)$/i

export const englishGenericTitle: GenericTitle = (title) => {
  const s = title.replace(/\s+/g, ' ').trim()
  return !s || ENGLISH.test(s)
}
