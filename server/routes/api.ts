import { Router, Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { Database } from '../db/mongo';
import { ToolRegistry } from '../domain/tools/registry';
import { MemoryService } from '../domain/memory/service';
import { PersonaService } from '../domain/persona/service';
import { ScheduleService } from '../domain/schedule/service';
import { MoodService } from '../domain/mood/service';
import { WhatsAppBot } from '../integrations/whatsapp/bot';
import { Client } from '../core/client';
import { MoodLabel } from '../../shared/types';

export function createApiRouter(deps: {
  db: Database;
  tools: ToolRegistry;
  memoryService: MemoryService;
  personaService: PersonaService;
  scheduleService: ScheduleService;
  moodService: MoodService;
  whatsappBot: WhatsAppBot;
  client: Client;
}): Router {
  const router = Router();
  const {
    db,
    tools,
    memoryService,
    personaService,
    scheduleService,
    moodService,
    whatsappBot,
    client,
  } = deps;

  const userId = () => env.authorizedPhone.replace(/\D/g, '');

  function requireToken(req: Request, res: Response, next: NextFunction) {
    if (req.method === 'GET') return next();
    const token = (req.headers['x-api-token'] as string) || (req.query.token as string);
    if (token && token === env.apiToken) return next();
    // Allow local no-token in simple personal mode if token default
    if (!req.headers['x-api-token'] && env.apiToken === 'niche-daily-local') return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }

  router.use(requireToken);

  router.get('/health', async (_req, res) => {
    const mongoOk = await db.ping();
    res.json({
      status: mongoOk && whatsappBot ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      gateway: {
        baseUrl: env.apiBaseUrl,
        model: env.apiModel,
        embeddingModel: env.embeddingModel,
      },
      services: {
        mongodb: mongoOk ? 'connected' : 'disconnected',
        whatsapp: whatsappBot.isConnected() ? 'connected' : whatsappBot.getQRCode() ? 'connecting' : 'disconnected',
        agent: client ? 'ready' : 'not ready',
      },
    });
  });

  // Tools
  router.get('/tools', (req, res) => {
    const category = req.query.category as string | undefined;
    const list = category
      ? tools.getToolsByCategory(category as any)
      : tools.getAllTools();
    res.json({ tools: list });
  });

  router.get('/tools/:id', async (req, res) => {
    const tool = tools.getById(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const executionHistory = await tools.getExecutionHistory(tool.id);
    res.json({ tool, executionHistory });
  });

  router.post('/tools', async (req, res) => {
    try {
      const { name, description, category, functionCode, parameters } = req.body;
      if (!name || !description || !functionCode) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const tool = await tools.createTool({
        name,
        description,
        category: category || 'custom',
        functionCode,
        parameters: parameters || [],
        source: 'web_ui',
        enabled: true,
      });
      res.status(201).json({ tool });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/tools/:id', async (req, res) => {
    try {
      const tool = await tools.updateTool(req.params.id, req.body);
      res.json({ tool });
    } catch (error: any) {
      res.status(404).json({ error: error.message });
    }
  });

  router.delete('/tools/:id', async (req, res) => {
    try {
      await tools.deleteTool(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Memories
  router.get('/memories', async (req, res) => {
    try {
      const uid = (req.query.userId as string) || userId();
      const query = (req.query.query as string) || '';
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;
      const memories = await memoryService.search(uid, query, limit);
      res.json({ memories });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/memories/stats', async (req, res) => {
    try {
      const uid = (req.query.userId as string) || userId();
      const stats = await memoryService.stats(uid);
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Persona
  router.get('/persona', async (_req, res) => {
    const persona = await personaService.get(userId());
    res.json({ persona });
  });

  router.put('/persona', async (req, res) => {
    try {
      const persona = await personaService.update(userId(), req.body);
      res.json({ persona });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Schedule
  router.get('/schedule/today', async (_req, res) => {
    const uid = userId();
    const persona = await personaService.get(uid);
    const mood = await moodService.ensureToday(uid, persona);
    const schedule = await scheduleService.ensureToday(uid, persona, mood.current.label);
    res.json({
      schedule,
      context: scheduleService.formatTodayContext(schedule),
      mood: mood.current,
    });
  });

  // Mood
  router.get('/mood/today', async (_req, res) => {
    try {
      const uid = userId();
      const persona = await personaService.get(uid);
      const mood = await moodService.ensureToday(uid, persona);
      res.json({
        mood,
        context: moodService.formatContext(mood),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/mood/history', async (req, res) => {
    try {
      const days = req.query.days ? parseInt(String(req.query.days), 10) : 7;
      const history = await moodService.history(userId(), days);
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/mood', async (req, res) => {
    try {
      const { label, valence, energy, note } = req.body || {};
      const mood = await moodService.setMood(userId(), {
        label: label as MoodLabel | undefined,
        valence: valence !== undefined ? Number(valence) : undefined,
        energy: energy !== undefined ? Number(energy) : undefined,
        note,
        source: 'manual',
      });
      res.json({
        mood,
        context: moodService.formatContext(mood),
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/mood/regenerate', async (_req, res) => {
    try {
      const uid = userId();
      const persona = await personaService.get(uid);
      // Force new mood for today by deleting and regenerating
      const date = new Date().toLocaleDateString('en-CA', { timeZone: env.timezone });
      await db.moods.deleteOne({ userId: uid, date });
      const mood = await moodService.generateForDate(uid, date, persona);
      res.json({ mood, context: moodService.formatContext(mood) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // WhatsApp — QR is generated by Baileys on backend; UI only renders it.
  router.get('/whatsapp/qr', (_req, res) => {
    const status = whatsappBot.getStatus();
    res.json({
      qr: whatsappBot.getQRCode(),
      connected: status.connected,
      status: status.status,
      qrUpdatedAt: status.qrUpdatedAt,
      lastError: status.lastError,
    });
  });

  router.get('/whatsapp/status', (_req, res) => {
    res.json(whatsappBot.getStatus());
  });

  router.post('/whatsapp/restart', async (_req, res) => {
    try {
      await whatsappBot.restartPairing(true);
      res.json({
        success: true,
        message: 'Pairing restarted. Wait for QR, then scan from Web UI.',
        status: whatsappBot.getStatus(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to restart pairing' });
    }
  });

  return router;
}
