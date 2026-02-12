# Doctor Scripts

Quick health check commands for Vibe Noding.

---

## Backend (vibenoding-core)

### Unit mode (default)

```bash
npm run doctor
```

Runs fast, local-only checks:
- `GET /health` returns 200 + `{ ok: true }`
- CORS allows localhost origin and `Authorization` header

### Integration mode

```bash
npm run doctor:integration
```

Or with env vars:

```bash
DOCTOR_INTEGRATION=1 \
DOCTOR_WORKFLOW_UUID=your-supabase-uuid \
DOCTOR_CONNECTION_ID=your-connection-uuid \
npm run doctor
```

Runs everything from unit mode **plus**:
- Workflow resolution (`/api/v3/workflows/resolve`)
- Sandbox engine (ensure, status, webhook run ×2)
- Assist Ask, Plan, Apply-Step endpoints

**Requires:**
- `DOCTOR_WORKFLOW_UUID` — Supabase UUID of a test workflow
- `DOCTOR_CONNECTION_ID` — Supabase UUID of an n8n connection
- `OPENAI_API_KEY` — for Assist Ask/Plan/Apply-Step tests (optional, skipped if missing)

**Network safety:**
Integration tests wrap all n8n calls in try/catch. If the external n8n instance is unreachable, the script prints `[CRASH]` with a clean error message and exits with code 1 instead of crashing from libuv.

---

## Frontend (vibe-noding-dashboard-28)

```bash
cd vibe-noding-dashboard-28
npm run doctor
```

**Checks:**
- Fetches backend `/api/v3/node-library/health`
- Prints HTTP status + first 300 chars of response body
- Exits 1 if non-200 or fetch fails

**Custom API URL:**
```bash
# In .env file:
VITE_API_BASE_URL=http://localhost:3000
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed |
| 1 | One or more checks failed |

---

## Files

| Repo | File |
|------|------|
| Backend | `scripts/doctor.ts` |
| Frontend | `scripts/doctor.mjs` |

---

## CI Integration

The `.github/workflows/ci.yml` runs two jobs:

| Job | Trigger | What it does |
|-----|---------|-------------|
| `check` | Every push/PR | `npm run typecheck` + `npm run doctor` (unit) |
| `doctor-integration` | `workflow_dispatch` / weekly schedule | `npm run doctor:integration` (requires secrets) |

### Required GitHub Secrets (integration job)

| Secret | Description |
|--------|-------------|
| `DOCTOR_CONNECTION_ID` | n8n connection UUID |
| `DOCTOR_WORKFLOW_UUID` | Workflow UUID to test |
| `OPENAI_API_KEY` | LLM key for assist endpoints |
| `VN_ADMIN_TOKEN` | *(Optional)* Admin token for idempotency DB verification |

If any required secret is missing, the integration job **skips cleanly** (does not fail).

---

## Idempotency Lookup Endpoint

```
GET /api/v3/assist/apply-step/idempotency/:key
```

**Auth:** Requires `X-VN-Admin-Token` header matching `VN_ADMIN_TOKEN` env var.

**Response:**
```json
{ "ok": true, "count": 1, "latest": { "id": "...", "status": "applied", "created_at": "...", "workflow_uuid": "...", "plan_id": "...", "step_id": "..." } }
```

Read-only. Never returns `patch_json` or `rollback_json`.

---

## Environment Variables

| Var | Required | Description |
|-----|----------|-------------|
| `DOCTOR_WORKFLOW_UUID` | Integration | Workflow UUID |
| `DOCTOR_CONNECTION_ID` | Integration | n8n connection UUID |
| `OPENAI_API_KEY` | Integration | LLM key |
| `VN_ADMIN_TOKEN` | Optional | Admin token for idempotency endpoint |
