-- Add RLS policy for sync_state table to allow admins to read
CREATE POLICY "Admins can read sync_state"
ON sync_state
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'admin'
  )
);