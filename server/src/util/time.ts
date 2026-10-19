// Date helpers. "Local" means the garden's timezone: config.ts sets process.env.TZ
// before anything else runs, so plain Date methods already use it.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** YYYY-MM-DD for the local calendar day. */
export const localDate = (d: Date) => d.toLocaleDateString('en-CA');

/** A wall-clock time on a local date. */
export const localTime = (date: string, hour: number, minute = 0) =>
  new Date(`${date}T${pad(hour)}:${pad(minute)}:00`);

/** "5:30 AM" */
export const fmtClock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Tue 5:30 AM" */
export const fmtDayTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "45 s", "12 min", "1 h 5 min" */
export function fmtDuration(ms: number): string {
  if (ms < MIN) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

const pad = (n: number) => String(n).padStart(2, '0');
