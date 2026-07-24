import makeWASocket, {
  WASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import qrCodeTerminal from 'qrcode-terminal';
import { Client } from '../../core/client';
import { runAgentTurn } from '../../core/agent';
import { Message } from '../../core/types';
import { MemoryService } from '../../domain/memory/service';
import { ToolRegistry } from '../../domain/tools/registry';
import { PersonaService } from '../../domain/persona/service';
import { ScheduleService } from '../../domain/schedule/service';
import { ConversationService } from '../../domain/conversation/service';
import { ProactiveService } from '../../domain/proactive/service';
import { MoodService } from '../../domain/mood/service';
import { env } from '../../config/env';

export type WaConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'logged_out'
  | 'error';

export class WhatsAppBot {
  private socket: WASocket | null = null;
  private logger = pino({ level: 'silent' });
  // Digits-only — must match API persona/memory userId
  private authorizedPhone = env.authorizedPhone.replace(/\D/g, '');
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 8;
  private currentQRCode: string | null = null;
  private qrUpdatedAt: number | null = null;
  private connectionStatus: WaConnectionStatus = 'idle';
  private lastError: string | null = null;
  private processing = new Set<string>();
  private lastUserMessageAt = 0;
  private starting = false;
  private intentionalStop = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** LID (Linked ID) -> phone digits map. WhatsApp privacy IDs != phone numbers. */
  private lidToPhone = new Map<string, string>();
  private phoneToLid = new Map<string, string>();

  /**
   * Debounce multipesan user bubbles into one agent turn.
   * Waits USER_BUBBLE_DEBOUNCE_SEC after last bubble, then merges texts.
   */
  private pendingBubbles = new Map<
    string,
    {
      texts: string[];
      replyJid: string;
      timer: NodeJS.Timeout;
      lastAt: number;
    }
  >();

  constructor(
    private client: Client,
    private tools: ToolRegistry,
    private memoryService: MemoryService,
    private personaService: PersonaService,
    private scheduleService: ScheduleService,
    private conversationService: ConversationService,
    private proactiveService: ProactiveService,
    private moodService: MoodService
  ) {}

  async start(): Promise<void> {
    this.intentionalStop = false;
    await this.initializeSocket();
  }

  getQRCode(): string | null {
    return this.currentQRCode;
  }

  isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  getAuthorizedPhone(): string {
    return this.authorizedPhone;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  getLastUserMessageAt(): number {
    return this.lastUserMessageAt;
  }

  getStatus() {
    return {
      connected: this.connectionStatus === 'connected',
      status: this.connectionStatus,
      authorizedPhone: this.authorizedPhone,
      reconnectAttempts: this.reconnectAttempts,
      hasQr: Boolean(this.currentQRCode),
      qrUpdatedAt: this.qrUpdatedAt,
      lastError: this.lastError,
    };
  }

  /** Clear session and start fresh QR pairing (same idea as whatsmeow UI flow). */
  async restartPairing(clearAuth = true): Promise<void> {
    console.log('🔄 Restarting WhatsApp pairing...');
    this.intentionalStop = true;
    this.clearReconnectTimer();
    await this.closeSocket();
    if (clearAuth) this.clearAuthDir();
    this.currentQRCode = null;
    this.qrUpdatedAt = null;
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.connectionStatus = 'connecting';
    this.intentionalStop = false;
    await this.initializeSocket();
  }

  async disconnect(): Promise<void> {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    await this.closeSocket();
    this.connectionStatus = 'idle';
  }

  async sendToAuthorized(text: string): Promise<void> {
    await this.sendToUser(this.authorizedPhone, text);
  }

  async sendToUser(userId: string, text: string): Promise<void> {
    if (!this.socket || this.connectionStatus !== 'connected') {
      throw new Error('WhatsApp not connected');
    }
    const normalized = userId.replace(/\D/g, '');
    // Prefer known LID chat jid if we learned it from inbound messages
    const lid = this.phoneToLid.get(normalized);
    const jid = lid ? `${lid}@lid` : `${normalized}@s.whatsapp.net`;
    await this.sendTextBubbles(jid, text);
  }

  /**
   * Split a multi-paragraph reply into separate WhatsApp bubbles so it feels
   * more human than one long AI-style message block.
   */
  private splitIntoBubbles(text: string, maxBubbles = 6): string[] {
    const cleaned = text.replace(/\r\n/g, '\n').trim();
    if (!cleaned) return [];

    // Prefer blank-line paragraphs; fallback to single newlines; last resort chunk long lines.
    let parts = cleaned
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length === 1 && cleaned.includes('\n')) {
      parts = cleaned
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
    }

    // Merge tiny fragments (e.g. emoji-only) into previous bubble
    const merged: string[] = [];
    for (const part of parts) {
      if (merged.length && part.length <= 8) {
        merged[merged.length - 1] = `${merged[merged.length - 1]}\n${part}`.trim();
      } else {
        merged.push(part);
      }
    }

    // If still one huge wall of text, soft-split by sentence groups
    if (merged.length === 1 && merged[0].length > 280) {
      const sentences = merged[0].split(/(?<=[.!?…])\s+/).filter(Boolean);
      const chunks: string[] = [];
      let buf = '';
      for (const s of sentences) {
        if ((buf + ' ' + s).trim().length > 180 && buf) {
          chunks.push(buf.trim());
          buf = s;
        } else {
          buf = `${buf} ${s}`.trim();
        }
      }
      if (buf) chunks.push(buf.trim());
      if (chunks.length > 1) return chunks.slice(0, maxBubbles);
    }

    if (merged.length <= maxBubbles) return merged;

    // Collapse overflow into last bubble instead of dropping content
    const head = merged.slice(0, maxBubbles - 1);
    const tail = merged.slice(maxBubbles - 1).join('\n\n');
    return [...head, tail];
  }

  private bubbleDelayMs(bubble: string, index: number): number {
    // Natural typing cadence: longer text => slightly longer pause, with jitter
    const base = 450 + Math.min(bubble.length * 12, 1800);
    const jitter = Math.floor(Math.random() * 350);
    // First bubble slightly faster so user feels immediate response
    const firstBoost = index === 0 ? -200 : 0;
    return Math.max(350, base + jitter + firstBoost);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendTextBubbles(jid: string, text: string): Promise<void> {
    if (!this.socket) throw new Error('WhatsApp socket not ready');
    const bubbles = this.splitIntoBubbles(text);
    if (!bubbles.length) return;

    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      try {
        await this.socket.sendPresenceUpdate('composing', jid);
      } catch {
        // presence is best-effort
      }

      if (i > 0 || bubbles.length === 1) {
        await this.sleep(this.bubbleDelayMs(bubble, i));
      } else {
        // brief composing even for first bubble
        await this.sleep(Math.min(700, this.bubbleDelayMs(bubble, i)));
      }

      await this.socket.sendMessage(jid, { text: bubble });

      try {
        await this.socket.sendPresenceUpdate('paused', jid);
      } catch {
        // ignore
      }
    }
  }

  private async initializeSocket(): Promise<void> {
    if (this.starting) return;
    this.starting = true;

    try {
      await this.closeSocket();

      const authDir = path.resolve(process.cwd(), env.whatsappAuthDir);
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1015901307] as [number, number, number],
        isLatest: false,
      }));

      console.log(
        `📱 Starting WA socket (Baileys WA v${version.join('.')}${isLatest ? '' : ' ~fallback'})...`
      );

      this.connectionStatus = this.currentQRCode ? 'qr' : 'connecting';
      this.lastError = null;

      this.socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        logger: this.logger,
        browser: ['Niche Daily', 'Chrome', '122.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
      });

      this.socket.ev.on('creds.update', saveCreds);

      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR is generated by Baileys backend — UI only displays this string.
        if (qr) {
          this.currentQRCode = qr;
          this.qrUpdatedAt = Date.now();
          this.connectionStatus = 'qr';
          this.reconnectAttempts = 0;
          this.lastError = null;
          console.log('\n📱 QR ready — scan di Web UI (tab WhatsApp)');
          console.log(`   Web: http://localhost:${env.webPort}`);
          try {
            qrCodeTerminal.generate(qr, { small: true });
          } catch {
            // terminal optional
          }
        }

        if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.currentQRCode = null;
          this.qrUpdatedAt = null;
          this.reconnectAttempts = 0;
          this.lastError = null;
          this.clearReconnectTimer();
          this.captureSelfIdentity();
          console.log(`✅ WhatsApp connected. Authorized: ${this.authorizedPhone}`);
          return;
        }

        if (connection === 'connecting') {
          if (this.connectionStatus !== 'qr') {
            this.connectionStatus = 'connecting';
          }
          return;
        }

        if (connection === 'close') {
          if (this.intentionalStop) {
            this.connectionStatus = 'idle';
            return;
          }

          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const errorMsg =
            (lastDisconnect?.error as Error)?.message ||
            `disconnect code ${statusCode ?? 'unknown'}`;
          this.lastError = errorMsg;
          console.log(`⚠️  WA closed: ${errorMsg}`);

          // Logged out / invalid session → wipe auth and re-pair with fresh QR
          const loggedOut =
            statusCode === DisconnectReason.loggedOut ||
            statusCode === 401 ||
            statusCode === 403;

          if (loggedOut) {
            console.log('🔓 Session invalid/logged out — clearing auth for new QR...');
            this.connectionStatus = 'logged_out';
            this.clearAuthDir();
            this.currentQRCode = null;
            this.reconnectAttempts = 0;
            this.scheduleReconnect(1500);
            return;
          }

          // Keep QR available while we still have one; otherwise reconnect
          this.connectionStatus = this.currentQRCode ? 'qr' : 'connecting';
          this.reconnectAttempts++;

          if (this.reconnectAttempts > this.maxReconnectAttempts) {
            // Don't die forever: open pairing mode and wait for manual/API restart
            console.log(
              '❌ Reconnect limit reached. Minta QR baru dari UI (tombol Restart Pairing).'
            );
            this.connectionStatus = 'error';
            this.lastError = 'Reconnect limit reached. Restart pairing from web UI.';
            return;
          }

          const delay = Math.min(1000 * this.reconnectAttempts, 8000);
          console.log(
            `↻ Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`
          );
          this.scheduleReconnect(delay);
        }
      });

      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const message of messages) {
          if (!message.message || message.key.fromMe) continue;
          const from = message.key.remoteJid;
          if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue;

          // WhatsApp now often sends 1:1 chats as @lid (Linked ID), not phone@s.whatsapp.net.
          // AUTHORIZED_PHONE stays a real phone number; we resolve PN from key.senderPn / etc.
          const identity = this.resolveSenderIdentity(message);
          if (!this.isAuthorizedIdentity(identity)) {
            console.log(
              `Unauthorized message from: ${from}` +
                (identity.phone ? ` (pn=${identity.phone})` : ' (no phone mapped)') +
                (identity.lid ? ` (lid=${identity.lid})` : '')
            );
            continue;
          }

          // Remember LID <-> phone mapping for later outbound/auth
          if (identity.lid && identity.phone) {
            this.lidToPhone.set(identity.lid, identity.phone);
            this.phoneToLid.set(identity.phone, identity.lid);
          }

          const text = this.extractText(message);
          if (!text) continue;

          const userId = identity.phone || this.authorizedPhone;
          const replyJid = from; // reply on same chat jid (may be @lid)
          this.lastUserMessageAt = Date.now();
          this.enqueueUserBubble(userId, replyJid, text);
        }
      });
    } catch (error: any) {
      this.lastError = error?.message || String(error);
      this.connectionStatus = 'error';
      console.error('Failed to initialize WhatsApp socket:', this.lastError);
      this.scheduleReconnect(3000);
    } finally {
      this.starting = false;
    }
  }

  private scheduleReconnect(delayMs: number) {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.initializeSocket().catch((err) => {
        console.error('Reconnect failed:', err);
      });
    }, delayMs);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async closeSocket() {
    const sock = this.socket;
    this.socket = null;
    if (!sock) return;
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
    } catch {
      // ignore
    }
    try {
      sock.end(undefined);
    } catch {
      // ignore
    }
  }

  private clearAuthDir() {
    const authDir = path.resolve(process.cwd(), env.whatsappAuthDir);
    try {
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
      fs.mkdirSync(authDir, { recursive: true });
      console.log('🧹 Cleared whatsapp_auth');
    } catch (error: any) {
      console.warn('Failed clearing auth dir:', error.message);
    }
  }

  private extractText(message: any): string | null {
    return (
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      null
    );
  }

  /**
   * Collect multipesan bubbles, wait until user stops typing/sending
   * for USER_BUBBLE_DEBOUNCE_SEC (default 120s), then process as one prompt.
   */
  private enqueueUserBubble(userId: string, replyJid: string, text: string) {
    const waitMs = Math.max(5, env.userBubbleDebounceSec) * 1000;
    const existing = this.pendingBubbles.get(userId);

    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(text);
      existing.replyJid = replyJid;
      existing.lastAt = Date.now();
      existing.timer = setTimeout(() => {
        this.flushUserBubbles(userId).catch((err) =>
          console.error('flushUserBubbles error:', err)
        );
      }, waitMs);
      console.log(
        `⏳ Bubble buffered (${existing.texts.length}) from ${userId}; wait ${env.userBubbleDebounceSec}s`
      );
      return;
    }

    const timer = setTimeout(() => {
      this.flushUserBubbles(userId).catch((err) =>
        console.error('flushUserBubbles error:', err)
      );
    }, waitMs);

    this.pendingBubbles.set(userId, {
      texts: [text],
      replyJid,
      timer,
      lastAt: Date.now(),
    });
    console.log(
      `⏳ First bubble from ${userId}; wait ${env.userBubbleDebounceSec}s for more...`
    );

    // Soft presence while waiting (best effort)
    this.socket?.sendPresenceUpdate('available', replyJid).catch(() => undefined);
  }

  private async flushUserBubbles(userId: string) {
    const pending = this.pendingBubbles.get(userId);
    if (!pending) return;
    this.pendingBubbles.delete(userId);

    if (this.processing.has(userId)) {
      // re-queue briefly if previous turn still running
      this.pendingBubbles.set(userId, {
        ...pending,
        timer: setTimeout(() => {
          this.flushUserBubbles(userId).catch(console.error);
        }, 3000),
      });
      return;
    }

    const merged = pending.texts
      .map((t) => t.trim())
      .filter(Boolean)
      .join('\n');
    if (!merged) return;

    const replyJid = pending.replyJid;
    this.processing.add(userId);
    try {
      // Pause proactive while user is chatting
      await this.proactiveService.suppressWhileUserActive(userId, 25);

      console.log(
        `\n📩 ${userId} (${pending.texts.length} bubble(s) merged):\n${merged}`
      );
      await this.processMessage(replyJid, userId, merged);
    } catch (error) {
      console.error('Process message error:', error);
      try {
        await this.sendTextBubbles(
          replyJid,
          'Aduh, barusan ada error di aku.\n\nCoba kirim lagi ya.'
        );
      } catch {
        // ignore
      }
    } finally {
      this.processing.delete(userId);
    }
  }

  private captureSelfIdentity() {
    try {
      const user = (this.socket as any)?.user;
      if (!user) return;
      const selfPhone =
        this.extractPhoneDigits(user.id) ||
        this.extractPhoneDigits(user.jid) ||
        this.authorizedPhone.replace(/\D/g, '');
      const selfLid = this.extractLid(user.lid) || this.extractLid(user.id);
      if (selfPhone && selfLid) {
        this.lidToPhone.set(selfLid, selfPhone);
        this.phoneToLid.set(selfPhone, selfLid);
        console.log(`🔗 Mapped self identity lid=${selfLid} -> pn=${selfPhone}`);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Resolve real phone + lid from a WA message.
   * Modern WhatsApp often uses remoteJid = "<id>@lid" instead of phone@s.whatsapp.net.
   * Phone may still appear on key.senderPn / participantPn.
   *
   * Note: @lid is NOT your phone number and must not be put in AUTHORIZED_PHONE.
   */
  private resolveSenderIdentity(message: any): { phone?: string; lid?: string; rawJid?: string } {
    const key = message?.key || {};
    const rawJid: string | undefined = key.remoteJid || undefined;

    const candidates: Array<string | undefined | null> = [
      key.senderPn,
      key.participantPn,
      (key as any).remoteJidAlt,
      (key as any).peer_recipient_pn,
      rawJid?.endsWith('@s.whatsapp.net') || rawJid?.endsWith('@c.us') ? rawJid : undefined,
    ];

    let phone: string | undefined;
    for (const c of candidates) {
      const p = this.extractPhoneDigits(c);
      if (p) {
        phone = p;
        break;
      }
    }

    let lid =
      this.extractLid(rawJid) ||
      this.extractLid(key.senderLid) ||
      this.extractLid(key.participantLid);

    // previously learned mapping
    if (!phone && lid && this.lidToPhone.has(lid)) {
      phone = this.lidToPhone.get(lid);
    }

    // self-chat / notes-to-self: remote lid equals linked account lid
    if (!phone && lid) {
      const allowed = this.authorizedPhone.replace(/\D/g, '');
      if (this.lidToPhone.get(lid) === allowed) {
        phone = allowed;
      }
    }

    // Single-user bot fallback: if this linked account's own phone is AUTHORIZED_PHONE,
    // and we still only see @lid without PN, treat as owner only when remote lid is
    // already known as self, OR ALLOW_LID_OWNER_FALLBACK is enabled (default true).
    if (!phone && lid && this.shouldAcceptUnknownLidAsOwner()) {
      phone = this.authorizedPhone.replace(/\D/g, '');
      this.lidToPhone.set(lid, phone);
      this.phoneToLid.set(phone, lid);
      console.log(`🔗 Learned owner lid mapping: ${lid} -> ${phone}`);
    }

    return { phone, lid, rawJid };
  }

  private shouldAcceptUnknownLidAsOwner(): boolean {
    // Default ON for personal single-user Niche Daily.
    // Disable with ALLOW_LID_OWNER_FALLBACK=false if bot sits on a shared number.
    const flag = process.env.ALLOW_LID_OWNER_FALLBACK;
    if (flag && ['0', 'false', 'no', 'off'].includes(flag.toLowerCase())) return false;
    return true;
  }

  private isAuthorizedIdentity(identity: { phone?: string; lid?: string }): boolean {
    const allowed = this.authorizedPhone.replace(/\D/g, '');
    if (!allowed) return false;
    if (identity.phone && identity.phone === allowed) return true;
    if (identity.lid && this.lidToPhone.get(identity.lid) === allowed) return true;
    return false;
  }

  private extractLid(value?: string | null): string | undefined {
    if (!value) return undefined;
    const raw = String(value);
    if (raw.includes('@lid') || !raw.includes('@')) {
      const digits = raw.replace(/@lid$/i, '').replace(/:\d+$/, '').replace(/\D/g, '');
      return digits || undefined;
    }
    return undefined;
  }

  private extractPhoneDigits(value?: string | null): string | undefined {
    if (!value) return undefined;
    const raw = String(value);
    // Never treat @lid identifiers as phone numbers
    if (raw.includes('@lid')) return undefined;
    const cleaned = raw
      .replace(/@s\.whatsapp\.net$/i, '')
      .replace(/@c\.us$/i, '')
      .replace(/:\d+$/, '');
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return digits;
    return undefined;
  }


  private async processMessage(from: string, userId: string, text: string): Promise<void> {
    const onboarded = await this.personaService.isOnboarded(userId);
    if (!onboarded) {
      const existing = await this.personaService.get(userId);
      const history = await this.conversationService.getHistory(userId);
      if (!existing && history.length === 0) {
        const prompt = this.personaService.onboardingPrompt();
        await this.sendTextBubbles(from, prompt);
        await this.conversationService.saveHistory(userId, [
          { role: 'assistant', content: prompt },
        ]);
        return;
      }

      console.log('Creating persona from intro...');
      const persona = await this.personaService.createFromIntro(userId, text);
      const mood = await this.moodService.ensureToday(userId, persona);
      await this.scheduleService.ensureToday(userId, persona, mood.current.label);
      const confirm = this.personaService.confirmationMessage(persona);
      await this.sendTextBubbles(from, confirm);
      await this.conversationService.saveHistory(userId, [
        { role: 'user', content: text },
        { role: 'assistant', content: confirm },
      ]);
      return;
    }

    const persona = await this.personaService.get(userId);
    // Mild mood drift from user's message tone
    const mood = await this.moodService.driftFromConversation(userId, text);
    const schedule = await this.scheduleService.ensureToday(
      userId,
      persona,
      mood.current.label
    );

    console.log('🧠 Extracting memories...');
    const storedMemories = await this.memoryService.extractAndStore(userId, text);
    if (storedMemories.length) {
      console.log(`✓ Stored ${storedMemories.length} memories`);
    }

    console.log('🔍 Retrieving memories...');
    const relevant = await this.memoryService.search(userId, text);
    const memoryContext = this.memoryService.formatContext(relevant);
    const scheduleContext = this.scheduleService.formatTodayContext(schedule);
    const moodContext = this.moodService.formatContext(mood);
    console.log(`💫 Mood: ${mood.current.emoji} ${mood.current.label} (${mood.current.color})`);

    const history = await this.conversationService.getHistory(userId);
    const systemPrompt = this.personaService.buildSystemPrompt({
      persona,
      memoryContext,
      scheduleContext,
      moodContext,
      summary: undefined,
    });

    const turnHistory: Message[] = [{ role: 'system', content: systemPrompt }];

    // Few-shot style lock (in-context examples) before real conversation history.
    // Only seed when history is still short so we don't bloat every long session.
    const nonSystemHistory = history.filter((m) => m.role !== 'system');
    if (nonSystemHistory.length < 8) {
      for (const shot of this.personaService.getStyleFewShotMessages()) {
        turnHistory.push({ role: shot.role, content: shot.content });
      }
    }

    for (const m of nonSystemHistory) {
      turnHistory.push(m as Message);
    }
    turnHistory.push({ role: 'user', content: text });

    this.tools.setContext({
      userId,
      memoryService: this.memoryService,
      scheduleService: this.scheduleService,
      personaService: this.personaService,
      moodService: this.moodService,
    });

    console.log('🤖 Agent turn...');
    let responseText = '';
    const final = await runAgentTurn(
      this.client,
      this.tools,
      turnHistory,
      (token) => {
        responseText += token;
      },
      { userId }
    );

    const reply = (final || responseText || 'Hmm, aku blank sebentar.\n\nUlangi ya.').trim();
    await this.sendTextBubbles(from, reply);

    const toSave = turnHistory.filter((m) => m.role !== 'tool');
    if (!toSave.some((m) => m.role === 'assistant' && m.content === reply)) {
      toSave.push({ role: 'assistant', content: reply });
    }
    await this.conversationService.saveHistory(userId, toSave);
    await this.proactiveService.enqueueIdleNudge(userId);
    console.log(`✓ Response sent (${this.splitIntoBubbles(reply).length} bubbles)\n`);
  }
}
