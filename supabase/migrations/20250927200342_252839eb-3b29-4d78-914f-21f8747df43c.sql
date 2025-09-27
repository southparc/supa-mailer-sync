-- Create the 4 critical sync tables with UUID primary keys and proper constraints

-- 1. Integration Crosswalk: Maps emails between systems
CREATE TABLE public.integration_crosswalk (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  a_id TEXT, -- Supabase client ID
  b_id TEXT, -- MailerLite subscriber ID
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 2. Sync Shadow: Stores last known state for conflict detection
CREATE TABLE public.sync_shadow (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  snapshot JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 3. Sync Conflicts: Tracks field-level conflicts for resolution
CREATE TABLE public.sync_conflicts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  field TEXT NOT NULL,
  a_value TEXT,
  b_value TEXT,
  detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'ignored')),
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_value TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 4. Sync Log: Audit trail for all sync operations
CREATE TABLE public.sync_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('A→B', 'B→A', 'bidirectional')),
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add indexes for performance
CREATE INDEX idx_integration_crosswalk_email ON public.integration_crosswalk(email);
CREATE INDEX idx_sync_shadow_email ON public.sync_shadow(email);
CREATE INDEX idx_sync_conflicts_email_status ON public.sync_conflicts(email, status);
CREATE INDEX idx_sync_conflicts_detected_at ON public.sync_conflicts(detected_at);
CREATE INDEX idx_sync_log_email_created_at ON public.sync_log(email, created_at);
CREATE INDEX idx_sync_log_dedupe_key ON public.sync_log(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Add updated_at triggers for the tables that need them
CREATE TRIGGER update_integration_crosswalk_updated_at
  BEFORE UPDATE ON public.integration_crosswalk
  FOR EACH ROW
  EXECUTE FUNCTION public.tg__set_updated_at();

CREATE TRIGGER update_sync_shadow_updated_at
  BEFORE UPDATE ON public.sync_shadow
  FOR EACH ROW
  EXECUTE FUNCTION public.tg__set_updated_at();

CREATE TRIGGER update_sync_conflicts_updated_at
  BEFORE UPDATE ON public.sync_conflicts
  FOR EACH ROW
  EXECUTE FUNCTION public.tg__set_updated_at();

-- Enable RLS on all sync tables
ALTER TABLE public.integration_crosswalk ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;

-- RLS policies for admin access
CREATE POLICY "Admin users can manage integration crosswalk" 
ON public.integration_crosswalk 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM admin_users au
  WHERE au.email = auth.email() AND au.is_active = true
));

CREATE POLICY "Admin users can manage sync shadow" 
ON public.sync_shadow 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM admin_users au
  WHERE au.email = auth.email() AND au.is_active = true
));

CREATE POLICY "Admin users can manage sync conflicts" 
ON public.sync_conflicts 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM admin_users au
  WHERE au.email = auth.email() AND au.is_active = true
));

CREATE POLICY "Admin users can view sync log" 
ON public.sync_log 
FOR SELECT 
USING (EXISTS (
  SELECT 1 FROM admin_users au
  WHERE au.email = auth.email() AND au.is_active = true
));

-- Service role policies for edge functions
CREATE POLICY "Service role can manage integration crosswalk" 
ON public.integration_crosswalk 
FOR ALL 
USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage sync shadow" 
ON public.sync_shadow 
FOR ALL 
USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage sync conflicts" 
ON public.sync_conflicts 
FOR ALL 
USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage sync log" 
ON public.sync_log 
FOR ALL 
USING (auth.role() = 'service_role');