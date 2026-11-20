// Ole: keeps Ole's windows out of screen sharing and recordings (#51). macOS and Windows honour it for most capture;
// some capture paths (newer macOS screen capture in a few apps) may still show the window, so it is best effort.
/** protected only while a call records, so screenshots work the rest of the time (#61) */
export const shouldProtect = (setting: boolean, recording: boolean): boolean => setting && recording

type Protectable = { setContentProtection?(on: boolean): void; isDestroyed?(): boolean }

export function protectFromCapture(windows: Protectable[], on: boolean): void {
  for (const w of windows) {
    if (w.isDestroyed?.() || !w.setContentProtection) continue
    try { w.setContentProtection(on) } catch (e) { console.warn('could not change screen-sharing protection', e) }
  }
}
