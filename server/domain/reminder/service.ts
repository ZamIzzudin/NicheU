import { Reminder, ReminderStatus } from '../../../shared/types';
import { Client } from '../../core/client';
import { Database } from '../../db/mongo';
import { env } from '../../config/env';
import {
  buildClockContext,
  formatDateInTz,
  formatTimeInTz,
  randomId,
  zonedDateTime,
} from '../../utils/time';

export type ReminderOutbound = (userId: string, text: string) => Promise<void>;

/**
 * Ephemeral timed reminders (separate from long-term memories).
 * After sent/cancelled they no longer load into chat context.
 */
export class ReminderService {
  private sending = false;

  constructor(private db: Database, private client: Client) {}

  async create(input: {
    userId: string;
    text: string;
    dueAt: Date;
    rawWhen?: string;
    sourceText?: string;
  }): Promise<Reminder> {
    const text = String(input.text || '').trim();
    if (!text) throw new Error('text required');
    if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime())) {
      throw new Error('dueAt invalid');
    }
    // Guard: don't allow due more than 1 year out or already far past
    const now = Date.now();
    if (input.dueAt.getTime() < now - 60_000) {
      throw new Error('dueAt is in the past');
    }
    if (input.dueAt.getTime() > now + 366 * 24 * 60 * 60 * 1000) {
      throw new Error('dueAt too far in the future');
    }

    const nowDate = new Date();
    const reminder: Reminder = {
      id: randomId('rem'),
      userId: input.userId,
      text,
      dueAt: input.dueAt,
      status: 'pending',
      rawWhen: input.rawWhen,
      sourceText: input.sourceText?.slice(0, 500),
      createdAt: nowDate,
      updatedAt: nowDate,
    };
    await this.db.reminders.insertOne(reminder as any);
    console.log(
      `⏰ Reminder set ${reminder.id} for ${input.userId} @ ${reminder.dueAt.toISOString()}: ${text.slice(0, 80)}`
    );
    return reminder;
  }

  /**
   * Natural-language create. Parses when via rules + LLM fallback.
   */
  async createFromNatural(input: {
    userId: string;
    text: string;
    when: string;
    sourceText?: string;
  }): Promise<Reminder> {
    const dueAt = await this.parseWhen(input.when, input.sourceText);
    return this.create({
      userId: input.userId,
      text: input.text,
      dueAt,
      rawWhen: input.when,
      sourceText: input.sourceText,
    });
  }

  async list(
    userId: string,
    options: { status?: ReminderStatus | 'active' | 'all'; limit?: number } = {}
  ): Promise<Reminder[]> {
    const limit = Math.min(50, Math.max(1, options.limit || 20));
    const status = options.status || 'active';
    const filter: Record<string, unknown> = { userId };
    if (status === 'active') {
      filter.status = { $in: ['pending', 'sending'] };
    } else if (status !== 'all') {
      filter.status = status;
    }
    return this.db.reminders
      .find(filter as any)
      .sort({ dueAt: 1 })
      .limit(limit)
      .toArray();
  }

  async cancel(userId: string, reminderId: string): Promise<Reminder | null> {
    const existing = await this.db.reminders.findOne({
      userId,
      $or: [{ id: reminderId }, { _id: reminderId as any }],
    } as any);
    if (!existing) return null;
    if (existing.status === 'sent' || existing.status === 'cancelled') return existing;

    const next: Partial<Reminder> = {
      status: 'cancelled',
      cancelledAt: new Date(),
      updatedAt: new Date(),
    };
    await this.db.reminders.updateOne({ id: existing.id }, { $set: next });
    return { ...existing, ...next } as Reminder;
  }

  async cancelAllPending(userId: string): Promise<number> {
    const res = await this.db.reminders.updateMany(
      { userId, status: { $in: ['pending', 'sending'] } },
      { $set: { status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() } }
    );
    return res.modifiedCount;
  }

  /**
   * Compact context for prompts: only ACTIVE reminders (not memories).
   * Keep tiny so it never bloats long-term context.
   */
  formatActiveContext(reminders: Reminder[]): string {
    if (!reminders.length) return '';
    const lines = reminders.slice(0, 5).map((r) => {
      const when = `${formatDateInTz(r.dueAt)} ${formatTimeInTz(r.dueAt)}`;
      return `- [${r.id}] ${when}: ${r.text}`;
    });
    return `Pengingat aktif (ephemeral, BUKAN memori jangka panjang):\n${lines.join('\n')}`;
  }

  formatConfirm(reminder: Reminder): string {
    const localDate = formatDateInTz(reminder.dueAt);
    const localTime = formatTimeInTz(reminder.dueAt);
    return `okee, aku ingetin yaa\n\n${reminder.text}\n\njam ${localTime} (${localDate})`;
  }

  /**
   * Scheduler: fire due reminders once each.
   */
  async processDue(userId: string, send: ReminderOutbound): Promise<number> {
    if (this.sending) return 0;
    this.sending = true;
    let sent = 0;
    try {
      const now = new Date();
      const due = await this.db.reminders
        .find({
          userId,
          status: 'pending',
          dueAt: { $lte: now },
        })
        .sort({ dueAt: 1 })
        .limit(10)
        .toArray();

      for (const rem of due) {
        const claimed = await this.db.reminders.findOneAndUpdate(
          { id: rem.id, status: 'pending' },
          { $set: { status: 'sending', updatedAt: new Date() } },
          { returnDocument: 'after' }
        );
        const doc = (claimed as any)?.value || (claimed as any);
        if (!doc || doc.status !== 'sending') continue;

        try {
          const body =
            `pengenget yaa ⏰\n\n` +
            `${doc.text}\n\n` +
            `(jadwal ${formatTimeInTz(doc.dueAt)})`;
          await send(userId, body);
          await this.db.reminders.updateOne(
            { id: doc.id },
            { $set: { status: 'sent', sentAt: new Date(), updatedAt: new Date() } }
          );
          sent += 1;
          console.log(`✓ Reminder sent ${doc.id}: ${doc.text.slice(0, 60)}`);
        } catch (error: any) {
          await this.db.reminders.updateOne(
            { id: doc.id },
            {
              $set: {
                status: 'failed',
                error: error?.message || String(error),
                updatedAt: new Date(),
              },
            }
          );
          console.warn(`Reminder failed ${doc.id}:`, error?.message || error);
        }
      }
    } finally {
      this.sending = false;
    }
    return sent;
  }

  /**
   * Cleanup old terminal reminders so collection stays small.
   */
  async purgeOld(userId?: string, olderThanDays = 14): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const filter: Record<string, unknown> = {
      status: { $in: ['sent', 'cancelled', 'failed'] },
      updatedAt: { $lt: cutoff },
    };
    if (userId) filter.userId = userId;
    const res = await this.db.reminders.deleteMany(filter as any);
    return res.deletedCount || 0;
  }

  /**
   * Parse natural language when → Date in app timezone.
   * Rules first (cepat), LLM fallback.
   */
  async parseWhen(when: string, sourceText?: string): Promise<Date> {
    const clock = buildClockContext();
    const raw = String(when || sourceText || '').trim();
    if (!raw) throw new Error('when required');

    const rule = this.parseWhenRules(raw, clock);
    if (rule) return rule;

    // LLM structured parse
    try {
      const result = await this.client.chat(
        [
          {
            role: 'system',
            content: `Parse a reminder time into absolute local wall clock.
Timezone: ${clock.timezone}
Now: ${clock.longDate} ${clock.time} (hour=${clock.hour}, minute=${clock.minute}, date=${clock.date})
Return ONLY JSON:
{"date":"YYYY-MM-DD","time":"HH:MM","confidence":0.0}
- date/time are LOCAL in the given timezone.
- If relative ("15 menit lagi", "1 jam lagi", "besok jam 8"), compute from Now.
- If only time given and already passed today, use tomorrow.
- Never invent unrelated times. confidence 0-1.`,
          },
          { role: 'user', content: raw },
        ],
        { temperature: 0.1, responseFormat: { type: 'json_object' } }
      );
      const parsed = JSON.parse(this.cleanJson(result.content));
      const date = String(parsed.date || clock.date);
      const time = String(parsed.time || '').padStart(5, '0');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        throw new Error('bad parse shape');
      }
      const due = zonedDateTime(date, time, env.timezone);
      if (due.getTime() < Date.now() - 30_000) {
        // safety: push +1 day if still past
        return new Date(due.getTime() + 24 * 60 * 60 * 1000);
      }
      return due;
    } catch (error) {
      console.warn('parseWhen LLM failed:', (error as Error).message);
      throw new Error(`Tidak bisa parse waktu pengingat: "${raw}"`);
    }
  }

  private parseWhenRules(
    raw: string,
    clock: ReturnType<typeof buildClockContext>
  ): Date | null {
    const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    const now = new Date();

    // "N menit/menit lagi" / "N min"
    let m = text.match(/(\d+)\s*(detik|sekon|sec|second|seconds)\b/);
    if (m) return new Date(now.getTime() + Number(m[1]) * 1000);

    m = text.match(/(\d+)\s*(menit|mnt|min|minute|minutes)\b/);
    if (m) return new Date(now.getTime() + Number(m[1]) * 60_000);

    m = text.match(/(\d+)\s*(jam|hour|hours)\b/);
    if (m) return new Date(now.getTime() + Number(m[1]) * 3_600_000);

    m = text.match(/(\d+)\s*(hari|day|days)\b/);
    if (m) return new Date(now.getTime() + Number(m[1]) * 86_400_000);

    // "besok jam 08:30" / "besok jam 8"
    m = text.match(/besok(?:\s+jam)?\s+(\d{1,2})(?:[:.](\d{2}))?/);
    if (m) {
      const tomorrow = new Date(now.getTime() + 86_400_000);
      const date = formatDateInTz(tomorrow, env.timezone);
      const hh = String(Math.min(23, Number(m[1]))).padStart(2, '0');
      const mm = String(m[2] ? Number(m[2]) : 0).padStart(2, '0');
      return zonedDateTime(date, `${hh}:${mm}`, env.timezone);
    }

    // "jam 15:30" / "pukul 15.30" / "jam 3 sore"
    m = text.match(/(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/);
    if (m) {
      let hour = Number(m[1]);
      const minute = m[2] ? Number(m[2]) : 0;
      const meridiem = m[3];
      if (meridiem === 'sore' || meridiem === 'malam') {
        if (hour < 12) hour += 12;
      } else if (meridiem === 'pagi' && hour === 12) {
        hour = 0;
      } else if (meridiem === 'siang' && hour < 10) {
        // "jam 1 siang" → 13
        if (hour >= 1 && hour <= 4) hour += 12;
      }
      hour = Math.min(23, Math.max(0, hour));
      const mm = String(Math.min(59, minute)).padStart(2, '0');
      const hh = String(hour).padStart(2, '0');
      let due = zonedDateTime(clock.date, `${hh}:${mm}`, env.timezone);
      if (due.getTime() <= now.getTime() + 15_000) {
        // already passed today → tomorrow
        const tomorrow = new Date(now.getTime() + 86_400_000);
        due = zonedDateTime(formatDateInTz(tomorrow, env.timezone), `${hh}:${mm}`, env.timezone);
      }
      return due;
    }

    // bare HH:MM
    m = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
    if (m) {
      const hour = Math.min(23, Number(m[1]));
      const minute = Math.min(59, Number(m[2]));
      const hh = String(hour).padStart(2, '0');
      const mm = String(minute).padStart(2, '0');
      let due = zonedDateTime(clock.date, `${hh}:${mm}`, env.timezone);
      if (due.getTime() <= now.getTime() + 15_000) {
        const tomorrow = new Date(now.getTime() + 86_400_000);
        due = zonedDateTime(formatDateInTz(tomorrow, env.timezone), `${hh}:${mm}`, env.timezone);
      }
      return due;
    }

    return null;
  }

  private cleanJson(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      return trimmed
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
    }
    return trimmed;
  }
}
