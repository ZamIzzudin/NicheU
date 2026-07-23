import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { Database } from './db/mongo';
import { Client } from './core/client';
import { ToolRegistry } from './domain/tools/registry';
import { MemoryService } from './domain/memory/service';
import { PersonaService } from './domain/persona/service';
import { ScheduleService } from './domain/schedule/service';
import { ConversationService } from './domain/conversation/service';
import { ProactiveService } from './domain/proactive/service';
import { MoodService } from './domain/mood/service';
import { WhatsAppBot } from './integrations/whatsapp/bot';
import { JobScheduler } from './jobs/scheduler';
import { createApiRouter } from './routes/api';

async function main() {
  console.log('🚀 Starting Niche Daily...\n');

  const db = new Database(env.mongodbUri);
  console.log('📦 Connecting to MongoDB...');
  await db.connect();
  console.log('✓ MongoDB connected\n');

  const client = new Client({
    name: env.apiModel,
    base_url: env.apiBaseUrl,
    api_key: env.apiKey,
  });
  console.log('🤖 Agent client ready');
  console.log(`  Gateway: ${env.apiBaseUrl}`);
  console.log(`  Model: ${env.apiModel}\n`);

  const tools = new ToolRegistry(db);
  await tools.init();
  console.log(`🔧 Tools loaded (${tools.getAllTools().length})\n`);

  const memoryService = new MemoryService(db, client);
  const personaService = new PersonaService(db, client);
  const scheduleService = new ScheduleService(db, client);
  const conversationService = new ConversationService(db, client);
  const moodService = new MoodService(db, client);
  const proactiveService = new ProactiveService(db, client, scheduleService, moodService);
  await proactiveService.init();
  console.log('✓ Proactive service ready\n');

  tools.setContext({
    memoryService,
    scheduleService,
    personaService,
    moodService,
  });

  console.log('📱 Starting WhatsApp bot...');
  const whatsappBot = new WhatsAppBot(
    client,
    tools,
    memoryService,
    personaService,
    scheduleService,
    conversationService,
    proactiveService,
    moodService
  );
  await whatsappBot.start();
  console.log('✓ WhatsApp bot started\n');

  const scheduler = new JobScheduler(
    db,
    personaService,
    scheduleService,
    proactiveService,
    moodService,
    async (userId, text) => {
      if (!whatsappBot.isConnected()) return;
      await whatsappBot.sendToUser(userId, text);
      console.log(`📤 Proactive -> ${userId}: ${text.slice(0, 80)}...`);
    },
    () => env.authorizedPhone.replace(/\D/g, '')
  );
  scheduler.start();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.use(
    '/api',
    createApiRouter({
      db,
      tools,
      memoryService,
      personaService,
      scheduleService,
      moodService,
      whatsappBot,
      client,
    })
  );

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('API Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(env.port, '0.0.0.0', () => {
    console.log('═════════════════════════════════════════════════════');
    console.log(`  🌐 API Server http://0.0.0.0:${env.port}`);
    console.log(`  🖥  Web UI     http://0.0.0.0:${env.webPort}`);
    console.log('═════════════════════════════════════════════════════\n');
  });

  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    scheduler.stop();
    server.close();
    await whatsappBot.disconnect();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
