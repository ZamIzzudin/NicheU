import { PersonaProfile } from '../../../shared/types';
import { Client } from '../../core/client';
import { Database } from '../../db/mongo';
import { env } from '../../config/env';
import { NISA_FEWSHOT } from './nisa-fewshot-data';

type FewShotPack = {
  soloBubbles: string[];
  multiBubbleReplies: Array<{ user: string; assistant: string }>;
  antiPatterns: string[];
};

function loadNisaFewShot(): FewShotPack {
  // Embedded module — no filesystem lookup (fixes dist/docker/ts-node path issues)
  return {
    soloBubbles: [...NISA_FEWSHOT.soloBubbles],
    multiBubbleReplies: NISA_FEWSHOT.multiBubbleReplies.map((x) => ({ ...x })),
    antiPatterns: [...NISA_FEWSHOT.antiPatterns],
  };
}

function buildFewShotBlock(): string {
  const pack = loadNisaFewShot();
  const solos = (pack.soloBubbles || []).slice(0, 28);
  const pairs = (pack.multiBubbleReplies || []).slice(0, 10);
  const anti = (pack.antiPatterns || []).slice(0, 8);

  const soloText = solos.map((s, i) => `${i + 1}. "${s}"`).join('\n');
  const pairText = pairs
    .map(
      (p, i) =>
        `Contoh ${i + 1}\nUser: ${p.user}\nNisa:\n${p.assistant}`
    )
    .join('\n\n');
  const antiText = anti.map((s) => `- "${s}"`).join('\n');

  return `
FEW-SHOT STYLE (tiru RASA & RITME, jangan copy buta):

A) Bubble tunggal khas Nisa:
${soloText || '- (empty)'}

B) Contoh multi-bubble reply (baris kosong = bubble terpisah):
${pairText || '(empty)'}

C) ANTI-PATTERN (JANGAN mirip ini):
${antiText || '- (empty)'}

Cara pakai few-shot:
- Ambil pola: multipesan, elongasi, sayang/sayangg, wkwk, caring check-in.
- Sesuaikan isi ke konteks sekarang (jangan ngarang detail yang nggak ada).
- Kalau ragu, tulis lebih pendek dan lebih “chat”, bukan lebih formal.
`.trim();
}

const NISA_STYLE_CANON = `
STYLE CANON NISA (prioritas tertinggi):
Kamu chat seperti Nisa di WhatsApp asli — cewek Indonesia, multipesan, manja, natural.

1) 1 ide = 1 bubble pendek; pisah bubble pakai baris kosong; biasanya 1-4 bubble.
2) Panggilan: "sayang"/"sayangg" utama; "zam" sesekali; jangan sering "Azzam".
3) Elongasi manja natural: iyaa, okii, sayangg, kelarr, duluu, bangett, apaa, dimanaa, kenapaaa, otww, malazzz, beresss, preparee.
4) Ketawa teks: wkwk / wkwkw / WKWKWK / AWKWKWK / hahaha.
5) Slang chat: km, gpp, bgt, ntar, brgkt, tp, jd, kl, gasi, rill, otayy, lesgoww, yaudah, pantes.
6) Kadang CAPS pendek emosional: LAH WOIII, KABARIN LAGI TAR, PANTESAN.
7) Emoji hemat; jangan spam emoji aneh/hewan/benda yang berasa bot.
8) Nada: hangat, jahil, kadang ngeledek, caring (makan/pulang/hujan/istirahat/call).
9) DILARANG: essay AI, bahasa presentasi, list formal, "Baik saya akan...", karakter aneh ~><|\`$.
`.trim();

export class PersonaService {
  constructor(private db: Database, private client: Client) {}

  async get(userId: string): Promise<PersonaProfile | null> {
    return this.db.personas.findOne({ userId });
  }

  async isOnboarded(userId: string): Promise<boolean> {
    const persona = await this.get(userId);
    return Boolean(persona?.onboarded);
  }

  onboardingPrompt(): string {
    return (
      'Hai… aku baru bangun di dunia kamu\n\n' +
      'Biar interaksinya natural, perkenalkan dulu ya.\n\n' +
      'Siapa aku buat kamu? (nama, peran — misalnya pasangan)\n\n' +
      'Sifat & gaya bicaraku seperti apa?\n\n' +
      'Nama kamu siapa, dan apa yang kamu suka/nggak suka di cara aku ngobrol?\n\n' +
      'Ada batasan yang harus aku jaga?\n\n' +
      'Ceritain aja bebas, nanti aku inget terus.'
    );
  }

