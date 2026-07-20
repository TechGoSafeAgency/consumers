# Go Safe Consumers

Long-running workers that process RabbitMQ messages for the Go Safe Agency platform.

## get-driver-verisk consumer

Consumes messages from the `get-driver-verisk-queue` queue, calls Verisk for an MVR PDF, and updates the matching MVR case in MongoDB.

| Item | Value |
| --- | --- |
| Source | `src/consumers/get-driver-verisk-queue.consumer.ts` |
| Start command (after build) | `pnpm consumer:get-driver-verisk` |
| Compiled entrypoint | `node dist/consumers/get-driver-verisk-queue.consumer.js` |
| Queue | `get-driver-verisk-queue` |

---

## Prerequisites

- Node.js `>= 18.18`
- [pnpm](https://pnpm.io/) `>= 9`
- Access to:
  - MongoDB (MVR cases + Verisk credentials collections)
  - RabbitMQ (`get-driver-verisk-queue`)
  - Verisk WSDL / SOAP endpoint

---

## Environment variables

Set these in your host (Railway Variables, Docker `-e`, systemd, etc.).

### Required

| Variable | Description |
| --- | --- |
| `MONGO_DB_URI` | MongoDB connection string |
| `RABBITMQ_URI` | AMQP connection string |
| `WSDL_URL` | Verisk WSDL URL (e.g. `https://expressnet.iix.com/web-services/Auth?WSDL`) |

### Recommended

| Variable | Default / notes |
| --- | --- |
| `NODE_ENV` | Use `production` in deployed environments |
| `SOAP_FORCE_IPV4` | `true` if IPv6 routes to Verisk fail |
| `SOAP_HTTP_TIMEOUT_MS` | `120000` |
| `WSDL_PREFETCH` | `true` to download WSDL before SOAP client init |
| `WSDL_DISABLE_CACHE` | `true` to avoid stale WSDL cache |

Verisk account credentials are **not** taken from env vars. The consumer loads the active credential from MongoDB at startup.

---

## Local run

```bash
pnpm install
pnpm build
pnpm consumer:get-driver-verisk
```

Load env vars from your platform or a local `.env` / `.env.local` file before starting.

You should see logs indicating MongoDB is connected and the worker is waiting on `get-driver-verisk-queue`.

---

## Deploy (platform-agnostic)

Any host that can build this repo and keep a long-running process works. The pattern is always the same:

1. **Build** the TypeScript project  
2. **Set** the environment variables above  
3. **Start** the consumer process (not an HTTP server)  
4. **Keep it running** (one replica is enough for `prefetch(1)`)

### Start command

Use one of:

```bash
pnpm consumer:get-driver-verisk
```

or:

```bash
node dist/consumers/get-driver-verisk-queue.consumer.js
```

> Important: this is a **queue worker**, not a web API. Do not rely on an HTTP health endpoint for this process unless you add one later.

### Docker (optional)

The included `Dockerfile` builds the project and starts the Verisk consumer by default:

```bash
docker build -t go-safe-consumer:latest .
docker run --rm \
  -e MONGO_DB_URI=... \
  -e RABBITMQ_URI=... \
  -e WSDL_URL=... \
  -e NODE_ENV=production \
  -e SOAP_FORCE_IPV4=true \
  -e WSDL_PREFETCH=true \
  -e WSDL_DISABLE_CACHE=true \
  go-safe-consumer:latest
```

---

## Deploy on Railway

Same steps as above, mapped to Railway’s UI/CLI.

### 1. Create a service

- New service from this GitHub repo (or deploy from Dockerfile).
- Use a **dedicated service** for this consumer so it can scale and restart independently.

### 2. Configure variables

In **Variables**, add at least:

- `MONGO_DB_URI`
- `RABBITMQ_URI` (use the private/internal AMQP URL when RabbitMQ is on the same Railway project)
- `WSDL_URL`
- `NODE_ENV=production`
- `SOAP_FORCE_IPV4=true`
- `WSDL_PREFETCH=true`
- `WSDL_DISABLE_CACHE=true`

### 3. Set the start command

In **Settings → Deploy**:

- **Custom Start Command:**

```bash
pnpm consumer:get-driver-verisk
```

If the build already produces `dist/` and you prefer invoking Node directly:

```bash
node dist/consumers/get-driver-verisk-queue.consumer.js
```

If Railway builds with Nixpacks and does not run `pnpm build` automatically, set a **build command** of:

```bash
pnpm install --frozen-lockfile && pnpm build
```

### 4. Networking notes

- The worker only needs outbound access to MongoDB, RabbitMQ, and Verisk.
- No public HTTP port is required for this consumer.
- Prefer Railway **private networking** for `RABBITMQ_URI` when possible.

### 5. Verify

1. Deploy and open service logs.
2. Confirm lines similar to:
   - MongoDB connected / DAL ready
   - Waiting for messages on `get-driver-verisk-queue`
3. Publish a test message to the queue and confirm the MVR case updates in MongoDB (`COMPLETED-VERISK-SYNC` or `FAILED-VERISK-SYNC`).

### 6. Operations (first milestone)

- Keep **one running instance** unless you intentionally redesign concurrency.
- If Verisk or the worker fails for a message, recovery is **manual** for this milestone (failed messages are not requeued).

---

## Message shape (queue)

Messages are JSON documents shaped like an MVR case. Required processing fields include driver license state/number, name, DOB, payment fields, and `id`.

Cases with `caseMVRPaymentStatus === "Paid By Insured"` and `caseConfirmedPayment === false` are skipped (acked without calling Verisk).
