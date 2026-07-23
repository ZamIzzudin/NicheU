import { env } from '../config/env';
import { Database } from '../db/mongo';
import { PersonaService } from '../domain/persona/service';
import { ProactiveService } from '../domain/proactive/service';
import { ScheduleService } from '../domain/schedule/service';
import { MoodService } from '../domain/mood/service';
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

      const persona = await this.personaService.get(userId);
      const mood = await this.moodService.ensureToday(userId, persona);
      await this.scheduleService.ensureToday(userId, persona, mood.current.label);

      await this.scheduleService.tick(userId);
      await this.maybePreGenerateTomorrow(userId, persona);

      if (typeof this.sendMessage === 'function') {
        await this.proactiveService.processDue(userId, persona, this.sendMessage);
      }
    } finally {
      this.running = false;
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
