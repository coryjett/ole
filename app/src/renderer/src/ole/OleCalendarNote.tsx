// Ole: Settings > Calendars says when the Agenda's meetings come from a meetings server (#149), since a server may list
// only some of them. Shown only while the Mac calendar has none and a server supplies the list.
export function OleCalendarNote({ server }: { server?: string | null }) {
  if (!server) return null
  return <p data-testid="ole-calendar-server" className="settings-row settings-description">
    Meetings from {server}. It may list only some of your meetings.
  </p>
}
