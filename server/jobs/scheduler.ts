import { env } from '../config/env';
import { Database } from '../db/mongo';
import { PersonaService } from '../domain/persona/service';
import { ProactiveService } from '../domain/proactive/service';
import { ScheduleService } from '../domain/schedule/service';
import { MoodService } from '../domain/mood/service';
import { ConversationService } from '../domain/conversation/service';
import { ReminderService } from '../domain/reminder/service';
import { BotService } from '../domain/bots/service';
import { formatDateInTz } from '../utils/time';

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: Database,
    private personaService: PersonaService,
    private scheduleService: ScheduleService,
    private proactiveService: ProactiveService,
    private moodService: MoodService,
    private conversationService: ConversationService,
    private reminderService: ReminderService,
    private botService: BotService,
    private sendMessage: (userId: string, text: string) => Promise<void>,
    private getActiveUserId: () => string | null
  ) {}

  start() {
    if (this.timer) return;
    console.log(`⏱ Scheduler started (tick ${env.scheduleTickMs}ms)`);
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('Scheduler tick error:', err));
    }, env.scheduleTickMs);
    setTimeout(() => this.tick().catch(console.error), 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const userId = this.getActiveUserId() || env.authorizedPhone;
      if (!userId) return;

      const onboarded = await this.personaService.isOnboarded(userId);
      if (!onboarded) return;

      // Sleep first so day context/mood/schedule see a clean day if needed
      await this.maybeNightlySleep(userId);

      const persona = await this.personaService.get(userId);
      const mood = await this.moodService.ensureToday(userId, persona);
      await this.scheduleService.ensureToday(userId, persona, mood.current.label);

      await this.scheduleService.tick(userId);
      await this.maybePreGenerateTomorrow(userId, persona);

      if (typeof this.sendMessage === 'function') {
        // One-shot user reminders (ephemeral collection)
        const n = await this.reminderService.processDue(userId, this.sendMessage);
        if (n > 0) console.log(`⏰ Fired ${n} reminder(s)`);

        await this.proactiveService.processDue(userId, persona, this.sendMessage);
      }

      // Background automation bots (queued/running + WA notify when done)
      await this.botService.processQueue();

      // Occasional cleanup of old terminal reminders (keep collection lean)
      if (Math.random() < 0.02) {
        const purged = await this.reminderService.purgeOld(userId, 14);
        if (purged > 0) console.log(`🧹 Purged ${purged} old reminders`);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * "Tidur": after local NIGHTLY_CONSOLIDATE_HOUR:MINUTE,
   * consolidate previous day's chat into long-term memories and clear day transcript.
   */
  private async maybeNightlySleep(userId: string) {
    if (!env.enableNightlyConsolidate) return;

    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: env.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const nowM = hour * 60 + minute;
    const targetM = env.nightlyConsolidateHour * 60 + env.nightlyConsolidateMinute;
    if (nowM < targetM) return;

    const today = formatDateInTz(now, env.timezone);
    const yesterday = formatDateInTz(new Date(now.getTime() - 24 * 60 * 60 * 1000), env.timezone);
    const state = await this.conversationService.getState(userId);
    if (!state) return;

    const day = state.conversationDate || today;

    // Already finished yesterday's sleep and holding a clean today
    if (state.lastConsolidatedDate === yesterday && day === today) {
      return;
    }
    if (state.lastConsolidatedDate === today) {
      return;
    }

    // Primary: still holding transcript for yesterday (or older)
    if (day < today) {
      console.log(`😴 Nightly sleep trigger for ${userId} day=${day}`);
      await this.conversationService.sleepAndReset(userId, day);
      return;
    }

    // At/after consolidate time on a day that already rolled conversationDate to today
    // but has not yet marked yesterday consolidated (edge: first message of new day
    // may rewrite date before sleep ran). If lastConsolidated is older than yesterday,
    // consolidate yesterday from leftover messages if any.
    if (
      day === today &&
      state.lastConsolidatedDate &&
      state.lastConsolidatedDate < yesterday &&
      (state.messages?.length || 0) > 0
    ) {
      console.log(`😴 Nightly sleep (carry leftover) for ${userId}`);
      await this.conversationService.sleepAndReset(userId, yesterday);
    }
  }

  private async maybePreGenerateTomorrow(userId: string, persona: any) {
    const now = new Date();
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: env.timezone,
        hour: '2-digit',
        hour12: false,
      }).format(now)
    );
    if (hour < 22) return;

    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const date = formatDateInTz(tomorrow);
    const existing = await this.scheduleService.getToday(userId, date);
    if (!existing) {
      console.log(`📅 Pre-generating schedule for ${date}`);
      const mood = await this.moodService.generateForDate(userId, date, persona);
      await this.scheduleService.generateForDate(userId, date, persona, mood.current.label);
    }
  }
}
