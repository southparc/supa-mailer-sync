-- Phase 1: Add marketing_status to clients for unsubscribed/bounced tracking
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS marketing_status TEXT 
CHECK (marketing_status IN ('active', 'unsubscribed', 'bounced', 'complained', 'junk'));

-- Phase 2: Create managed_mailerlite_groups table for whitelist
CREATE TABLE IF NOT EXISTS public.managed_mailerlite_groups (
  id SERIAL PRIMARY KEY,
  ml_group_id TEXT NOT NULL UNIQUE,
  group_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on managed_mailerlite_groups
ALTER TABLE public.managed_mailerlite_groups ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can manage
CREATE POLICY "Service role can manage managed groups"
ON public.managed_mailerlite_groups
FOR ALL
USING (auth.role() = 'service_role');

-- Policy: Admin users can view
CREATE POLICY "Admin users can view managed groups"
ON public.managed_mailerlite_groups
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM admin_users au 
    WHERE au.email = auth.email() AND au.is_active = true
  )
);

-- Phase 3: Create sync_runs table for enhanced logging
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  dry_run BOOLEAN NOT NULL DEFAULT false,
  emails_processed INTEGER DEFAULT 0,
  records_created INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  records_skipped INTEGER DEFAULT 0,
  conflicts_detected INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  error_details JSONB,
  summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on sync_runs
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can manage
CREATE POLICY "Service role can manage sync runs"
ON public.sync_runs
FOR ALL
USING (auth.role() = 'service_role');

-- Policy: Admin users can view
CREATE POLICY "Admin users can view sync runs"
ON public.sync_runs
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM admin_users au 
    WHERE au.email = auth.email() AND au.is_active = true
  )
);

-- Add index for efficient querying
CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON public.sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON public.sync_runs(status);

-- Update sync_log to include status_code for ML errors
ALTER TABLE public.sync_log 
ADD COLUMN IF NOT EXISTS status_code INTEGER,
ADD COLUMN IF NOT EXISTS error_type TEXT;