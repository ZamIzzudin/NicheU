import {
  Activity,
  DailySchedule,
  MoodLabel,
  PersonaProfile,
  ProactiveMessage,
} from '../../../shared/types';
import { Client } from '../../core/client';
import { Database } from '../../db/mongo';
import {
  buildClockContext,
  formatDateInTz,
  formatTimeInTz,
  randomId,
  zonedDateTime,
  getTimeZone,
} from '../../utils/time';

export class ScheduleService {
  constructor(private db: Database, private client: Client) {}

  async getToday(userId: string, date = formatDateInTz()): Promise<DailySchedule | null> {
    return this.db.schedules.findOne({ userId, date });
  }

  async ensureToday(
    userId: string,
    persona?: PersonaProfile | null,
    moodLabel?: MoodLabel
  ): Promise<DailySchedule> {
    const date = formatDateInTz();
    const existing = await this.getToday(userId, date);
    if (existing) return existing;
    return this.generateForDate(userId, date, persona, moodLabel);
  }

  async generateForDate(
    userId: string,
    date: string,
    persona?: PersonaProfile | null,
    moodLabel?: MoodLabel
  ): Promise<DailySchedule> {
    const system = `Generate a realistic fictional daily schedule for a partner character.
Return ONLY JSON:
{
  "summary": "short day vibe",
  "activities": [
    {
      "title": "string",
      "description": "string",
      "start": "HH:MM",
      "end": "HH:MM",
      "note": "optional"
    }
  ]
}
Rules:
- 6 to 10 activities between 07:00 and 22:30 local time.
- Mix work/chores/self-care/social/rest; keep human and non-extreme.
- No overlapping times; chronological.
- Language Indonesian for titles/descriptions.
- Fit persona and mood if provided (e.g. sedih => softer day, lebih rest; semangat => lebih aktif).`;

    const userPrompt = `Date: ${date}
Timezone: ${getTimeZone()}
Mood today: ${moodLabel || 'netral'}
Persona: ${persona ? JSON.stringify({
      name: persona.name,
      role: persona.role,
      traits: persona.traits,
      speechStyle: persona.speechStyle,
    }) : 'warm partner'}
`;

    let activities: Activity[] = [];
    let summary = 'Hari yang biasa-biasa saja, tetap hangat.';

    try {
      const result = await this.client.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.8, responseFormat: { type: 'json_object' } }
      );
      const parsed = JSON.parse(this.cleanJson(result.content));
      summary = String(parsed.summary || summary);
      const list = Array.isArray(parsed.activities) ? parsed.activities : [];
      activities = list
        .map((a: any) => this.toActivity(date, a))
        .filter((a: Activity | null): a is Activity => Boolean(a))
        .sort((a: Activity, b: Activity) => a.startAt.getTime() - b.startAt.getTime());
    } catch (error) {
      console.warn('Schedule generation failed, using fallback:', (error as Error).message);
      activities = this.fallbackActivities(date);
    }

    if (!activities.length) activities = this.fallbackActivities(date);

    const schedule: DailySchedule = {
      userId,
      date,
      activities,
      generatedAt: new Date(),
      summary,
      moodLabel,
    };

    await this.db.schedules.updateOne(
      { userId, date },
      { $set: schedule },
      { upsert: true }
    );

    await this.queueLifecycleMessages(userId, schedule);
    return schedule;
  }

  async tick(userId: string): Promise<{ updated: number; events: Array<{ type: string; activity: Activity }> }> {
    const schedule = await this.ensureToday(userId);
    const now = Date.now();
    let updated = 0;
    const events: Array<{ type: string; activity: Activity }> = [];

    for (const activity of schedule.activities) {
      const start = new Date(activity.startAt).getTime();
      const end = new Date(activity.endAt).getTime();

      if (activity.status === 'planned' && now >= start && now < end) {
        activity.status = 'ongoing';
        updated++;
        events.push({ type: 'activity_start', activity });
      } else if (
        (activity.status === 'planned' || activity.status === 'ongoing') &&
        now >= end
      ) {
        activity.status = 'done';
        updated++;
        events.push({ type: 'activity_end', activity });
      }
    }

    if (updated) {
      await this.db.schedules.updateOne(
        { userId, date: schedule.date },
        { $set: { activities: schedule.activities } }
      );
    }

    return { updated, events };
  }

  formatTodayContext(schedule: DailySchedule | null): string {
    const clock = buildClockContext();
    if (!schedule) {
      return `Belum ada jadwal hari ini. (Sekarang ${clock.time} ${clock.periodLabel})`;
    }
    const lines = [
      `Tanggal jadwal: ${schedule.date}`,
      `Sekarang: ${clock.time} (${clock.periodLabel}) ${clock.timezone}`,
      `Vibe: ${schedule.summary || '-'}`,
      'Aktivitas:',
    ];

    for (const a of schedule.activities) {
      const start = formatTimeInTz(new Date(a.startAt));
      const end = formatTimeInTz(new Date(a.endAt));
      lines.push(`- [${a.status}] ${start}-${end} ${a.title}${a.note ? ` (${a.note})` : ''}`);
    }

    const ongoing = schedule.activities.find((a) => a.status === 'ongoing');
    const next = schedule.activities.find((a) => a.status === 'planned');
    if (ongoing) lines.push(`Sedang berlangsung: ${ongoing.title}`);
    if (next) lines.push(`Berikutnya: ${next.title} @ ${formatTimeInTz(new Date(next.startAt))}`);
    else lines.push('Tidak ada aktivitas planned berikutnya (relatif sekarang).');
    return lines.join('\n');
  }

  private async queueLifecycleMessages(userId: string, schedule: DailySchedule) {
    const docs: ProactiveMessage[] = [];
    const now = Date.now();

    // Only schedule key day checkpoints (avoid start+end for every activity = spam)
    docs.push({
      userId,
      type: 'morning_greeting',
      dueAt: zonedDateTime(schedule.date, '08:00'),
      payload: { textHint: 'Sapaan pagi hangat, sebut sedikit rencana hari ini.' },
      status: 'pending',
      createdAt: new Date(),
    });
    docs.push({
      userId,
      type: 'midday_checkin',
      dueAt: zonedDateTime(schedule.date, '12:30'),
      payload: { textHint: 'Check-in siang, tanya kabar user.' },
      status: 'pending',
      createdAt: new Date(),
    });
    docs.push({
      userId,
      type: 'evening_wrap',
      dueAt: zonedDateTime(schedule.date, '21:00'),
      payload: { textHint: 'Wrap malam, ceritakan hari secara singkat, tanya user.' },
      status: 'pending',
      createdAt: new Date(),
    });

    // Pick up to 3 "notable" activities for end notifications only (less noisy)
    const notables = [...schedule.activities]
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
      .filter((a) => {
        const title = a.title.toLowerCase();
        return /meeting|rapat|kerja|olahraga|gym|makan|nonton|call|nongkrong|keluar|belanja/.test(
          title
        );
      })
      .slice(0, 3);

    for (const activity of notables) {
      docs.push({
        userId,
        type: 'activity_end',
        dueAt: new Date(activity.endAt),
        payload: {
          activityId: activity.id,
          activityTitle: activity.title,
          textHint: `Selesai aktivitas: ${activity.title}`,
        },
        status: 'pending',
        createdAt: new Date(),
      });
    }

    // Cancel previous pending for the day then insert fresh
    const dayStart = zonedDateTime(schedule.date, '00:00');
    const dayEnd = zonedDateTime(schedule.date, '23:59');
    await this.db.proactive.updateMany(
      {
        userId,
        status: { $in: ['pending', 'sending'] as any },
        dueAt: { $gte: dayStart, $lte: dayEnd },
        type: {
          $in: [
            'morning_greeting',
            'midday_checkin',
            'evening_wrap',
            'activity_start',
            'activity_end',
          ],
        },
      },
      { $set: { status: 'cancelled', error: 'regenerated-schedule' } }
    );

    // Strict: only future events (no catch-up spam after restart)
    const future = docs.filter((d) => d.dueAt.getTime() > now + 30_000);
    if (future.length) await this.db.proactive.insertMany(future as any);
  }

  private toActivity(date: string, raw: any): Activity | null {
    if (!raw?.title || !raw?.start || !raw?.end) return null;
    const startAt = zonedDateTime(date, String(raw.start));
    const endAt = zonedDateTime(date, String(raw.end));
    if (endAt <= startAt) return null;
    return {
      id: randomId('act'),
      title: String(raw.title),
      description: raw.description ? String(raw.description) : undefined,
      startAt,
      endAt,
      status: 'planned',
      note: raw.note ? String(raw.note) : undefined,
      notifiedStart: false,
      notifiedEnd: false,
    };
  }

  private fallbackActivities(date: string): Activity[] {
    const slots = [
      ['07:30', '08:00', 'Bangun & sarapan'],
      ['09:00', '11:00', 'Kerja / urusan online'],
      ['12:00', '13:00', 'Makan siang'],
      ['13:30', '15:30', 'Lanjut aktivitas harian'],
      ['16:00', '17:00', 'Olahraga ringan / jalan'],
      ['18:30', '19:30', 'Makan malam'],
      ['20:00', '21:00', 'Waktu santai / chat'],
      ['21:30', '22:00', 'Persiapan tidur'],
    ];
    return slots.map(([start, end, title]) => ({
      id: randomId('act'),
      title,
      startAt: zonedDateTime(date, start),
      endAt: zonedDateTime(date, end),
      status: 'planned' as const,
    }));
  }

  private cleanJson(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      return trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    }
    return trimmed;
  }
}
