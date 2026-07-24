# Go Safe Consumers

Long-running workers that process RabbitMQ messages for the Go Safe Agency platform.

Deploy **each consumer as its own service** (separate start command / Railway service). The default Docker `CMD` starts the Verisk consumer; override it for Salesforce.

---

## Consumers

### 1. get-driver-verisk

Consumes `get-driver-verisk-queue`, calls Verisk for an MVR PDF, updates MongoDB, then publishes `{ id, base64PDF }` to `sync-salesforce-mvr-case-pdf-queue`.

| Item | Value |
| --- | --- |
| Source | `src/consumers/get-driver-verisk-queue.consumer.ts` |
| Start command | `pnpm consumer:get-driver-verisk` |
| Entrypoint | `node dist/consumers/get-driver-verisk-queue.consumer.js` |
| Queue (in) | `get-driver-verisk-queue` |
| Queue (out) | `sync-salesforce-mvr-case-pdf-queue` |

### 2. sync-salesforce-mvr-case

Consumes `sync-salesforce-mvr-case-pdf-queue`, syncs the PDF to Salesforce (EmailMessage → Attachment → emailSimple), optionally patches Case approval when sibling drivers are ready, then marks the MVR `SALESFORCE-PDF-SYNCED`.

| Item | Value |
| --- | --- |
| Source | `src/consumers/sync-salesforce-mvr-case-queue.consumer.ts` |
| Start command | `pnpm consumer:sync-salesforce-mvr-case` |
| Entrypoint | `node dist/consumers/sync-salesforce-mvr-case-queue.consumer.js` |
| Queue (in) | `sync-salesforce-mvr-case-pdf-queue` |

---

## Prerequisites

- Node.js `>= 18.18`
- [pnpm](https://pnpm.io/) `>= 9`
- Access to MongoDB, RabbitMQ, and (per consumer) Verisk and/or Salesforce + Redis

---

## Environment variables

### Shared

| Variable | Description |
| --- | --- |
| `MONGO_DB_URI` | MongoDB connection string |
| `RABBITMQ_URI` | AMQP connection string |
| `NODE_ENV` | Use `production` in deployed environments |

### Verisk consumer

| Variable | Description |
| --- | --- |
| `WSDL_URL` | Verisk WSDL URL |
| `SOAP_FORCE_IPV4` | `true` recommended (also applies to WSDL prefetch) |
| `SOAP_HTTP_TIMEOUT_MS` | Default `120000` |
| `WSDL_PREFETCH` | `true` to download WSDL before SOAP client init |
| `WSDL_DISABLE_CACHE` | `true` to avoid stale WSDL cache |
| `WSDL_LOCAL_PATH` | Optional vendored `.wsdl` path |

Verisk account credentials are loaded from MongoDB (active credential), not env vars.

### Salesforce consumer

| Variable | Description |
| --- | --- |
| `SALESFORCE_BASE_URL` | Salesforce instance URL |
| `SF_API_VERSION` | e.g. `v53.0` |
| `REDIS_URI` | Redis URL for Salesforce token cache |
| `AUTH_API_URL` | Internal auth service base URL |
| `AUTH_APP_KEY` | Auth header `x-auth-app` |
| `APP_AUTH_ID` | Auth header `x-salesforce-auth-id` |
| `APP_AUTH_SECRET` | Auth header `x-salesforce-auth-secret` |
| `APPLICATION` | Used on auth POST fallback (default `SERVERLESS-SYNC-MVR-CASES`) |
| `EMAIL_NOTIFICATIONS_TO` | Finance / ops recipient |
| `EMAIL_STATUS` | Salesforce EmailMessage status (default `3`) |
| `EMAIL_SIMPLE_SENDER_TYPE` | e.g. `CurrentUser` or `OrgWideEmailAddress` |
| `EMAIL_SIMPLE_SENDER_ADDRESS` | Required when sender type is `OrgWideEmailAddress` |
| `EMAIL_SIMPLE_LOG_ON_SEND` | Default true; set `false` / `0` to disable |

### Verisk / Imperva access

Verisk sits behind **Imperva (Incapsula)**. A `403` with `_Incapsula_Resource` is a WAF bot challenge.

1. Use a **static outbound IPv4** for the Verisk Railway service.
2. Allowlist that IP in Imperva with **bot-challenge bypass**.
3. Confirm the logged `Public egress IP for Verisk/Imperva allowlisting` matches the allowlist.

---

## Local run

```bash
pnpm install
pnpm build

# Terminal 1 — Verisk
pnpm consumer:get-driver-verisk

# Terminal 2 — Salesforce
pnpm consumer:sync-salesforce-mvr-case
```

---

## Deploy (platform-agnostic)

1. Build (`pnpm build`)
2. Set env vars for that consumer
3. Start the matching process
4. Keep one replica per consumer (`prefetch(1)`)

### Docker

Default image starts the **Verisk** consumer:

```bash
docker build -t go-safe-consumer:latest .
docker run --rm \
  -e MONGO_DB_URI=... \
  -e RABBITMQ_URI=... \
  -e WSDL_URL=... \
  -e NODE_ENV=production \
  -e SOAP_FORCE_IPV4=true \
  -e WSDL_PREFETCH=true \
  go-safe-consumer:latest
```

For Salesforce, override the command:

```bash
docker run --rm \
  -e MONGO_DB_URI=... \
  -e RABBITMQ_URI=... \
  -e SALESFORCE_BASE_URL=... \
  -e REDIS_URI=... \
  -e AUTH_API_URL=... \
  -e AUTH_APP_KEY=... \
  -e APP_AUTH_ID=... \
  -e APP_AUTH_SECRET=... \
  -e EMAIL_NOTIFICATIONS_TO=... \
  -e EMAIL_SIMPLE_SENDER_TYPE=... \
  -e EMAIL_SIMPLE_SENDER_ADDRESS=... \
  -e NODE_ENV=production \
  go-safe-consumer:latest \
  node dist/consumers/sync-salesforce-mvr-case-queue.consumer.js
```

---

## Deploy on Railway

Create **two services** from the same repo/image.

### Service A — Verisk

- Start command: `pnpm consumer:get-driver-verisk`
- Vars: `MONGO_DB_URI`, `RABBITMQ_URI`, `WSDL_URL`, SOAP/WSDL settings
- Prefer private networking for RabbitMQ

### Service B — Salesforce

- Start command: `pnpm consumer:sync-salesforce-mvr-case`
- Vars: Mongo, RabbitMQ, Salesforce, Redis, auth, email settings
- If using the Dockerfile, set the same start command so it does not use the Verisk default `CMD`

Build command (if needed):

```bash
pnpm install --frozen-lockfile && pnpm build
```

### Verify

**Verisk logs:** Mongo connected, waiting on `get-driver-verisk-queue`, then `COMPLETED-VERISK-SYNC` / outbound publish.

**Salesforce logs:** Redis + Mongo connected, waiting on `sync-salesforce-mvr-case-pdf-queue`, then EmailMessage / Attachment / emailSimple success and `SALESFORCE-PDF-SYNCED`.

Failed messages are not requeued in this milestone (manual recovery).

---

## Message shapes

### get-driver-verisk-queue (in)

Full MVR case JSON (driver license, DOB, payment fields, `id`, etc.).

Cases with `caseMVRPaymentStatus === "Paid By Insured"` and `caseConfirmedPayment === false` are skipped.

### sync-salesforce-mvr-case-pdf-queue (in)

```json
{ "id": "<mvr-case-id>", "base64PDF": "<base64>" }
```

Sibling Case approval is deferred (not failed) until every driver on the Case has Verisk PDF + `requestIdVerisk`.
