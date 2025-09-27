-- Phase 3: Data Migration & Initialization for Enterprise Sync

-- Populate integration_crosswalk with existing client-subscriber mappings
INSERT INTO public.integration_crosswalk (email, a_id, b_id, created_at, updated_at)
SELECT DISTINCT 
  c.email,
  c.id::text as a_id,
  s.ml_id as b_id,
  now() as created_at,
  now() as updated_at
FROM public.clients c
LEFT JOIN public.ml_subscribers s ON lower(c.email) = lower(s.email)
WHERE c.email IS NOT NULL
ON CONFLICT (email) DO UPDATE SET
  a_id = EXCLUDED.a_id,
  b_id = EXCLUDED.b_id,
  updated_at = now();

-- Generate initial sync_shadow snapshots for all existing clients
INSERT INTO public.sync_shadow (email, snapshot, created_at, updated_at)
SELECT 
  c.email,
  jsonb_build_object(
    'aData', jsonb_build_object(
      'first_name', c.first_name,
      'last_name', c.last_name,
      'phone', c.phone,
      'city', c.city,
      'country', c.country
    ),
    'bData', jsonb_build_object(
      'first_name', COALESCE(s.fields->>'first_name', ''),
      'last_name', COALESCE(s.fields->>'last_name', ''),
      'phone', COALESCE(s.fields->>'phone', ''),
      'city', COALESCE(s.fields->>'city', ''),
      'country', COALESCE(s.fields->>'country', '')
    )
  ) as snapshot,
  now() as created_at,
  now() as updated_at
FROM public.clients c
LEFT JOIN public.ml_subscribers s ON lower(c.email) = lower(s.email)
WHERE c.email IS NOT NULL
ON CONFLICT (email) DO UPDATE SET
  snapshot = EXCLUDED.snapshot,
  updated_at = now();

-- Clean up any duplicate email entries in ml_subscribers (keep most recent)
DELETE FROM public.ml_subscribers
WHERE id NOT IN (
  SELECT DISTINCT ON (lower(email)) id
  FROM public.ml_subscribers
  ORDER BY lower(email), updated_at DESC NULLS LAST
);

-- Add index for better performance on crosswalk lookups
CREATE INDEX IF NOT EXISTS idx_integration_crosswalk_email_lookup ON public.integration_crosswalk(email);
CREATE INDEX IF NOT EXISTS idx_sync_shadow_email_lookup ON public.sync_shadow(email);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status_pending ON public.sync_conflicts(status) WHERE status = 'pending';