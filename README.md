# Niche Daily

Partner-like AI WhatsApp agent with persistent memory, fictional daily life, proactive messaging, web search, and self-extending tools.

## What it does

- Chat via WhatsApp with a persona you define during onboarding (e.g. pasangan)
- Auto-generates a daily activity schedule and uses it as context
- Sends proactive messages (activity start/end, greetings, check-ins)
- Remembers important facts (MongoDB + embeddings, with text fallback)
- Can create new tools from chat and auto-enable them
- Web search via DuckDuckGo

## Stack

- Backend: Express + TypeScript
- WhatsApp: Baileys
- DB: MongoDB
- LLM: OpenAI-compatible gateway (`API_BASE_URL`)
- Web UI: Next.js dashboard

## Quick start

```bash
cp .env.example .env
# edit .env (MongoDB, API key, AUTHORIZED_PHONE, PORT=3000, WEB_PORT=3001)

npm install
cd web && npm install && cd ..

npm run dev
```

- API: http://localhost:3000
- Web UI: http://localhost:3001
- Scan WhatsApp QR from the **WhatsApp** tab
- First chat: introduce who the agent is (name, role, personality)

## Important env

| Key | Purpose |
|---|---|
| `MONGODB_URI` | Mongo connection |
| `API_BASE_URL` / `API_KEY` / `API_MODEL` | Chat model gateway |
| `EMBEDDING_MODEL` | Embedding model (optional; memory falls back without vectors) |
| `AUTHORIZED_PHONE` | Single allowed WhatsApp number (digits, e.g. 628...) |
| `TIMEZONE` | Daily schedule timezone (default Asia/Jakarta) |
| `PROACTIVE_MAX_PER_DAY` | Cap proactive spam |
| `ENABLE_QUIET_HOURS` | Night silence window |

## Architecture

```
server/
  config/           env
  core/             LLM client + agent loop
  db/               Mongo collections
  domain/
    persona/        onboarding + personality
    schedule/       daily life generation
    proactive/      outbound human-like messages
    tools/          registry, sandbox, self-create
    memory/         extract + retrieve
    conversation/   history compaction
  integrations/
    whatsapp/       Baileys bot
    search/         DuckDuckGo
  jobs/             schedule/proactive ticks
  routes/           HTTP API
```

## Builtin tools

- `web_search` — DuckDuckGo
- `get_my_schedule` — today’s activities
- `get_persona` — persona profile
- `remember_fact` — store memory
- `create_custom_tool` — auto-enable new tool from chat
- `list_tools`

## Notes

- Baileys is unofficial WhatsApp; account risk exists.
- Custom tools run in a restricted VM sandbox (not perfect isolation).
- Self-created tools are auto-enabled by design (personal use).
- DuckDuckGo quality is limited; tool interface can later swap providers.
