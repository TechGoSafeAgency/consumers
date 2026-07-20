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

# Winston file transports need a writable directory (official image provides `node`)
RUN mkdir -p logs && chown -R node:node /app

USER node

# Long-running RabbitMQ consumer (no HTTP server)
CMD ["node", "dist/consumers/get-driver-verisk-queue.consumer.js"]
