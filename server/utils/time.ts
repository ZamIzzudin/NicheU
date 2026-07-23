import { env } from '../config/env';

export function getTimeZone(): string {
  return env.timezone || 'Asia/Jakarta';
}

export function formatDateInTz(date = new Date(), timeZone = getTimeZone()): string {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatTimeInTz(date = new Date(), timeZone = getTimeZone()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function nowParts(timeZone = getTimeZone()): { date: string; time: string; hour: number; minute: number } {
  const date = formatDateInTz(new Date(), timeZone);
  const time = formatTimeInTz(new Date(), timeZone);
  const [hour, minute] = time.split(':').map(Number);
  return { date, time, hour, minute };
}

export function parseHHMM(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(':').map(Number);
  return { hour: h || 0, minute: m || 0 };
}

export function minutesOfDay(hour: number, minute: number): number {
  return hour * 60 + minute;
}

export function isWithinQuietHours(
  now = new Date(),
  start = env.quietHoursStart,
  end = env.quietHoursEnd,
  timeZone = getTimeZone()
): boolean {
  if (!env.enableQuietHours) return false;
  const time = formatTimeInTz(now, timeZone);
  const [h, m] = time.split(':').map(Number);
  const cur = minutesOfDay(h, m);
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  const startM = minutesOfDay(s.hour, s.minute);
  const endM = minutesOfDay(e.hour, e.minute);

  if (startM === endM) return false;
  if (startM < endM) return cur >= startM && cur < endM;
  // overnight window e.g. 23:30-06:30
  return cur >= startM || cur < endM;
}

export function zonedDateTime(dateStr: string, hhmm: string, timeZone = getTimeZone()): Date {
  // Construct approximate Date from local wall time in timezone via iterative offset.
  // Good enough for personal scheduler.
  const [year, month, day] = dateStr.split('-').map(Number);
  const { hour, minute } = parseHHMM(hhmm);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = dtf.formatToParts(guess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const offset = asUTC - guess.getTime();
  return new Date(guess.getTime() - offset);
}

export function randomId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
