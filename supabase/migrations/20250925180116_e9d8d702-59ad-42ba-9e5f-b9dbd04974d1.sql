-- Remove SECURITY DEFINER from link_client_auth_id if it can rely on RLS policies
-- This function updates clients table where user owns the record via email match

CREATE OR REPLACE FUNCTION public.link_client_auth_id()
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  update public.clients
  set supabase_auth_id = auth.uid()
  where email = auth.email()
    and supabase_auth_id is null;
$function$;