-- Add service role policies for client_group_mappings
CREATE POLICY "Service role can manage client_group_mappings"
ON public.client_group_mappings
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Add comment explaining the policy
COMMENT ON POLICY "Service role can manage client_group_mappings" ON public.client_group_mappings 
IS 'Allows service role (used by edge functions) to manage subscription status during sync operations';