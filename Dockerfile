# Niche Daily — single image (API + Web UI)
# For Dokploy / Docker Compose

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# ---------- deps: server ----------
FROM base AS server-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- deps: web ----------
FROM base AS web-deps
COPY web/package.json web/package-lock.json ./web/
WORKDIR /app/web
RUN npm ci

# ---------- build server ----------
FROM base AS server-build
COPY package.json package-lock.json tsconfig.json ./
COPY server ./server
COPY shared ./shared
RUN npm ci
RUN npm run build:server \
  && mkdir -p dist/server/domain/persona \
  && cp server/domain/persona/nisa-fewshot.json dist/server/domain/persona/nisa-fewshot.json

# ---------- build web ----------
FROM base AS web-build
COPY --from=web-deps /app/web/node_modules ./web/node_modules
COPY web ./web
COPY shared ./shared
# Ensure shared types resolve for next if imported from parent
WORKDIR /app/web
RUN npm run build

# ---------- runtime ----------
FROM base AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    curl \
  && rm -rf /var/lib/apt/lists/*

# server runtime deps + build output
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY package.json ./
# fallback path for few-shot loader
COPY server/domain/persona/nisa-fewshot.json ./server/domain/persona/nisa-fewshot.json

# web runtime
COPY --from=web-build /app/web/.next ./web/.next
COPY --from=web-build /app/web/public ./web/public
COPY --from=web-build /app/web/package.json ./web/package.json
COPY --from=web-build /app/web/next.config.js ./web/next.config.js
COPY --from=web-build /app/web/node_modules ./web/node_modules

COPY docker/start.sh ./start.sh
RUN chmod +x ./start.sh \
  && mkdir -p /app/whatsapp_auth /app/server/domain/persona

EXPOSE 3000 3001
VOLUME ["/app/whatsapp_auth"]

ENV PORT=3000 \
    WEB_PORT=3001 \
    API_PORT=3000 \
    WHATSAPP_AUTH_DIR=/app/whatsapp_auth \
    NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./start.sh"]
