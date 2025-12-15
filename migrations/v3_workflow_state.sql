-- V3.0 Workflow State Engine Tables
-- Run this migration in Supabase SQL Editor

-- execution_events: stores incoming execution events from n8n
CREATE TABLE execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES n8n_connections(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_exec_events_lookup ON execution_events(connection_id, workflow_id, created_at DESC);

-- workflow_node_state: per-node configuration and verification status
CREATE TABLE workflow_node_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES n8n_connections(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  node_type TEXT NOT NULL,
  configured_credentials BOOLEAN DEFAULT FALSE,
  configured_placeholders BOOLEAN DEFAULT FALSE,
  configured_required_fields BOOLEAN DEFAULT FALSE,
  verified BOOLEAN DEFAULT FALSE,
  failed BOOLEAN DEFAULT FALSE,
  last_execution_id TEXT,
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, workflow_id, node_id)
);

CREATE INDEX idx_node_state_lookup ON workflow_node_state(connection_id, workflow_id);

-- node_notes: optional user notes per node
CREATE TABLE node_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES n8n_connections(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_note TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, workflow_id, node_id)
);

-- Enable RLS
ALTER TABLE execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_node_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_notes ENABLE ROW LEVEL SECURITY;

-- RLS policies (service role bypasses, but good practice)
CREATE POLICY "Users can access own execution_events" ON execution_events
  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can access own workflow_node_state" ON workflow_node_state
  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can access own node_notes" ON node_notes
  FOR ALL USING (auth.uid() = user_id);

