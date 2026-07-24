import { env } from '../config/env';

export type DayPeriod =
  | 'dini_hari'
  | 'pagi'
  | 'siang'
  | 'sore'
  | 'malam'
  | 'larut_malam';

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

export function nowParts(timeZone = getTimeZone()): {
  date: string;
  time: string;
  hour: number;
  minute: number;
} {
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

/**
 * Indonesian day periods (wall-clock in TIMEZONE):
 * 00:00-03:59 dini_hari
 * 04:00-09:59 pagi
 * 10:00-14:59 siang
 * 15:00-17:59 sore
 * 18:00-20:59 malam
 * 21:00-23:59 larut_malam
 */
export function periodOfDay(hour: number): DayPeriod {
  if (hour >= 0 && hour < 4) return 'dini_hari';
  if (hour >= 4 && hour < 10) return 'pagi';
  if (hour >= 10 && hour < 15) return 'siang';
  if (hour >= 15 && hour < 18) return 'sore';
  if (hour >= 18 && hour < 21) return 'malam';
  return 'larut_malam';
}

export function periodLabelId(period: DayPeriod): string {
  switch (period) {
    case 'dini_hari':
      return 'dini hari';
    case 'pagi':
      return 'pagi';
    case 'siang':
      return 'siang';
    case 'sore':
      return 'sore';
    case 'malam':
      return 'malam';
    case 'larut_malam':
      return 'larut malam';
  }
}

export function weekdayId(date = new Date(), timeZone = getTimeZone()): string {
  const name = new Intl.DateTimeFormat('id-ID', {
    timeZone,
    weekday: 'long',
  }).format(date);
  return name;
}

export function longDateId(date = new Date(), timeZone = getTimeZone()): string {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export type ClockContext = {
  timezone: string;
  date: string;
  time: string;
  hour: number;
  minute: number;
  period: DayPeriod;
  periodLabel: string;
  weekday: string;
  longDate: string;
  quietHours: boolean;
  greeting: string;
  antiPatterns: string[];
  behaviorHint: string;
  promptBlock: string;
};

export function buildClockContext(now = new Date(), timeZone = getTimeZone()): ClockContext {
  const date = formatDateInTz(now, timeZone);
  const time = formatTimeInTz(now, timeZone);
  const [hour, minute] = time.split(':').map(Number);
  const period = periodOfDay(hour);
  const periodLabel = periodLabelId(period);
  const weekday = weekdayId(now, timeZone);
  const longDate = longDateId(now, timeZone);
  const quiet = isWithinQuietHours(now, env.quietHoursStart, env.quietHoursEnd, timeZone);

  let greeting = 'halo';
  let behaviorHint = '';
  let antiPatterns: string[] = [];

  switch (period) {
    case 'dini_hari':
      greeting = 'masih begadang ya';
      behaviorHint =
        'Ini dini hari. Jangan sapaan "selamat siang/sore". Tone lembut, boleh nanya masih melek/kenapa belum tidur.';
      antiPatterns = ['selamat siang', 'selamat sore', 'udah makan siang', 'panas banget ya'];
      break;
    case 'pagi':
      greeting = 'selamat pagi';
      behaviorHint =
        'Ini pagi. Cocok sapaan pagi, nanya sarapan/berangkat. Jangan bilang "malam" atau "selamat malam".';
      antiPatterns = ['selamat malam', 'udah malam', 'mau tidur?', 'begadang'];
      break;
    case 'siang':
      greeting = 'siang';
      behaviorHint =
        'Ini siang. Boleh nanya makan siang/kerja. Jangan sapaan malam/pagi. Jangan anggap sudah sore/malam.';
      antiPatterns = ['selamat malam', 'selamat pagi', 'udah sore', 'mau tidur dulu'];
      break;
    case 'sore':
      greeting = 'sore';
      behaviorHint =
        'Ini SORE (bukan malam). Pakai "sore" / "udah sore". Jangan bilang "malam", "selamat malam", atau seolah larut malam.';
      antiPatterns = ['selamat malam', 'malam sayang', 'udah malam', 'tidur yaa', 'selamat pagi'];
      break;
    case 'malam':
      greeting = 'malam';
      behaviorHint =
        'Ini malam awal (18-21). Cocok "malam". Jangan seolah sudah larut/dini hari. Boleh nanya udah makan malam.';
      antiPatterns = ['selamat pagi', 'selamat siang', 'siang ini', 'sarapan'];
      break;
    case 'larut_malam':
      greeting = 'masih melek?';
      behaviorHint =
        'Ini larut malam. Tone pelan, boleh nanya istirahat. Jangan sapaan siang/pagi/sore.';
      antiPatterns = ['selamat pagi', 'selamat siang', 'selamat sore', 'makan siang'];
      break;
  }

  const promptBlock = [
    'WAKTU SEKARANG (SUMBER KEBENARAN — WAJIB DIPATUHI):',
    `- Timezone: ${timeZone}`,
    `- Tanggal: ${longDate} (${date})`,
    `- Jam: ${time}`,
    `- Periode: ${periodLabel.toUpperCase()}`,
    `- Sapaan yang cocok: "${greeting}"`,
    `- Quiet hours: ${quiet ? 'YA (jangan spam proaktif)' : 'tidak'}`,
    '',
    'ATURAN WAKTU (ketat):',
    `1. Sekarang ${periodLabel}. Semua sapaan/nuansa harus cocok dengan ${periodLabel}.`,
    `2. DILARANG pakai frasa yang salah periode, contoh: ${antiPatterns.map((x) => `"${x}"`).join(', ') || '-'}.`,
    `3. ${behaviorHint}`,
    '4. Jangan mengarang jam. Kalau disebut waktu, pakai jam di atas.',
    '5. Kalau user bilang "malam" padahal sekarang sore, koreksi lembut atau sesuaikan ("ini masih sore sih") tanpa kaku.',
    '6. Schedule/mood yang menyebut "malam" hanya relevan kalau periode memang malam/larut; jangan assume sekarang malam di sore hari.',
  ].join('\n');

  return {
    timezone: timeZone,
    date,
    time,
    hour,
    minute,
    period,
    periodLabel,
    weekday,
    longDate,
    quietHours: quiet,
    greeting,
    antiPatterns,
    behaviorHint,
    promptBlock,
  };
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
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  const offset = asUTC - guess.getTime();
  return new Date(guess.getTime() - offset);
}

export function randomId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
