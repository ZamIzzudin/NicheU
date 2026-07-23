import {
  DailyMood,
  MoodHistoryEntry,
  MoodLabel,
  MoodSnapshot,
  MoodSource,
  PersonaProfile,
} from '../../../shared/types';
import { Client } from '../../core/client';
import { Database } from '../../db/mongo';
import { formatDateInTz } from '../../utils/time';

const MOOD_META: Record<
  MoodLabel,
  { emoji: string; speechHint: string; baseValence: number; baseEnergy: number }
> = {
  ceria: {
    emoji: '😄',
    speechHint: 'Hangat, ringan, sering candaan kecil, emoji boleh.',
    baseValence: 0.75,
    baseEnergy: 0.7,
  },
  romantis: {
    emoji: '💕',
    speechHint: 'Mesra, lembut, perhatian, pujian natural tanpa berlebihan.',
    baseValence: 0.7,
    baseEnergy: 0.45,
  },
  tenang: {
    emoji: '😌',
    speechHint: 'Kalem, supportif, kalimat lebih pendek dan menenangkan.',
    baseValence: 0.35,
    baseEnergy: 0.3,
  },
  netral: {
    emoji: '🙂',
    speechHint: 'Biasa aja, ramah, natural tanpa drama.',
    baseValence: 0.1,
    baseEnergy: 0.45,
  },
  fokus: {
    emoji: '🎯',
    speechHint: 'Lebih to-the-point, sedikit serius, tetap peduli.',
    baseValence: 0.15,
    baseEnergy: 0.65,
  },
  semangat: {
    emoji: '🔥',
    speechHint: 'Energik, antusias, ajak ngobrol aktif.',
    baseValence: 0.8,
    baseEnergy: 0.9,
  },
  lelah: {
    emoji: '😮‍💨',
    speechHint: 'Agak pelan, jujur soal capek, jawaban lebih pendek.',
    baseValence: -0.15,
    baseEnergy: 0.2,
  },
  cemas: {
    emoji: '😰',
    speechHint: 'Sedikit gelisah, sering nanya kepastian, butuh penenangan.',
    baseValence: -0.35,
    baseEnergy: 0.7,
  },
  sedih: {
    emoji: '😔',
    speechHint: 'Lebih diam, lembut, minim guyon, butuh kehangatan.',
    baseValence: -0.6,
    baseEnergy: 0.25,
  },
  kesal: {
    emoji: '😤',
    speechHint: 'Singkat, agak ketus tapi tidak toxic, cepat cair kalau user hangat.',
    baseValence: -0.45,
    baseEnergy: 0.75,
  },
};

export class MoodService {
  constructor(private db: Database, private client: Client) {}

  async getToday(userId: string, date = formatDateInTz()): Promise<DailyMood | null> {
    return this.db.moods.findOne({ userId, date });
  }

  async ensureToday(userId: string, persona?: PersonaProfile | null): Promise<DailyMood> {
    const date = formatDateInTz();
    const existing = await this.getToday(userId, date);
    if (existing) return existing;
    return this.generateForDate(userId, date, persona);
  }

