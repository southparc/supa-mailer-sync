-- Phase 1: Create RBAC System with user_roles and has_role()

-- 1. Create enum for roles
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

-- 2. Create user_roles table
CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    role app_role NOT NULL,
    created_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES auth.users(id),
    UNIQUE (user_id, role)
);

-- 3. Enable RLS on user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 4. Create security definer function to check roles (prevents infinite recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- 5. Create RLS policies for user_roles table
CREATE POLICY "Users can view their own roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Service role can manage roles"
ON public.user_roles
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- 6. Migrate existing admin_users to user_roles
INSERT INTO public.user_roles (user_id, role, created_at)
SELECT 
  (SELECT id FROM auth.users WHERE email = au.email LIMIT 1) as user_id,
  'admin'::app_role as role,
  now() as created_at
FROM public.admin_users au
WHERE au.is_active = true
  AND EXISTS (SELECT 1 FROM auth.users WHERE email = au.email)
ON CONFLICT (user_id, role) DO NOTHING;

-- 7. Update all existing admin policies to use has_role()

-- clients table
DROP POLICY IF EXISTS "Admin users can view all clients" ON public.clients;
CREATE POLICY "Admins can view all clients"
ON public.clients
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- advisors table
DROP POLICY IF EXISTS "Admin users can view all advisors" ON public.advisors;
CREATE POLICY "Admins can view all advisors"
ON public.advisors
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- sync_log table
DROP POLICY IF EXISTS "Admin users can view sync log" ON public.sync_log;
CREATE POLICY "Admins can view sync log"
ON public.sync_log
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- sync_conflicts table
DROP POLICY IF EXISTS "Admin users can manage sync conflicts" ON public.sync_conflicts;
CREATE POLICY "Admins can manage sync conflicts"
ON public.sync_conflicts
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- sync_shadow table
DROP POLICY IF EXISTS "Admin users can manage sync shadow" ON public.sync_shadow;
CREATE POLICY "Admins can manage sync shadow"
ON public.sync_shadow
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- sync_state table
DROP POLICY IF EXISTS "Admin users can manage sync state" ON public.sync_state;
CREATE POLICY "Admins can manage sync state"
ON public.sync_state
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- sync_runs table
DROP POLICY IF EXISTS "Admin users can view sync runs" ON public.sync_runs;
CREATE POLICY "Admins can view sync runs"
ON public.sync_runs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- integration_crosswalk table
DROP POLICY IF EXISTS "Admin users can manage integration crosswalk" ON public.integration_crosswalk;
CREATE POLICY "Admins can manage integration crosswalk"
ON public.integration_crosswalk
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- integration_crosswalk_groups table
DROP POLICY IF EXISTS "Admin users can manage crosswalk_groups" ON public.integration_crosswalk_groups;
CREATE POLICY "Admins can manage crosswalk_groups"
ON public.integration_crosswalk_groups
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- mailerlite_groups table
DROP POLICY IF EXISTS "Admin users can manage mailerlite_groups" ON public.mailerlite_groups;
CREATE POLICY "Admins can manage mailerlite_groups"
ON public.mailerlite_groups
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- managed_mailerlite_groups table
DROP POLICY IF EXISTS "Admin users can view managed groups" ON public.managed_mailerlite_groups;
CREATE POLICY "Admins can view managed groups"
ON public.managed_mailerlite_groups
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- audit_logs table
DROP POLICY IF EXISTS "Admin users can view all audit logs" ON public.audit_logs;
CREATE POLICY "Admins can view all audit logs"
ON public.audit_logs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- admin_users table (keep read-only for reference)
DROP POLICY IF EXISTS "Admin users can view their own record" ON public.admin_users;
CREATE POLICY "Admins can view admin_users"
ON public.admin_users
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));