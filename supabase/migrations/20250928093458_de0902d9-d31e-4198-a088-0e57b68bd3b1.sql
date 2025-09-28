-- Create sync_state table for persisting resume state
CREATE TABLE public.sync_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

-- Policies for sync_state
CREATE POLICY "Service role can manage sync state" 
ON public.sync_state 
FOR ALL 
USING (auth.role() = 'service_role');

CREATE POLICY "Admin users can manage sync state" 
ON public.sync_state 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM admin_users au 
  WHERE au.email = auth.email() AND au.is_active = true
));