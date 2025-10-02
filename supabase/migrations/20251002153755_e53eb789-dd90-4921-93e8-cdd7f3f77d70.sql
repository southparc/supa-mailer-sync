-- Smart Sync: Tables, Views, Indexes, and RLS Policies

-- 1. Create mailerlite_groups table
CREATE TABLE IF NOT EXISTS public.mailerlite_groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ml_group_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Create integration_crosswalk_groups table
CREATE TABLE IF NOT EXISTS public.integration_crosswalk_groups (
  email TEXT NOT NULL,
  a_group_id INTEGER NOT NULL REFERENCES public.mailerlite_groups(id) ON DELETE CASCADE,
  b_group_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (email, a_group_id)
);

-- 3. Create v_clients_for_ml view (flat data for sync)
CREATE OR REPLACE VIEW public.v_clients_for_ml AS
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

-- 4. Create performance indexes
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_crosswalk_email 
  ON integration_crosswalk(email);

CREATE INDEX IF NOT EXISTS ix_integration_crosswalk_b_id 
  ON integration_crosswalk(b_id) 
  WHERE b_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_sync_shadow_email 
  ON sync_shadow(email);

CREATE INDEX IF NOT EXISTS ix_sync_log_email_created 
  ON sync_log(email, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_sync_conflicts_email_status 
  ON sync_conflicts(email, status) 
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ix_client_group_mappings_client_group 
  ON client_group_mappings(client_id, group_id);

CREATE INDEX IF NOT EXISTS ix_mailerlite_groups_name 
  ON mailerlite_groups(name);

-- 5. Enable RLS on new tables
ALTER TABLE public.mailerlite_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_crosswalk_groups ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies for mailerlite_groups
CREATE POLICY "Admin users can manage mailerlite_groups"
  ON public.mailerlite_groups
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_users au
      WHERE au.email = auth.email() AND au.is_active = true
    )
  );

CREATE POLICY "Service role can manage mailerlite_groups"
  ON public.mailerlite_groups
  FOR ALL
  USING (auth.role() = 'service_role');

-- 7. RLS Policies for integration_crosswalk_groups
CREATE POLICY "Admin users can manage crosswalk_groups"
  ON public.integration_crosswalk_groups
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_users au
      WHERE au.email = auth.email() AND au.is_active = true
    )
  );

CREATE POLICY "Service role can manage crosswalk_groups"
  ON public.integration_crosswalk_groups
  FOR ALL
  USING (auth.role() = 'service_role');