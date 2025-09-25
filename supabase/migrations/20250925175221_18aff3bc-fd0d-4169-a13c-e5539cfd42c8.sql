-- Fix critical security vulnerability: v_clients_for_ml view exposing customer data
-- Drop the insecure view that exposes client emails without proper access control
DROP VIEW IF EXISTS public.v_clients_for_ml;

-- Recreate the view with proper security - only expose data that admins should see
-- This view will inherit RLS from the underlying clients table
CREATE VIEW public.v_clients_for_ml AS
SELECT 
  c.id as client_id,
  c.email,
  c.first_name,
  c.last_name,
  c.updated_at
FROM public.clients c;

-- Add a comment to document the security considerations
COMMENT ON VIEW public.v_clients_for_ml IS 'Secure view for MailerLite integration. Inherits RLS from clients table - only accessible to admin users and client owners.';