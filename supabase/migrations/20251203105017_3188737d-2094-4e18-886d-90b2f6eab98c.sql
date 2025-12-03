-- Fix Security Definer View by recreating with security_invoker = on
DROP VIEW IF EXISTS public.v_clients_for_ml_secure;

CREATE VIEW public.v_clients_for_ml_secure
WITH (security_invoker = on)
AS
SELECT 
  email,
  first_name,
  last_name,
  phone,
  country,
  city,
  COALESCE(
    (SELECT array_agg(mg.group_name ORDER BY mg.group_name)
     FROM client_group_mappings cgm
     JOIN managed_mailerlite_groups mg ON cgm.group_id = mg.id
     WHERE cgm.client_id = c.id AND cgm.is_subscribed = true),
    ARRAY[]::text[]
  ) AS groups
FROM clients c
WHERE email IS NOT NULL;