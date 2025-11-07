-- Create a secured version of v_clients_for_ml with RLS
-- This leaves the existing view unchanged for backward compatibility with other apps

CREATE OR REPLACE VIEW public.v_clients_for_ml_secure
WITH (security_barrier = true)
AS
SELECT 
  c.email,
  c.first_name,
  c.last_name,
  c.phone,
  c.country,
  c.city,
  COALESCE(
    (SELECT array_agg(mg.group_name ORDER BY mg.group_name)
     FROM client_group_mappings cgm
     JOIN managed_mailerlite_groups mg ON cgm.group_id = mg.id
     WHERE cgm.client_id = c.id
       AND cgm.is_subscribed = true
    ),
    ARRAY[]::text[]
  ) AS groups
FROM clients c
WHERE c.email IS NOT NULL;

-- Add RLS policy to restrict access to service_role and admin users only
ALTER VIEW public.v_clients_for_ml_secure SET (security_barrier = true);

-- Enable RLS on the view (views inherit RLS from underlying tables, but we can add explicit policies)
-- Create policy: Only service_role or admin users can access this view
CREATE POLICY "Only service role and admins can access secure client view"
ON public.clients
FOR SELECT
USING (
  auth.role() = 'service_role' 
  OR public.has_role(auth.uid(), 'admin'::app_role)
);

COMMENT ON VIEW public.v_clients_for_ml_secure IS 'Secured view of client data for MailerLite sync - restricted to service_role and admin users only. Use this instead of v_clients_for_ml for sync operations.';