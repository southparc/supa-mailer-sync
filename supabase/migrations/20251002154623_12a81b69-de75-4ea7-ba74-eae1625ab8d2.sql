-- Fix security definer view by enabling security_invoker
-- This makes the view respect RLS policies

DROP VIEW IF EXISTS public.v_clients_for_ml;

CREATE VIEW public.v_clients_for_ml
WITH (security_invoker=on)
AS
SELECT
  c.email,
  COALESCE(c.first_name, '') AS first_name,
  COALESCE(c.last_name, '') AS last_name,
  COALESCE(c.city, '') AS city,
  COALESCE(c.phone, '') AS phone,
  COALESCE(c.country, '') AS country,
  COALESCE(ARRAY(
    SELECT mg.name
    FROM client_group_mappings cgm
    JOIN mailerlite_groups mg ON mg.id = cgm.group_id
    WHERE cgm.client_id = c.id 
      AND COALESCE(cgm.is_subscribed, true) = true
    ORDER BY mg.name
  ), ARRAY[]::TEXT[]) AS groups
FROM clients c;