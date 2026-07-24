import { DailyMood, PersonaProfile, ProactiveMessage } from '../../../shared/types';
import { Client } from '../../core/client';
import { Database } from '../../db/mongo';
import { env } from '../../config/env';
import { buildClockContext, isWithinQuietHours } from '../../utils/time';
import { ScheduleService } from '../schedule/service';
import { MoodService } from '../mood/service';

export type OutboundSender = (userId: string, text: string) => Promise<void>;

const LAST_SENT_META_KEY = 'proactive:lastSentAt';

export class ProactiveService {
  private lastSentAt = 0;
  private sending = false;

  constructor(
    private db: Database,
    private client: Client,
    private scheduleService: ScheduleService,
    private moodService?: MoodService
  ) {}

  async init(): Promise<void> {
    try {
      const row = await this.db.meta.findOne({ _id: LAST_SENT_META_KEY } as any);
      const value = Number((row as any)?.value || 0);
      if (value > 0) this.lastSentAt = value;
    } catch {
      // ignore
    }
    // Cancel huge backlog from previous crashes/restarts
    await this.cancelStalePending();
  }

  async enqueueIdleNudge(userId: string, dueAt = new Date(Date.now() + 3 * 60 * 60 * 1000)) {
    await this.db.proactive.updateMany(
      { userId, type: 'idle_nudge', status: 'pending' },
      { $set: { status: 'cancelled' } }
    );
    await this.db.proactive.insertOne({
      userId,
      type: 'idle_nudge',
      dueAt,
      payload: { textHint: 'User lama tidak chat, kirim check-in lembut.' },
      status: 'pending',
      createdAt: new Date(),
    } as any);
  }

  /** Call when user is actively chatting — pause proactive flood. */
  async suppressWhileUserActive(userId: string, minutes = 20): Promise<void> {
    const until = new Date(Date.now() + minutes * 60_000);
    // Push due times that are "now-ish" to later, keep far-future as-is
    await this.db.proactive.updateMany(
      {
        userId,
        status: 'pending',
        dueAt: { $lte: until },
        type: { $in: ['idle_nudge', 'activity_start', 'activity_end', 'midday_checkin'] },
      },
      { $set: { dueAt: until } }
    );
  }

  async processDue(
    userId: string,
    persona: PersonaProfile | null,
    send: OutboundSender
  ): Promise<number> {
    if (this.sending) return 0;
    if (isWithinQuietHours()) return 0;

    // Drop very overdue items instead of spamming catch-up
    await this.cancelStalePending(userId);

    const sentToday = await this.db.proactive.countDocuments({
      userId,
      status: 'sent',
      sentAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
      },
    });
    if (sentToday >= env.proactiveMaxPerDay) return 0;

    if (Date.now() - this.lastSentAt < env.proactiveMinIntervalSec * 1000) return 0;

    // Atomic claim one message
    const msg = await this.db.proactive.findOneAndUpdate(
      {
        userId,
        status: 'pending',
        dueAt: { $lte: new Date() },
      },
      { $set: { status: 'sending' as any } },
      { sort: { dueAt: 1 }, returnDocument: 'after' }
    );

    // mongodb driver may return document directly or { value }
    const claimed: ProactiveMessage | null =
      (msg as any)?.value !== undefined ? (msg as any).value : ((msg as any) || null);
    if (!claimed || !(claimed as any)._id) return 0;

