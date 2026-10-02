import { UserState, UserStateEntry, UserStatusObservation } from '../../../shared/types';
import { Database } from '../../db/mongo';

/**
 * Pelacak kondisi TERKINI user (lokasi/aktivitas/status) dari chat.
 *
 * Masalah yang diselesaikan: memori jangka panjang memang sengaja membuang
 * fakta sementara ("aku udah di rumah" tidak layak disimpan 2 minggu), tapi
 * pesan proaktif 1-2 jam kemudian jadi buta — Nisa bertanya lagi "masih di
 * kantor?" padahal user sudah bilang pulang.
 *
 * State ini disimpan terpisah dari memori (collection user_states), di-inject
 * ke prompt chat & pesan proaktif, dan otomatis dianggap basi setelah TTL.
 */
const STATE_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam
const HISTORY_CAP = 20;

export class UserStateService {
  constructor(private db: Database) {}

  /** Kondisi terkini yang masih segar; null kalau tidak ada / basi. */
  async current(userId: string): Promise<UserStateEntry | null> {
    try {
      const doc = await this.db.userStates.findOne({ userId });
      if (!doc?.current) return null;
      if (Date.now() - new Date(doc.current.at).getTime() > STATE_TTL_MS) return null;
      return doc.current;
    } catch {
      return null;
    }
  }

  async getDoc(userId: string): Promise<UserState | null> {
    return this.db.userStates.findOne({ userId });
  }

  /** Terapkan observasi hasil ekstraksi → jadi kondisi terkini + riwayat. */
  async apply(
    userId: string,
    obs: UserStatusObservation,
    rawText: string
  ): Promise<UserStateEntry | null> {
    const status = (obs.status || '').trim();
    if (!obs.changed || !status) return null;

    const entry: UserStateEntry = {
      status: status.slice(0, 120),
      kind: obs.kind || 'other',
      rawText: (rawText || '').slice(0, 300),
      at: new Date(),
    };

    await this.db.userStates.updateOne(
      { userId },
      {
        $set: { current: entry, updatedAt: new Date() },
        $push: { history: { $each: [entry], $slice: -HISTORY_CAP } },
      },
      { upsert: true }
    );
    return entry;
  }

  /** Blok konteks siap-inject ke system prompt / prompt proaktif. */
  formatContext(entry: UserStateEntry | null): string {
    if (!entry) return '';
    const time = new Date(entry.at).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Jakarta',
    });
    return (
      `KONDISI TERAKHIR USER (jam ${time} WIB, dari chat user sendiri): "${entry.status}".\n` +
      `Anggap ini FAKTA TERBARU soal kondisi user. JANGAN menanyakan ulang kondisi ini — ` +
      `kalau relevan sambungkan saja natural (mis. sambut kabar setelahnya).`
    );
  }
}