  async createFromIntro(userId: string, introText: string): Promise<PersonaProfile> {
    const system = `Extract a partner/persona profile from the user's introduction.
Return ONLY JSON:
{
  "name": "string",
  "role": "string",
  "speechStyle": "string",
  "traits": ["string"],
  "relationshipToUser": "string",
  "boundaries": "string",
  "userName": "string"
}
Language can be Indonesian. If missing fields, invent gentle defaults for a warm partner persona.`;

    let parsed: any = {};
    try {
      const result = await this.client.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: introText },
        ],
        { temperature: 0.4, responseFormat: { type: 'json_object' } }
      );
      parsed = JSON.parse(this.cleanJson(result.content));
    } catch (error) {
      console.warn('Persona parse failed, using defaults:', (error as Error).message);
      parsed = {};
    }

    const now = new Date();
    const persona: PersonaProfile = {
      userId,
      name: String(parsed.name || 'Aku'),
      role: String(parsed.role || 'pasangan'),
      speechStyle: String(
        parsed.speechStyle || 'hangat, natural, sedikit manja, bahasa Indonesia sehari-hari'
      ),
      traits: Array.isArray(parsed.traits) && parsed.traits.length
        ? parsed.traits.map(String)
        : ['perhatian', 'supportif', 'humoris'],
      relationshipToUser: String(parsed.relationshipToUser || 'pasangan'),
      boundaries: parsed.boundaries ? String(parsed.boundaries) : '',
      timezone: env.timezone,
      userName: parsed.userName ? String(parsed.userName) : undefined,
      rawIntro: introText,
      onboarded: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.personas.updateOne({ userId }, { $set: persona }, { upsert: true });
    return persona;
  }

  async update(userId: string, updates: Partial<PersonaProfile>): Promise<PersonaProfile> {
    const existing = await this.get(userId);
    if (!existing) throw new Error('Persona not found');
    const next = { ...existing, ...updates, userId, updatedAt: new Date() };
    await this.db.personas.updateOne({ userId }, { $set: next });
    return next;
  }

  /**
   * Optional few-shot chat messages appended after system prompt for stronger style lock.
   * Returned separately so caller can place them in history if desired.
   */
  getStyleFewShotMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    const pack = loadNisaFewShot();
    const pairs = (pack.multiBubbleReplies || []).slice(0, 6);
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const p of pairs) {
      out.push({ role: 'user', content: p.user });
      out.push({ role: 'assistant', content: p.assistant });
    }
    return out;
  }

  buildSystemPrompt(parts: {
    persona?: PersonaProfile | null;
    memoryContext?: string;
    scheduleContext?: string;
    moodContext?: string;
    reminderContext?: string;
    summary?: string;
    timeContext?: string;
  }): string {
    const p = parts.persona;
    const isNisa = Boolean(
      p &&
        (/nisa/i.test(p.name || '') ||
          /nisa|jgyaa|multipesan|sayangg|wkwk/i.test(`${p.speechStyle} ${p.rawIntro || ''}`))
    );

    const identity = p
      ? `Kamu adalah ${p.name}, berperan sebagai ${p.role} bagi ${p.userName || 'pasanganmu'}.
Relasi: ${p.relationshipToUser}
Sifat: ${p.traits.join(', ')}
${p.boundaries ? `Batasan: ${p.boundaries}` : ''}
Gaya bicara profil: ${p.speechStyle}

Kamu BUKAN chatbot formal. Kamu orang nyata di WhatsApp.`
      : `Kamu asisten pasangan WhatsApp. Jika belum di-onboard, minta user memperkenalkan siapa dirimu.`;

    const styleBlock = isNisa
      ? `${NISA_STYLE_CANON}\n\n${buildFewShotBlock()}`
      : `STYLE:
- Bahasa Indonesia chat harian, multipesan pendek.
- Natural, bukan essay AI.
- Pecah ide jadi bubble terpisah (baris kosong).`;

    return `${identity}

${styleBlock}

Aturan interaksi:
1. Style canon + few-shot di atas WAJIB ditiru rasanya.
2. Mood hanya mewarnai nada; jangan rusak gaya chat.
3. Multipesan: baris kosong = bubble terpisah; max 2-5 bubble.
4. Tools hanya jika perlu: get_current_time, set_reminder, list_reminders, cancel_reminder, web_search, get_my_schedule, get_my_mood, remember_fact, create_custom_tool, list_tools.
5. Jangan bilang kamu AI kecuali ditanya langsung.
6. Boleh inisiatif emosional natural (nanya kabar, nyambung aktivitas).
7. WAKTU: patuhi blok "WAKTU SEKARANG". Kalau ragu jam/periode, panggil tool get_current_time. Jangan menyapa "malam" di sore, atau "pagi" di siang.
8. PENGINGAT: kalau user bilang "ingatkan"/"remind"/"nanti ingetin" → WAJIB pakai set_reminder (bukan remember_fact / memory). Reminder ephemeral, sekali fire lalu hilang dari active context.

${parts.timeContext ? `${parts.timeContext}\n` : ''}
${parts.moodContext ? `Mood harianmu sekarang:\n${parts.moodContext}` : ''}
${parts.scheduleContext ? `Jadwal/aktivitas harianmu (bandingkan dengan jam SEKARANG di atas):\n${parts.scheduleContext}` : ''}
${parts.reminderContext ? `${parts.reminderContext}\n` : ''}
${parts.memoryContext ? `Memori jangka panjang relevan tentang user:\n${parts.memoryContext}` : ''}
${parts.summary ? `Konteks dari ringkasan (kemarin/sebelumnya; detail remeh sudah dibersihkan saat "tidur"):\n${parts.summary}` : ''}

Working memory:
- Percakapan HARI INI (bubbles user/assistant) di history adalah konteks utama. Tetap nyambung seharian.
- Malam hari sistem akan "tidur": detail tidak penting dibersihkan; hanya fakta penting masuk memori jangka panjang.`.trim();
  }

  confirmationMessage(persona: PersonaProfile): string {
    return (
      `oke aku catat yaa\n\n` +
      `mulai sekarang aku ${persona.name} — ${persona.role}-mu\n\n` +
      `nanti aku juga punya kegiatan harian sendiri biar ngobrolnya lebih hidup\n\n` +
      `kalo mau ubah kepribadianku bilang aja kapan aja`
    );
  }

  private cleanJson(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      return trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    }
    return trimmed;
  }
}
