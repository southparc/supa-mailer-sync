-- Add RLS policy to allow authenticated users to read sync state for UI display
CREATE POLICY "Authenticated users can read sync display state"
ON sync_state
FOR SELECT
TO authenticated
USING (
  key IN ('last_successful_sync', 'sync_statistics', 'sync_percentage_status')
);