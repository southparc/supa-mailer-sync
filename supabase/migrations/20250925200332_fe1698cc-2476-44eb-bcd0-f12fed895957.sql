-- Clean up conflicting RLS policies on clients table
-- Remove the problematic "Block direct updates for regular users" policy that blocks legitimate updates

-- Drop the conflicting blocking policy
DROP POLICY IF EXISTS "Block direct updates for regular users" ON public.clients;

-- Ensure RLS is properly enabled
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Recreate clean policies to ensure they work correctly
DROP POLICY IF EXISTS "clients_select_own" ON public.clients;
CREATE POLICY "clients_select_own" 
ON public.clients 
FOR SELECT 
TO authenticated 
USING (supabase_auth_id = auth.uid());

DROP POLICY IF EXISTS "clients_update_own" ON public.clients;
CREATE POLICY "clients_update_own" 
ON public.clients 
FOR UPDATE 
TO authenticated 
USING (supabase_auth_id = auth.uid()) 
WITH CHECK (supabase_auth_id = auth.uid());