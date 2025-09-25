-- Enable RLS only on actual tables that don't have it enabled yet
ALTER TABLE public.tax_parameters ENABLE ROW LEVEL SECURITY;

-- Add a policy for tax_parameters to allow read access to authenticated users
CREATE POLICY "Authenticated users can view tax parameters" 
ON public.tax_parameters 
FOR SELECT 
USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

-- Allow service role to manage tax parameters
CREATE POLICY "Service role can manage tax parameters" 
ON public.tax_parameters 
FOR ALL 
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');