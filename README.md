# vibenoding-core

A Node.js + TypeScript API project using Express.

## Installation

```bash
npm install
```

## Development

Run the development server with hot reload:

```bash
npm run dev
```

## Build

Build the TypeScript project:

```bash
npm run build
```

## Start

Start the production server:

```bash
npm start
```

## API Endpoints

### Health Check

- **GET** `/health` or `/api/v1/health`
- Returns: `{ status: "ok" }`

### n8n Workflows

#### List all workflows

- **GET** `/api/n8n/workflows`
- Returns: `{ workflows: [...] }`

```bash
curl http://localhost:3000/api/n8n/workflows
```

#### Fetch single workflow

- **GET** `/api/n8n/workflows/:workflowId`
- Returns: `{ workflow: {...} }`
- Errors:
  - `400` if workflowId is missing
  - `404` if workflow not found
  - `500` on server error

```bash
curl http://localhost:3000/api/n8n/workflows/1
```

### n8n Connections (per-user, via Supabase)

- **GET** `/api/v1/n8n/connections` - List user's connections
- **POST** `/api/v1/n8n/connections` - Create connection
- **PATCH** `/api/v1/n8n/connections/:id` - Update connection
- **GET** `/api/v1/n8n/connections/:id/workflows` - Get workflows from user's n8n instance

All connection routes require `x-user-id` header.

## V3.0 Workflow State Engine

Real-time workflow state tracking with per-node configuration and verification status.

### Environment Variables

Add to your `.env` file:

```bash
# V3.0 - Shared secret for validating incoming execution events from n8n
# Generate with: openssl rand -hex 32
VIBE_EXEC_EVENTS_SECRET=your-secure-secret-here
```

### V3.0 API Endpoints

#### Get Workflow State (one-time)

- **GET** `/api/n8n/workflow-state?connectionId=...&workflowId=...`
- Returns per-node configuration and verification status

#### Stream Workflow State (SSE)

- **GET** `/api/stream/workflow-state?connectionId=...&workflowId=...`
- Real-time Server-Sent Events stream
- Pushes updates when execution events are received

#### Receive Execution Events

- **POST** `/api/n8n/execution-events`
- Requires `X-VIBE-SIGNATURE` header matching `VIBE_EXEC_EVENTS_SECRET`
- Body: `{ connectionId, workflowId, executionId, status: "success"|"error", meta? }`

#### Sync Workflow State

- **POST** `/api/n8n/sync`
- Body: `{ connectionId, workflowId }`
- Requires `x-user-id` header
- Manually triggers state recomputation

### Setting Up n8n Integration

#### Success Reporter Node

Add an HTTP Request node at the end of your n8n workflow:

```
Method: POST
URL: https://your-backend.com/api/n8n/execution-events
Headers:
  X-VIBE-SIGNATURE: your-secret-from-env
Body (JSON):
{
  "connectionId": "{{ $env.VIBE_CONNECTION_ID }}",
  "workflowId": "{{ $workflow.id }}",
  "executionId": "{{ $execution.id }}",
  "status": "success"
}
```

#### Error Workflow

Create a separate n8n workflow with an Error Trigger:

1. Add "Error Trigger" node
2. Add HTTP Request node:
   - URL: `https://your-backend.com/api/n8n/execution-events`
   - Header: `X-VIBE-SIGNATURE: your-secret`
   - Body: `{ connectionId, workflowId, executionId, status: "error", meta: { error: "{{ $json.error.message }}" } }`
3. Set this as the Error Workflow in your main workflow settings

### Database Migration

Run the SQL migration in Supabase:

```bash
# File: migrations/v3_workflow_state.sql
```

Creates tables:
- `execution_events` - Stores incoming execution events
- `workflow_node_state` - Per-node configuration and verification status
- `node_notes` - Optional user notes per node

## V3.2 Canonical Schemas (TypeVersion-aware)

### Database Migration

Run the SQL migration in Supabase:

```bash
# File: migrations/v3_2_canonical_schemas.sql
```

Creates table:
- `node_library_canonical_schemas` - Version-aware canonical node schemas with unique constraint on (node_type, type_version, package_version)

### Testing Locally

#### 1. Import Canonical Catalog

```bash
curl -X POST "http://localhost:3000/api/v3/node-library/import-canonical"
```

Expected response includes `canonicalSchemasInserted > 0`.

Verify in Supabase:
```sql
SELECT COUNT(*) FROM node_library_canonical_schemas;
-- Should return > 0
```

#### 2. Test Resolve Schema Endpoint

```bash
curl "http://localhost:3000/api/v3/node-library/resolve-schema?connectionId=YOUR_CONNECTION_ID&nodeType=n8n-nodes-base.httpRequest&typeVersion=0&packageVersion="
```

Expected response:
- `source`: `'canonical'` (or `'canonical_legacy'` if legacy fallback used)
- `config_schema`: non-null JSON object

#### 3. Backfill Legacy Data (Optional)

**Via Script:**
```bash
ENABLE_NODE_LIBRARY_BACKFILL=1 ADMIN_SECRET=your-secret ts-node scripts/backfill-canonical-schemas.ts
```

**Via Endpoint:**
```bash
ENABLE_NODE_LIBRARY_BACKFILL=1 ADMIN_SECRET=your-secret curl -X POST \
  -H "x-admin-secret: your-secret" \
  "http://localhost:3000/api/v3/node-library/admin/backfill-canonical-schemas"
```

**Note:** Backfill requires both:
- `ENABLE_NODE_LIBRARY_BACKFILL=1` env var
- `x-admin-secret` header matching `ADMIN_SECRET` env var
- Returns 404 if guard fails (to avoid discovery)

#### 4. Debug Logging

Enable debug logs:
```bash
NODE_LIBRARY_DEBUG=1 npm run dev
```

This will log:
- Schema resolution steps
- Import/backfill operations
- Fallback to legacy table

