-- Phase 1: Fix Database Schema and Consolidate State

-- Step 1: Fix integration_crosswalk.a_id to UUID type
-- First, update any existing data to ensure it's valid UUID format
UPDATE integration_crosswalk 
SET a_id = NULL 
WHERE a_id IS NOT NULL AND a_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Change column type from TEXT to UUID
ALTER TABLE integration_crosswalk 
ALTER COLUMN a_id TYPE uuid USING a_id::uuid;

-- Step 2: Add foreign key constraint to clients table
ALTER TABLE integration_crosswalk
ADD CONSTRAINT fk_crosswalk_client 
FOREIGN KEY (a_id) REFERENCES clients(id) ON DELETE CASCADE;

-- Step 3: Add performance indexes
CREATE INDEX IF NOT EXISTS idx_crosswalk_email ON integration_crosswalk(email);
CREATE INDEX IF NOT EXISTS idx_crosswalk_a_id ON integration_crosswalk(a_id);
CREATE INDEX IF NOT EXISTS idx_crosswalk_b_id ON integration_crosswalk(b_id);

CREATE INDEX IF NOT EXISTS idx_sync_shadow_email ON sync_shadow(email);
CREATE INDEX IF NOT EXISTS idx_sync_shadow_updated_at ON sync_shadow(updated_at);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_email ON sync_conflicts(email);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts(status);

CREATE INDEX IF NOT EXISTS idx_sync_log_email ON sync_log(email);
CREATE INDEX IF NOT EXISTS idx_sync_log_created_at ON sync_log(created_at);

CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_mailerlite_id ON clients(mailerlite_id);

-- Step 4: Consolidate sync_state into single sync_status key
-- Create a consolidated sync_status record that merges all existing state
DO $$
DECLARE
  v_full_sync_state jsonb;
  v_backfill_progress jsonb;
  v_backfill_paused jsonb;
  v_last_successful_sync jsonb;
  v_sync_statistics jsonb;
  v_consolidated jsonb;
BEGIN
  -- Fetch all existing state keys
  SELECT value INTO v_full_sync_state FROM sync_state WHERE key = 'full_sync_state';
  SELECT value INTO v_backfill_progress FROM sync_state WHERE key = 'backfill_progress';
  SELECT value INTO v_backfill_paused FROM sync_state WHERE key = 'backfill_paused';
  SELECT value INTO v_last_successful_sync FROM sync_state WHERE key = 'last_successful_sync';
  SELECT value INTO v_sync_statistics FROM sync_state WHERE key = 'sync_statistics';

  -- Build consolidated status
  v_consolidated := jsonb_build_object(
    'backfill', jsonb_build_object(
      'status', COALESCE((v_backfill_progress->>'status'), 'idle'),
      'phase', COALESCE((v_backfill_progress->>'phase'), ''),
      'currentBatch', COALESCE((v_backfill_progress->>'currentBatch')::int, 0),
      'totalBatches', COALESCE((v_backfill_progress->>'totalBatches')::int, 0),
      'shadowsCreated', COALESCE((v_backfill_progress->>'shadowsCreated')::int, 0),
      'errors', COALESCE((v_backfill_progress->>'errors')::int, 0),
      'startedAt', v_backfill_progress->>'startedAt',
      'lastUpdatedAt', v_backfill_progress->>'lastUpdatedAt',
      'completedAt', v_backfill_progress->>'completedAt',
      'paused', COALESCE((v_backfill_paused->>'paused')::boolean, false),
      'pauseReason', v_backfill_paused->>'reason'
    ),
    'fullSync', jsonb_build_object(
      'lastCompletedAt', v_full_sync_state->>'lastCompletedAt',
      'totalProcessed', COALESCE((v_full_sync_state->>'totalProcessed')::int, 0),
      'totalUpdated', COALESCE((v_full_sync_state->>'totalUpdated')::int, 0),
      'status', COALESCE((v_full_sync_state->>'status'), 'idle')
    ),
    'lastSync', jsonb_build_object(
      'timestamp', v_last_successful_sync->>'timestamp',
      'recordsProcessed', COALESCE((v_last_successful_sync->>'recordsProcessed')::int, 0)
    ),
    'statistics', COALESCE(v_sync_statistics, '{}'::jsonb)
  );

  -- Insert or update the consolidated sync_status
  INSERT INTO sync_state (key, value, updated_at)
  VALUES ('sync_status', v_consolidated, now())
  ON CONFLICT (key) 
  DO UPDATE SET value = EXCLUDED.value, updated_at = now();

END $$;

-- Add comment documenting the new structure
COMMENT ON COLUMN sync_state.value IS 
'For sync_status key, structure is:
{
  "backfill": {
    "status": "idle|running|paused|completed|failed",
    "phase": "Phase description",
    "currentBatch": 0,
    "totalBatches": 0,
    "shadowsCreated": 0,
    "errors": 0,
    "startedAt": "ISO timestamp",
    "lastUpdatedAt": "ISO timestamp",
    "completedAt": "ISO timestamp",
    "paused": false,
    "pauseReason": "string"
  },
  "fullSync": {
    "lastCompletedAt": "ISO timestamp",
    "totalProcessed": 0,
    "totalUpdated": 0,
    "status": "idle|running|completed|failed"
  },
  "lastSync": {
    "timestamp": "ISO timestamp",
    "recordsProcessed": 0
  },
  "statistics": {...}
}';