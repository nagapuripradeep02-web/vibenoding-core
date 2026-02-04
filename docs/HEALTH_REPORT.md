# Vibe Noding - Health Report

**Generated:** 2025-01-29  
**Workspace:** vibenoding-core (Backend) + vibe-noding-dashboard-28 (Frontend)

---

## Quick Status

| Component | Status | Notes |
|-----------|--------|-------|
| Workflow ID Bridge | ✅ PASS | `src/v3/workflowIdBridge.ts` |
| SSE Endpoint | ✅ PASS | Uses resolver, cache headers OK |
| Sync Endpoint | ✅ PASS | Uses resolver |
| Evaluate Endpoint | ✅ PASS | Uses resolver, cache headers OK |
| Poll Endpoint | ✅ PASS | Uses resolver, cache headers OK |
| CORS Config | ✅ PASS | Authorization header allowed |
| Health Endpoint | ✅ PASS | `/api/v3/node-library/health` |
| ETag Disabled | ✅ PASS | Global `app.set('etag', false)` |

---

## Backend Endpoints (vibenoding-core)

All endpoints are mounted under `/api` via `app.use('/api', v3Routes)`.

### Core Endpoints

| Endpoint | Method | Full Path | File:Line |
|----------|--------|-----------|-----------|
| Health | GET | `/api/v3/node-library/health` | `src/routes/v3.ts:1269` |
| SSE Stream | GET | `/api/stream/workflow-state` | `src/routes/v3.ts:233` |
| Sync | POST | `/api/n8n/sync` | `src/routes/v3.ts:344` |
| Evaluate | GET | `/api/v3/workflows/evaluate` | `src/routes/v3.ts:501` |
| Poll | POST | `/api/v3/workflows/:workflowId/poll` | `src/routes/v3.ts:666` |
| Resolve (dev) | GET | `/api/v3/workflows/resolve` | `src/routes/v3.ts:1284` |

### Query Parameters

| Endpoint | Required Params |
|----------|-----------------|
| SSE Stream | `?connectionId=...&workflowId=...` |
| Evaluate | `?connectionId=...&workflowId=...` |
| Poll | `?connectionId=...` (workflowId in path) |

### Request Body (POST)

**Sync** (`POST /api/n8n/sync`):
```json
{
  "connectionId": "uuid",
  "workflowId": "uuid (Supabase) or string (n8n ID)"
}
```

---

## Workflow ID Resolution

### How it Works

The `resolveN8nWorkflowId` function in `src/v3/workflowIdBridge.ts` handles both:

1. **Supabase UUID** (e.g., `ac7e559a-b538-4399-9f49-23d279054c23`)
   - Queries `workflows` table to get `n8n_workflow_id`
   - Validates user ownership via `projects.user_id`

2. **n8n ID** (e.g., `37`, `C7S1qwmGaMEI3ngP`)
   - Passes through unchanged (non-UUID pattern)

### Endpoints Using Resolver

| Endpoint | Uses Resolver | File:Line |
|----------|--------------|-----------|
| SSE | ✅ Yes | `v3.ts:261` |
| Sync | ✅ Yes | `v3.ts:362` |
| Evaluate | ✅ Yes | `v3.ts:522` |
| Poll | ✅ Yes | `v3.ts:681` |

---

## Headers Configuration

### CORS

**File:** `src/index.ts:45`

```typescript
res.header('Access-Control-Allow-Headers', 
  'Content-Type, Authorization, apikey, x-user-id, X-VIBE-SIGNATURE');
```

✅ `Authorization` header is allowed.

### Cache-Control

**Global:** ETag disabled at `src/index.ts:14`
```typescript
app.set('etag', false);
```

**Evaluate Endpoint:** `v3.ts:632-634`
```typescript
res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
res.setHeader('Pragma', 'no-cache');
res.setHeader('Expires', '0');
```

**Poll Endpoint:** `v3.ts:703-706`
```typescript
res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
res.setHeader('Pragma', 'no-cache');
res.setHeader('Expires', '0');
```

**SSE Endpoint:** `v3.ts:247`
```typescript
res.setHeader('Cache-Control', 'no-cache, no-transform');
```

---

## Frontend Configuration (vibe-noding-dashboard-28)

### API Client

**File:** `src/lib/coreClient.ts`

- Fetches `core_base_url` from Supabase `app_settings` table
- Uses `Authorization: Bearer <jwt>` for authenticated requests
- Caches base URL in memory

### SSE Hook

**File:** `src/hooks/useWorkflowStateSSE.ts`

- Uses `fetch()` with `Authorization` header (not EventSource)
- Falls back to polling if SSE fails
- Implements reconnect logic with max 3 attempts

### Workflow ID Handling

Frontend sends Supabase workflow UUID. Backend resolves to n8n ID.

- `workflowFixApi.ts:evaluateWorkflow()` - Sends Supabase UUID
- `coreClient.ts:triggerWorkflowSync()` - Sends Supabase UUID

