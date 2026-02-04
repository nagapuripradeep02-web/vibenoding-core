# Doctor Scripts

Quick health check commands for Vibe Noding.

---

## Backend (vibenoding-core)

```bash
cd vibenoding-core
npm run doctor
```

**Checks:**
- GET `http://127.0.0.1:3000/api/v3/node-library/health` returns 200 + `{ ok: true }`
- CORS allows `http://localhost:8080` origin and `Authorization` header

**Optional - Test Workflow Resolution:**
```bash
DOCTOR_WORKFLOW_UUID=your-supabase-uuid \
DOCTOR_CONNECTION_ID=your-connection-uuid \
npm run doctor
```

This additionally tests:
- Resolve endpoint (`/api/v3/workflows/resolve`)
- Evaluate endpoint with cache headers
- Poll endpoint with cache headers

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

## Quick Test (Both)

From workspace root:
```bash
# Backend
(cd vibenoding-core && npm run doctor)

# Frontend
(cd vibe-noding-dashboard-28 && npm run doctor)
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