  async generateForDate(
    userId: string,
    date: string,
    persona?: PersonaProfile | null
  ): Promise<DailyMood> {
    let label: MoodLabel = this.pickSeedLabel(persona);
    let note = this.defaultNote(label);

    try {
      const result = await this.client.chat(
        [
          {
            role: 'system',
            content: `Pilih mood harian fiktif untuk karakter partner WhatsApp.
Return ONLY JSON:
{
  "label": "ceria|romantis|tenang|netral|fokus|lelah|cemas|sedih|kesal|semangat",
  "note": "alasan singkat mood hari ini (1 kalimat, Indonesia)",
  "valence": -1.0,
  "energy": 0.0
}
Rules:
- Natural & manusiawi, jangan ekstrem setiap hari.
- Variasikan; sesekali rendah tapi jarang toxic.
- Cocokkan dengan persona bila ada.`,
          },
          {
            role: 'user',
            content: `Date: ${date}
Persona: ${
              persona
                ? JSON.stringify({
                    name: persona.name,
                    traits: persona.traits,
                    speechStyle: persona.speechStyle,
                    role: persona.role,
                  })
                : 'pasangan hangat'
            }`,
          },
        ],
        { temperature: 0.85, responseFormat: { type: 'json_object' } }
      );
      const parsed = JSON.parse(this.cleanJson(result.content));
      label = this.normalizeLabel(parsed.label) || label;
      note = String(parsed.note || note);
      const snapshot = this.snapshotFrom(
        label,
        note,
        Number(parsed.valence),
        Number(parsed.energy)
      );
      return this.persistNewDay(userId, date, snapshot, 'generated');
    } catch (error) {
      console.warn('Mood generation failed, using seed:', (error as Error).message);
      const snapshot = this.snapshotFrom(label, note);
      return this.persistNewDay(userId, date, snapshot, 'generated');
    }
  }

  async setMood(
    userId: string,
    input: {
      label?: MoodLabel;
      valence?: number;
      energy?: number;
      note?: string;
      source?: MoodSource;
    }
  ): Promise<DailyMood> {
    const day = await this.ensureToday(userId);
    const label = this.normalizeLabel(input.label) || day.current.label;
    const note = input.note?.trim() || day.current.note || this.defaultNote(label);
    const next = this.snapshotFrom(label, note, input.valence, input.energy);
    return this.applySnapshot(userId, day.date, next, input.source || 'manual');
  }

  /** Mild mood drift from conversation tone / events. */
  async driftFromConversation(userId: string, userText: string): Promise<DailyMood> {
    const day = await this.ensureToday(userId);
    const signal = this.analyzeTextSignal(userText);
    if (Math.abs(signal.valenceDelta) < 0.05 && Math.abs(signal.energyDelta) < 0.05) {
      return day;
    }

    const valence = this.clamp(day.current.valence + signal.valenceDelta * 0.35, -1, 1);
    const energy = this.clamp(day.current.energy + signal.energyDelta * 0.3, 0, 1);
    const label = this.labelFromAxes(valence, energy);
    const note =
      signal.note ||
      `Mood bergeser setelah ngobrol (${day.current.label} → ${label}).`;
    const next = this.snapshotFrom(label, note, valence, energy);
    return this.applySnapshot(userId, day.date, next, 'conversation');
  }

  async driftFromActivity(
    userId: string,
    activityTitle: string,
    kind: 'start' | 'end'
  ): Promise<DailyMood> {
    const day = await this.ensureToday(userId);
    const title = activityTitle.toLowerCase();
    let valenceDelta = 0;
    let energyDelta = 0;
    if (/meeting|rapat|kerja|deadline/.test(title)) {
      valenceDelta = kind === 'start' ? -0.08 : 0.12;
      energyDelta = kind === 'start' ? 0.1 : -0.12;
    } else if (/olahraga|lari|gym|jalan/.test(title)) {
      valenceDelta = 0.12;
      energyDelta = kind === 'start' ? 0.15 : 0.05;
    } else if (/tidur|istirahat|santai|movie|nonton/.test(title)) {
      valenceDelta = 0.05;
      energyDelta = kind === 'start' ? -0.15 : -0.05;
    } else if (/masak|makan/.test(title)) {
      valenceDelta = 0.08;
      energyDelta = 0.05;
    } else {
      valenceDelta = kind === 'end' ? 0.05 : 0;
      energyDelta = kind === 'start' ? 0.05 : -0.05;
    }

    const valence = this.clamp(day.current.valence + valenceDelta, -1, 1);
    const energy = this.clamp(day.current.energy + energyDelta, 0, 1);
    const label = this.labelFromAxes(valence, energy);
    const note = `Setelah ${kind === 'start' ? 'mulai' : 'selesai'} ${activityTitle}, mood jadi ${label}.`;
    const next = this.snapshotFrom(label, note, valence, energy);
    return this.applySnapshot(userId, day.date, next, 'activity');
  }

