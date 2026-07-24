# Niche Daily — single image (API + Web UI)
# For Dokploy / Docker Compose

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Do NOT set NODE_ENV=production in base.
# Build stages need devDependencies (typescript, next, tailwind, etc).

# ---------- deps: server (prod only) ----------
FROM base AS server-deps
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---------- deps: server (with dev for tsc) ----------
FROM base AS server-build-deps
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------- deps: web (needs devDeps for next build) ----------
FROM base AS web-deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
# Force install of ALL deps including devDependencies for next build
RUN npm install --include=dev

# ---------- build server ----------
FROM base AS server-build
COPY --from=server-build-deps /app/node_modules ./node_modules
COPY package.json package-lock.json* tsconfig.json ./
COPY server ./server
COPY shared ./shared
RUN npm run build:server \
  && mkdir -p dist/server/domain/persona \
  && (cp server/domain/persona/nisa-fewshot.json dist/server/domain/persona/nisa-fewshot.json 2>/dev/null || true)

# ---------- build web ----------
FROM base AS web-build
COPY --from=web-deps /app/web/node_modules ./web/node_modules
COPY web ./web
COPY shared ./shared
WORKDIR /app/web
# Bake API rewrite destination into Next production build.
# Runtime env alone is NOT enough: next.config rewrites() run at build time.
ENV NODE_ENV=production \
    API_PORT=4000 \
    BACKEND_PORT=4000
RUN npm run build

# ---------- runtime ----------
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# System deps: tini/curl + Firefox libraries for Playwright headless search bot
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    curl \
    libgtk-3-0 \
    libx11-xcb1 \
    libasound2 \
    libdbus-glib-1-2 \
    libxt6 \
    libxrender1 \
    libpci3 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libxkbcommon0 \
    libnss3 \
    libnspr4 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# server runtime deps + build output
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY package.json package-lock.json* ./
COPY server/domain/persona/nisa-fewshot.json ./server/domain/persona/nisa-fewshot.json
# also ship compiled-data module fallback already in dist

# Install Firefox browser binary for Playwright (google_search bot)
RUN npx playwright install firefox \
  || (npm install playwright@1.49.1 && npx playwright install firefox) \
  || echo "WARN: playwright firefox install failed — google_search bot may not work"

# web runtime
COPY --from=web-build /app/web/.next ./web/.next
COPY --from=web-build /app/web/public ./web/public
COPY --from=web-build /app/web/package.json ./web/package.json
COPY --from=web-build /app/web/next.config.js ./web/next.config.js
COPY --from=web-build /app/web/node_modules ./web/node_modules

COPY docker/start.sh ./start.sh
RUN sed -i 's/\r$//' ./start.sh \
  && chmod +x ./start.sh \
  && mkdir -p /app/whatsapp_auth /app/server/domain/persona

# Public entry is WEB on 3000 (Dokploy-friendly).
# API is internal-only on 4000.
EXPOSE 3000
VOLUME ["/app/whatsapp_auth"]

ENV PORT=4000 \
    API_PORT=4000 \
    WEB_PORT=3000 \
    WHATSAPP_AUTH_DIR=/app/whatsapp_auth \
    NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./start.sh"]
