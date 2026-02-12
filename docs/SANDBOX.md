# Sandbox Engine

The Sandbox Engine enables safe testing of n8n workflows without modifying production workflows.

## Overview

The system creates a "shadow" copy of your production workflow with:
- A test webhook trigger (`[VN TEST]` prefix)
- All original triggers disabled
- An unguessable webhook URL for secure invocation

This allows you to test workflow execution with custom fixtures without affecting the production workflow.

## Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   Production      |     |   Test Workflow   |     |    Fixtures       |
|   Workflow        | --> |   [VN TEST] ...   | <-- |    (JSON)         |
|   (unchanged)     |     |   + Webhook       |     |                   |
+-------------------+     +-------------------+     +-------------------+
                                   |
                                   v
                          +-------------------+
                          |   Test Runs       |
                          |   (history)       |
                          +-------------------+
```

## API Endpoints

### POST `/api/v3/workflows/:workflowUuid/sandbox/ensure`

Creates or returns the test workflow for a production workflow.

**Request:**
```json
{
  "connectionId": "uuid-of-n8n-connection"
}
```

**Response:**
```json
{
  "ok": true,
  "created": true,
  "testWorkflow": {
    "id": "uuid",
    "testN8nWorkflowId": "123",
    "webhookUrl": "https://n8n.example.com/webhook/vn-test/...",
    "webhookSecret": "hex-secret-for-auth",
    "createdAt": "2025-01-29T..."
  }
}
```

### GET `/api/v3/workflows/:workflowUuid/fixtures?connectionId=...`

Lists all fixtures for a workflow.

**Response:**
```json
{
  "ok": true,
  "fixtures": [
    {
      "id": "uuid",
      "name": "Test Case 1",
      "payload": { ... },
      "headers": { ... },
      "created_at": "2025-01-29T..."
    }
  ]
}
```

### POST `/api/v3/workflows/:workflowUuid/fixtures`

Creates a new test fixture.

**Request:**
```json
{
  "connectionId": "uuid",
  "name": "My Test Case",
  "payload": { "email": "test@example.com" },
  "headers": { "X-Custom-Header": "value" }
}
```

### POST `/api/v3/workflows/:workflowUuid/sandbox/run`

Executes a test run using a fixture.

**Request:**
```json
{
  "connectionId": "uuid",
  "fixtureId": "uuid-of-fixture"
}
```

**Response:**
```json
{
  "ok": true,
  "testRun": {
    "id": "uuid",
    "status": "success",
    "latency_ms": 1234,
    "response_json": { ... },
    "created_at": "2025-01-29T..."
  },
  "response": { ... }
}
```

## Local Testing

### Prerequisites

1. n8n instance running with API access
2. n8n connection configured in Supabase
3. A production workflow to test

### Steps

1. **Start the backend:**
   ```bash
   cd vibenoding-core
   npm run dev
   ```

2. **Set environment variables:**
   ```bash
   export DOCTOR_WORKFLOW_UUID="your-workflow-uuid"
   export DOCTOR_CONNECTION_ID="your-connection-uuid"
   ```

3. **Run doctor script to test:**
   ```bash
   npm run doctor
   ```

### Manual Testing with curl

```bash
# 1. Ensure test workflow exists
curl -X POST http://localhost:3000/api/v3/workflows/{WORKFLOW_UUID}/sandbox/ensure \
  -H "Content-Type: application/json" \
  -d '{"connectionId": "YOUR_CONNECTION_ID"}'

# 2. Create a fixture
curl -X POST http://localhost:3000/api/v3/workflows/{WORKFLOW_UUID}/fixtures \
  -H "Content-Type: application/json" \
  -d '{
    "connectionId": "YOUR_CONNECTION_ID",
    "name": "Test Fixture",
    "payload": {"test": true},
    "headers": {}
  }'

# 3. List fixtures
curl http://localhost:3000/api/v3/workflows/{WORKFLOW_UUID}/fixtures?connectionId={CONNECTION_ID}

# 4. Run a test
curl -X POST http://localhost:3000/api/v3/workflows/{WORKFLOW_UUID}/sandbox/run \
  -H "Content-Type: application/json" \
  -d '{
    "connectionId": "YOUR_CONNECTION_ID",
    "fixtureId": "FIXTURE_ID_FROM_STEP_2"
  }'