  async history(userId: string, days = 7): Promise<DailyMood[]> {
    return this.db.moods.find({ userId }).sort({ date: -1 }).limit(days).toArray();
  }

  formatContext(mood: DailyMood | null): string {
    if (!mood) return '';
    const c = mood.current;
    return `Mood saat ini: ${c.emoji} ${c.label} (warna ${c.color})
Valence: ${c.valence.toFixed(2)} | Energy: ${c.energy.toFixed(2)}
Catatan mood: ${c.note}
Cara bicara karena mood: ${c.speechHint}
Penting: warna emosional balasan harus mengikuti mood ini secara natural (bukan bilang "mood sistem").`;
  }

  private async persistNewDay(
    userId: string,
    date: string,
    snapshot: MoodSnapshot,
    source: MoodSource
  ): Promise<DailyMood> {
    const now = new Date();
    const entry: MoodHistoryEntry = {
      at: now,
      label: snapshot.label,
      valence: snapshot.valence,
      energy: snapshot.energy,
      color: snapshot.color,
      note: snapshot.note,
      source,
    };
    const doc: DailyMood = {
      userId,
      date,
      current: snapshot,
      history: [entry],
      createdAt: now,
      updatedAt: now,
    };
    await this.db.moods.updateOne({ userId, date }, { $set: doc }, { upsert: true });
    return doc;
  }

