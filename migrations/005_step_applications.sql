-- Phase 2B Step 2: step_applications audit table
-- Tracks all applications of plan steps to VN TEST workflows

CREATE TABLE IF NOT EXISTS public.step_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_uuid TEXT NOT NULL,
  plan_id UUID NOT NULL REFERENCES public.completion_plans(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  test_workflow_id TEXT NOT NULL,
  patch_json JSONB NOT NULL,
  rollback_json JSONB,
  diff_summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'rolled_back')),
  error TEXT,
  idempotency_key TEXT,
  applied_by TEXT DEFAULT 'assist/apply-step',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_step_applications_plan_id ON public.step_applications(plan_id);
CREATE INDEX IF NOT EXISTS idx_step_applications_workflow_uuid ON public.step_applications(workflow_uuid);
CREATE INDEX IF NOT EXISTS idx_step_applications_idempotency_key ON public.step_applications(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Unique constraint on idempotency_key to prevent duplicate applications
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_applications_idempotency_unique 
  ON public.step_applications(idempotency_key) 
  WHERE idempotency_key IS NOT NULL;

-- Comment
COMMENT ON TABLE public.step_applications IS 'Audit log for all plan step applications to VN TEST workflows';
