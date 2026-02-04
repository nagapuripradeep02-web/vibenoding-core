-- V3.3 Sandbox Engine Tables
-- Run this migration in Supabase SQL Editor
-- Enables VN TEST shadow workflow system for safe testing

-- vn_test_workflows: Maps production workflows to test clones
CREATE TABLE vn_test_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES n8n_connections(id) ON DELETE CASCADE,
  prod_workflow_uuid UUID NOT NULL,
  test_n8n_workflow_id TEXT NOT NULL,
  test_webhook_path_secret TEXT NOT NULL,
  webhook_auth_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, connection_id, prod_workflow_uuid)
);

-- Indexes for common lookups
CREATE INDEX idx_vn_test_workflows_lookup ON vn_test_workflows(user_id, connection_id, prod_workflow_uuid);
CREATE INDEX idx_vn_test_workflows_connection ON vn_test_workflows(connection_id, prod_workflow_uuid);

-- vn_fixtures: Test input data (fixtures) for workflows
CREATE TABLE vn_fixtures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES n8n_connections(id) ON DELETE CASCADE,
  workflow_uuid UUID NOT NULL,
  name TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  headers JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fixture lookups
CREATE INDEX idx_vn_fixtures_lookup ON vn_fixtures(user_id, workflow_uuid);
CREATE INDEX idx_vn_fixtures_connection ON vn_fixtures(connection_id, workflow_uuid);

-- vn_test_runs: Test execution history
CREATE TABLE vn_test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES n8n_connections(id) ON DELETE CASCADE,
  workflow_uuid UUID NOT NULL,
  fixture_id UUID REFERENCES vn_fixtures(id) ON DELETE SET NULL,
  test_workflow_id UUID NOT NULL REFERENCES vn_test_workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout')),
  response_json JSONB,
  error_message TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for test run history lookups
CREATE INDEX idx_vn_test_runs_lookup ON vn_test_runs(user_id, workflow_uuid, created_at DESC);
CREATE INDEX idx_vn_test_runs_fixture ON vn_test_runs(fixture_id);

-- Enable RLS on all tables
ALTER TABLE vn_test_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE vn_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE vn_test_runs ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access their own data
-- Service role (backend) bypasses RLS, but these policies protect direct Supabase access

CREATE POLICY "Users can access own vn_test_workflows" ON vn_test_workflows
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can access own vn_fixtures" ON vn_fixtures
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can access own vn_test_runs" ON vn_test_runs
  FOR ALL USING (auth.uid() = user_id);

-- Trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_vn_test_workflows_updated_at
  BEFORE UPDATE ON vn_test_workflows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vn_fixtures_updated_at
  BEFORE UPDATE ON vn_fixtures
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