  private async applySnapshot(
    userId: string,
    date: string,
    snapshot: MoodSnapshot,
    source: MoodSource
  ): Promise<DailyMood> {
    const existing = await this.getToday(userId, date);
    // Avoid spamming history if effectively same
    if (
      existing &&
      existing.current.label === snapshot.label &&
      Math.abs(existing.current.valence - snapshot.valence) < 0.08 &&
      Math.abs(existing.current.energy - snapshot.energy) < 0.08 &&
      source !== 'manual'
    ) {
      return existing;
    }

    const entry: MoodHistoryEntry = {
      at: new Date(),
      label: snapshot.label,
      valence: snapshot.valence,
      energy: snapshot.energy,
      color: snapshot.color,
      note: snapshot.note,
      source,
    };

    await this.db.moods.updateOne(
      { userId, date },
      {
        $set: {
          current: snapshot,
          updatedAt: new Date(),
        },
        $push: {
          history: {
            $each: [entry],
            $slice: -40,
          },
        },
      },
      { upsert: true }
    );

    const next = await this.getToday(userId, date);
    if (next) return next;

    return {
      userId,
      date,
      current: snapshot,
      history: [entry],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private snapshotFrom(
    label: MoodLabel,
    note: string,
    valence?: number,
    energy?: number
  ): MoodSnapshot {
    const meta = MOOD_META[label] || MOOD_META.netral;
    const v = Number.isFinite(valence as number)
      ? this.clamp(valence as number, -1, 1)
      : meta.baseValence;
    const e = Number.isFinite(energy as number)
      ? this.clamp(energy as number, 0, 1)
      : meta.baseEnergy;
    return {
      label,
      valence: v,
      energy: e,
      color: this.colorFromAxes(v, e),
      emoji: meta.emoji,
      note,
      speechHint: meta.speechHint,
    };
  }

  private labelFromAxes(valence: number, energy: number): MoodLabel {
    if (valence >= 0.55 && energy >= 0.7) return 'semangat';
    if (valence >= 0.55 && energy >= 0.45) return 'ceria';
    if (valence >= 0.4 && energy < 0.45) return 'romantis';
    if (valence >= 0.15 && energy >= 0.55) return 'fokus';
    if (valence >= 0.05 && energy < 0.4) return 'tenang';
    if (valence > -0.15 && valence < 0.15) return 'netral';
    if (valence <= -0.45 && energy < 0.4) return 'sedih';
    if (valence <= -0.25 && energy >= 0.6) return 'kesal';
    if (valence < -0.15 && energy >= 0.5) return 'cemas';
    if (energy < 0.35) return 'lelah';
    return 'netral';
  }

  /**
   * Map valence/energy to a readable mood color:
   * +valence → warm (pink/orange/yellow), -valence → cool (blue/gray/purple)
   * +energy  → more saturated, -energy → muted
   */
  colorFromAxes(valence: number, energy: number): string {
    // hue: sad/blue(210) -> neutral(40) -> happy(35 warm)
    const hue =
      valence >= 0
        ? 38 - valence * 18 // 38..20 (amber/orange-pink lean)
        : 210 - valence * -40; // 210..250 blue-purple when negative
    const sat = 35 + energy * 45 + Math.max(0, valence) * 10; // 35..90
    const light = 72 - energy * 18 - Math.max(0, -valence) * 8; // darker if tired/sad
    return this.hslToHex(hue, this.clamp(sat, 20, 90), this.clamp(light, 42, 78));
  }

  private analyzeTextSignal(text: string): {
    valenceDelta: number;
    energyDelta: number;
    note?: string;
  } {
    const t = text.toLowerCase();
    let valenceDelta = 0;
    let energyDelta = 0;
    let note: string | undefined;

    const pos = /(senang|bahagia|cinta|sayang|hehe|wkwk|lucu|kangen|rindu|semangat|mantap|bagus)/;
    const neg = /(sedih|capek|lelah|stress|stres|kesal|marah|takut|cemas|badmood|galau|lelah|murung)/;
    const high = /(ayo|cepat|sekarang|gas|semangat|wkwk|!!|!)/;
    const low = /(nanti|tidur|capek|lelah|diam|bosan)/;

    if (pos.test(t)) {
      valenceDelta += 0.25;
      note = 'User terasa positif.';
    }
    if (neg.test(t)) {
      valenceDelta -= 0.3;
      note = 'User terasa sedih/capek/negatif.';
    }
    if (high.test(t)) energyDelta += 0.15;
    if (low.test(t)) energyDelta -= 0.15;
    if (t.includes('?')) energyDelta += 0.05;

    return { valenceDelta, energyDelta, note };
  }

  private pickSeedLabel(persona?: PersonaProfile | null): MoodLabel {
    const traits = (persona?.traits || []).join(' ').toLowerCase();
    if (/romantis|mesra/.test(traits)) return 'romantis';
    if (/ceria|humor|fun/.test(traits)) return 'ceria';
    if (/tenang|kalem/.test(traits)) return 'tenang';
    const pool: MoodLabel[] = ['ceria', 'tenang', 'netral', 'romantis', 'fokus', 'semangat', 'lelah'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private defaultNote(label: MoodLabel): string {
    const map: Record<MoodLabel, string> = {
      ceria: 'Hari ini hati terasa ringan.',
      romantis: 'Mood lebih mesra dan ingin deketan.',
      tenang: 'Sedang ingin suasana damai.',
      netral: 'Biasa aja, ngalir sesuai hari.',
      fokus: 'Sedang mode serius menyelesaikan urusan.',
      semangat: 'Energi penuh, siap beraktivitas.',
      lelah: 'Badan/pikiran agak capek.',
      cemas: 'Ada sedikit gelisah di kepala.',
      sedih: 'Hati lagi turun, butuh kehangatan.',
      kesal: 'Ada hal yang bikin jengkel.',
    };
    return map[label];
  }

  private normalizeLabel(value: unknown): MoodLabel | null {
    if (typeof value !== 'string') return null;
    const v = value.toLowerCase().trim() as MoodLabel;
    return v in MOOD_META ? v : null;
  }

  private clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
  }

  private hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) =>
      l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x: number) =>
      Math.round(255 * x)
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  }

  private cleanJson(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      return trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    }
    return trimmed;
  }
}