---

## Doctor Scripts

### Backend Doctor

**Command:** `npm run doctor`  
**File:** `scripts/doctor.ts`

Checks:
1. Health endpoint responds with 200
2. Lists all discovered endpoints
3. Validates Cache-Control headers
4. Validates CORS allows localhost:8080 + Authorization
5. Tests workflow ID resolution (if env vars set)

**Environment Variables:**
```bash
DOCTOR_BASE_URL=http://localhost:3000      # Optional, defaults to localhost
DOCTOR_WORKFLOW_UUID=your-supabase-uuid    # Optional, for resolution test
DOCTOR_CONNECTION_ID=your-connection-uuid   # Optional, for resolution test
```

### Frontend Doctor

**Command:** `npm run doctor`  
**File:** `scripts/doctor.js`

Checks:
1. Prints API base URL configuration
2. Tests backend health endpoint
3. Validates required env vars (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
4. Checks coreClient.ts configuration

---

## Verification Commands

### 1. Health Check (curl)

```bash
curl -i http://localhost:3000/api/v3/node-library/health
```

Expected:
```
HTTP/1.1 200 OK
{"ok":true,"service":"vibenoding-core","ts":...}
```

### 2. CORS Preflight

```bash
curl -i -X OPTIONS http://localhost:3000/api/v3/node-library/health \
  -H "Origin: http://localhost:8080" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

Expected headers:
```
Access-Control-Allow-Origin: http://localhost:8080
Access-Control-Allow-Headers: Content-Type, Authorization, apikey, x-user-id, X-VIBE-SIGNATURE
```

### 3. Evaluate (with JWT)

```bash
curl -i "http://localhost:3000/api/v3/workflows/evaluate?connectionId=YOUR_CONN&workflowId=YOUR_UUID" \
  -H "Authorization: Bearer YOUR_JWT"
```

Expected headers:
```
Cache-Control: no-store, no-cache, must-revalidate
```

### 4. Workflow Resolution Test

```bash
curl "http://localhost:3000/api/v3/workflows/resolve?connectionId=YOUR_CONN&workflowId=YOUR_UUID"
```

Expected (dev only):
```json
{
  "ok": true,
  "n8nWorkflowId": "37",
  "sourceTable": "workflows"
}
```

### 5. Run Doctor Scripts

**Backend:**
```bash
cd vibenoding-core
npm run doctor
```

**Frontend:**
```bash
cd vibe-noding-dashboard-28
npm run doctor
```

---

## Troubleshooting

### Issue: Backend returns 0 nodes

**Cause:** Workflow ID not resolved properly  
**Fix:** Ensure workflow exists in Supabase `workflows` table with `n8n_workflow_id` set

Check with:
```sql
SELECT id, n8n_workflow_id FROM workflows WHERE id = 'YOUR_UUID';
```

### Issue: 304 Not Modified on evaluate

**Cause:** Browser caching despite headers  
**Fix:** 
1. Verify `app.set('etag', false)` in `src/index.ts`
2. Frontend should use `cache: 'no-store'` in fetch options

### Issue: CORS blocking Authorization header

**Cause:** Header not in `Access-Control-Allow-Headers`  
**Fix:** Verify `src/index.ts:45` includes `Authorization`

### Issue: SSE not receiving updates

**Cause:** Workflow ID mismatch between SSE key and poll updates  
**Fix:** Both must use the same resolved n8n workflow ID (not Supabase UUID)

---

## File Reference

### Backend (vibenoding-core)

| File | Purpose |
|------|---------|
| `src/index.ts` | Express app, CORS, etag config |
| `src/routes/v3.ts` | All v3 API endpoints |
| `src/v3/workflowIdBridge.ts` | UUID → n8n ID resolver |
| `src/v3/executionPoller.ts` | Background execution polling |
| `src/v3/workflowState.ts` | Build workflow state from n8n data |
| `src/v3/validators.ts` | Node validation (credentials, placeholders) |
| `src/v3/decorate.ts` | Decorate state for UI |
| `scripts/doctor.ts` | Health check script |

### Frontend (vibe-noding-dashboard-28)

| File | Purpose |
|------|---------|
| `src/lib/coreClient.ts` | API client, auth headers |
| `src/lib/workflowFixApi.ts` | Workflow fix API calls |
| `src/hooks/useWorkflowStateSSE.ts` | SSE/poll hook |
| `src/lib/pollRegistry.ts` | Poll state management |
| `src/lib/sseRegistry.ts` | SSE connection tracking |
| `scripts/doctor.js` | Health check script |

---

## Changelog

### 2025-01-29

- ✅ Verified all endpoints use workflow ID resolver
- ✅ Verified CORS includes Authorization header
- ✅ Verified Cache-Control headers on dynamic endpoints
- ✅ Added doctor scripts to both repos
- ✅ Created this health report
