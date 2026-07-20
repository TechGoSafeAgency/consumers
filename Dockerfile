# syntax=docker/dockerfile:1

# Node LTS — matches package.json engines (>=18.18)
ARG NODE_VERSION=20

# --- Install dependencies (cached layer) ---
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- Build TypeScript ---
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# --- Production image ---
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
# Skip lifecycle scripts: `prepare` runs `husky`, which is not installed with `--prod`
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=builder /app/dist ./dist
# Migrations (run `pnpm run migrate:mongo:up` before or at container start if you bundle migrate-mongo in prod)
COPY database ./database

# Winston file transports need a writable directory (official image provides `node`)
RUN mkdir -p logs && chown -R node:node /app

USER node

EXPOSE 3000

ENV PORT=3000

# Uses PORT (default 3000) for the health probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health-check',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/app.js"]