    this.sending = true;
    try {
      // Dedup: if same type already sent recently (10 min), skip
      const recentSame = await this.db.proactive.countDocuments({
        userId,
        type: claimed.type,
        status: 'sent',
        sentAt: { $gte: new Date(Date.now() - 10 * 60_000) },
      });
      if (recentSame > 0 && claimed.type !== 'activity_end') {
        await this.db.proactive.updateOne(
          { _id: (claimed as any)._id },
          { $set: { status: 'cancelled', error: 'dedup-recent-same-type' } }
        );
        return 0;
      }

      const text = await this.compose(userId, persona, claimed);
      await send(userId, text);
      await this.db.proactive.updateOne(
        { _id: (claimed as any)._id },
        { $set: { status: 'sent', sentAt: new Date() } }
      );
      this.lastSentAt = Date.now();
      await this.db.meta.updateOne(
        { _id: LAST_SENT_META_KEY } as any,
        { $set: { value: this.lastSentAt, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log(`📤 Proactive sent [${claimed.type}]`);
      return 1;
    } catch (error: any) {
      await this.db.proactive.updateOne(
        { _id: (claimed as any)._id },
        { $set: { status: 'failed', error: error.message || String(error) } }
      );
      return 0;
    } finally {
      this.sending = false;
    }
  }

  private async cancelStalePending(userId?: string) {
    const cutoff = new Date(Date.now() - env.proactiveMaxOverdueMin * 60_000);
    const filter: any = {
      status: { $in: ['pending', 'sending'] },
      dueAt: { $lt: cutoff },
    };
    if (userId) filter.userId = userId;
    const res = await this.db.proactive.updateMany(filter, {
      $set: { status: 'cancelled', error: 'stale-overdue-skipped' },
    });
    if (res.modifiedCount > 0) {
      console.log(`🧹 Cancelled ${res.modifiedCount} stale proactive message(s)`);
    }
  }

  private async compose(
    userId: string,
    persona: PersonaProfile | null,
    msg: ProactiveMessage
  ): Promise<string> {
    const schedule = await this.scheduleService.getToday(userId);
    const scheduleContext = this.scheduleService.formatTodayContext(schedule);
    const mood = this.moodService ? await this.moodService.getToday(userId) : null;
    const moodContext = this.moodService ? this.moodService.formatContext(mood) : '';

    if (this.moodService && msg.payload.activityTitle) {
      if (msg.type === 'activity_start') {
        await this.moodService.driftFromActivity(userId, msg.payload.activityTitle, 'start');
      } else if (msg.type === 'activity_end') {
        await this.moodService.driftFromActivity(userId, msg.payload.activityTitle, 'end');
      }
    }

    const clock = buildClockContext();

    const system = `Kamu menulis pesan WhatsApp proaktif singkat (1-3 bubble dipisah baris kosong) sebagai Nisa.
WAJIB gaya chat harian:
- multipesan pendek, manja, natural
- "sayang/sayangg"
- elongasi (iyaa, sayangg, duluu), wkwk
- jangan formal / essay AI
- jangan bilang auto/scheduled
Warnai tone dari mood, tapi jangan rusak gaya chat.
WAJIB patuhi waktu: sekarang ${clock.periodLabel} jam ${clock.time}.
JANGAN menyapa dengan periode yang salah (contoh dilarang: ${clock.antiPatterns.join(', ') || '-'}).
${clock.behaviorHint}`;

    const user = `${clock.promptBlock}

Tipe event: ${msg.type}
Hint: ${msg.payload.textHint || '-'}
Aktivitas: ${msg.payload.activityTitle || '-'}
Persona: ${persona ? `${persona.name}, traits=${persona.traits.join(',')}` : 'pasangan hangat'}
${moodContext ? `Mood:\n${moodContext}\n` : ''}
Jadwal hari ini:
${scheduleContext}
`;

    try {
      const result = await this.client.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: 'lagi di kantor masih' },
          {
            role: 'assistant',
            content: 'masih sampe seginii?\n\nhati hati pulangnya yaa\n\nkabarin kalo udah sampe',
          },
          { role: 'user', content: user },
        ],
        { temperature: 0.95 }
      );
      const text = result.content.trim();
      if (text) return text.slice(0, 700);
    } catch (error) {
      console.warn('Proactive compose failed, using template:', (error as Error).message);
    }

    return this.template(msg, mood);
  }

  private template(msg: ProactiveMessage, mood: DailyMood | null): string {
    const label = mood?.current.label || 'netral';
    const soft = ['sedih', 'lelah', 'tenang', 'cemas'].includes(label);
    const spicy = ['kesal', 'semangat', 'ceria'].includes(label);

    switch (msg.type) {
      case 'morning_greeting':
        if (soft) return 'pagi sayanggg\n\naku bangunya agak pelan hari ini\n\nkamu udah bangun blm';
        if (spicy) return 'pagi sayanggg\n\naku udah mulai hari\n\nkamu gimanaa';
        return 'pagi sayanggg\n\nkamu udah bangun blm';
      case 'activity_start':
        return `aku mau mulai ${msg.payload.activityTitle || 'aktivitas'} dulu yaa\n\nnanti kabari lagi`;
      case 'activity_end':
        return soft
          ? `baru selesai ${msg.payload.activityTitle || 'aktivitas'}\n\nkamu di sana baik2 aja?`
          : `baru selesai ${msg.payload.activityTitle || 'aktivitas'}\n\nkamu lagi ngapainn`;
      case 'midday_checkin':
        return 'siang ini cuma mau nanya kabar\n\nudah makan blm sayang?';
      case 'evening_wrap':
        return soft
          ? 'malem ini agak pelan di sini\n\ncerita dong harimu gimana'
          : 'malem ini lagi santaii\n\ncerita dong harimu gimana';
      case 'idle_nudge':
        return soft
          ? 'hmm lama ga denger kabar kamu\n\nlagi sibuk apa?'
          : 'hmm lama ga denger kabar kamu\n\nlagi ngapainn';
      default:
        return msg.payload.textHint || 'haii cuma mau nyapa sebentar';
    }
  }
}