```

## Safety Guarantees

1. **Production Isolation**: Test workflows are entirely separate n8n workflows. The original is never modified.

2. **Clear Labeling**: Test workflow names are prefixed with `[VN TEST]` for easy identification.

3. **Random Paths**: Webhook URLs use cryptographically random paths that cannot be guessed.

4. **Header Authentication**: Webhooks require a secret header (`X-VN-Test-Secret`) to prevent unauthorized invocation.

5. **Disabled Triggers**: All original triggers (schedules, email, etc.) are disabled in the test workflow.

6. **Transactional Operations**: If workflow creation fails, no partial data is stored.

7. **User Scoped**: RLS policies ensure users can only access their own test workflows and fixtures.

## Database Tables

### vn_test_workflows
Maps production workflows to their test clones.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | Owner |
| connection_id | UUID | n8n connection |
| prod_workflow_uuid | UUID | Production workflow reference |
| test_n8n_workflow_id | TEXT | Created test workflow ID in n8n |
| test_webhook_path_secret | TEXT | Random webhook path |
| webhook_auth_secret | TEXT | Header auth secret |

### vn_fixtures
Test input data.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | Owner |
| connection_id | UUID | n8n connection |
| workflow_uuid | UUID | Workflow reference |
| name | TEXT | Fixture name |
| payload | JSONB | Request body |
| headers | JSONB | Custom headers |

### vn_test_runs
Test execution history.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | Owner |
| workflow_uuid | UUID | Workflow reference |
| fixture_id | UUID | Fixture used |
| status | TEXT | success/error/timeout |
| response_json | JSONB | Response data |
| latency_ms | INTEGER | Execution time |

## Cleanup

To remove a test workflow:

1. Delete from n8n (manually or via API)
2. Delete the `vn_test_workflows` row
3. Associated `vn_test_runs` will cascade delete

## Troubleshooting

### Webhook returns 404
The test workflow may not be active. Check n8n dashboard to ensure the `[VN TEST]` workflow is active.

### Authentication error
Ensure the `X-VN-Test-Secret` header matches the stored `webhook_auth_secret`.

### Test workflow not created
Check that:
- The production workflow exists
- The n8n connection has valid API credentials
- The user has access to the connection

---

## Sandbox Reset

When a VN TEST workflow accumulates junk nodes from repeated apply-step testing, you can reset it to a clean state.

### POST `/api/v3/workflows/:workflowUuid/sandbox/reset`

**Request:**
```json
{
  "confirm": "RESET_VN_TEST",
  "connectionId": "uuid-of-n8n-connection"
}
```

**Query params:**
- `?recreate=1` — After deletion, automatically recreate a fresh test workflow

**Response (without recreate):**
```json
{ "ok": true, "deleted": "old-n8n-id", "message": "Reset complete. Call /sandbox/ensure to recreate." }
```

**Response (with `?recreate=1`):**
```json
{ "ok": true, "deleted": "old-n8n-id", "recreated": true, "test_workflow_id": "new-n8n-id", "webhook_url": "https://..." }
```

### Safety Guards

1. **Confirm token required** — Body must include `{ confirm: "RESET_VN_TEST" }`. Without it, the endpoint returns 400.
2. **Prod protection** — Refuses with 403 if `test_n8n_workflow_id === prod_n8n_workflow_id`.
3. **Auth** — Uses the same connection-based auth as sandbox/ensure.
4. **Cooldown** — Returns 429 if called again within 10 seconds (same connectionId + workflowUuid).
5. **Logs sanitized** — Webhook URLs and secrets are never logged.

### When to Use

- After many apply-step iterations leave junk nodes in the test workflow
- When the test webhook stops responding (404) and `sandbox/ensure` can't self-heal
- Before running doctor:integration to get a clean baseline

### curl Example

```bash
# Reset and recreate in one call
curl -X POST "http://localhost:3000/api/v3/workflows/{UUID}/sandbox/reset?recreate=1" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET_VN_TEST","connectionId":"YOUR_CONNECTION_ID"}'
```
