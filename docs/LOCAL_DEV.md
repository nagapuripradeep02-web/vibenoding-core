# Local Development Setup (Windows)

## 1. Create `.env`

```powershell
Copy-Item .env.example .env
```

Edit `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Settings → API → URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API → **service_role** (secret, bottom row) |
| `OPENAI_API_KEY` | OpenAI Dashboard → API Keys |

> ⚠️ **Common mistake:** pasting the **anon** key instead of the **service_role** key.
> The service_role key bypasses RLS and is required for `sandbox/ensure` INSERT operations.
> The server now logs `role=anon` vs `role=service_role` at startup — check the console.

## 2. Start the server

```powershell
npm run dev
```

You should see in the console:
```
[supabase] configured=true role=service_role runtime=prod
Server is running on port 3000
```

If you see `role=anon`, you have the wrong key.

## 3. Verify health

```powershell
curl http://127.0.0.1:3000/api/v3/node-library/health
```

Expected:
```json
{
  "ok": true,
  "service": "vibenoding-core",
  "supabase_configured": true,
  "supabase_role": "service_role"
}
```

## 4. Test sandbox/ensure

```powershell
curl -X POST http://127.0.0.1:3000/api/v3/workflows/<WORKFLOW_UUID>/sandbox/ensure `
  -H "Content-Type: application/json" `
  -d '{"connectionId":"<CONNECTION_ID>"}'
```

Expected: `ok: true` with a `testWorkflow` object.

## 5. Test apply-step (dry run)

```powershell
curl -X POST http://127.0.0.1:3000/api/v3/assist/apply-step `
  -H "Content-Type: application/json" `
  -d '{"connectionId":"<CID>","workflowUuid":"<UUID>","planId":"<PID>","stepId":"<SID>","dry_run":true}'
```

Expected: `ok: true` with a `patch` object.
