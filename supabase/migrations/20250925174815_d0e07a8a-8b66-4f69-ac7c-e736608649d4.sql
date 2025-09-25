-- Fix critical security vulnerability: restrict ml_subscribers access to authenticated users only
-- Remove the current overly permissive policies
DROP POLICY IF EXISTS "ml_subscribers_read" ON public.ml_subscribers;
DROP POLICY IF EXISTS "ml_groups_read" ON public.ml_groups;
DROP POLICY IF EXISTS "ml_outbox_read" ON public.ml_outbox;
DROP POLICY IF EXISTS "ml_subscriber_groups_read" ON public.ml_subscriber_groups;
DROP POLICY IF EXISTS "ml_sync_state_read" ON public.ml_sync_state;

-- Drop any existing admin policies that might conflict
DROP POLICY IF EXISTS "Admin users can view all subscribers" ON public.ml_subscribers;
DROP POLICY IF EXISTS "Admin users can view all groups" ON public.ml_groups;
DROP POLICY IF EXISTS "Admin users can view outbox" ON public.ml_outbox;
DROP POLICY IF EXISTS "Admin users can view subscriber groups" ON public.ml_subscriber_groups;
DROP POLICY IF EXISTS "Admin users can view sync state" ON public.ml_sync_state;

-- Drop any existing service role policies that might conflict
DROP POLICY IF EXISTS "Service role can manage subscribers" ON public.ml_subscribers;
DROP POLICY IF EXISTS "Service role can manage groups" ON public.ml_groups;
DROP POLICY IF EXISTS "Service role can manage outbox" ON public.ml_outbox;
DROP POLICY IF EXISTS "Service role can manage subscriber groups" ON public.ml_subscriber_groups;
DROP POLICY IF EXISTS "Service role can manage sync state" ON public.ml_sync_state;

-- Create new secure policies that only allow authenticated admin users to read data
CREATE POLICY "Admin users can view all subscribers" 
ON public.ml_subscribers 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 
    FROM public.admin_users au 
    WHERE au.email = auth.email() 
    AND au.is_active = true
  )
);

CREATE POLICY "Admin users can view all groups" 
ON public.ml_groups 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 
    FROM public.admin_users au 
    WHERE au.email = auth.email() 
    AND au.is_active = true
  )
);

CREATE POLICY "Admin users can view outbox" 
ON public.ml_outbox 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 
    FROM public.admin_users au 
    WHERE au.email = auth.email() 
    AND au.is_active = true
  )
);

CREATE POLICY "Admin users can view subscriber groups" 
ON public.ml_subscriber_groups 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 
    FROM public.admin_users au 
    WHERE au.email = auth.email() 
    AND au.is_active = true
  )
);

CREATE POLICY "Admin users can view sync state" 
ON public.ml_sync_state 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 
    FROM public.admin_users au 
    WHERE au.email = auth.email() 
    AND au.is_active = true
  )
);

-- Add policies for service role (edge functions) to manage data
CREATE POLICY "Service role can manage subscribers" 
ON public.ml_subscribers 
FOR ALL 
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage groups" 
ON public.ml_groups 
FOR ALL 
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage outbox" 
ON public.ml_outbox 
FOR ALL 
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage subscriber groups" 
ON public.ml_subscriber_groups 
FOR ALL 
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can manage sync state" 
ON public.ml_sync_state 
FOR ALL 
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');