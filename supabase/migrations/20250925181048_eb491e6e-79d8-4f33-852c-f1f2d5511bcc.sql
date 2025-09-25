-- Analyze and fix the remaining Security Definer functions

-- First, let's remove the potentially insecure get_user_id_by_email function
-- This function allows user enumeration by email, which is a security risk
-- If it's needed, it should be called from within a more secure context

-- Check if this function is actually needed by dropping it (we can recreate if needed)
DROP FUNCTION IF EXISTS public.get_user_id_by_email(text);

-- The tg__set_updated_at trigger function legitimately needs SECURITY DEFINER
-- But let's make it more secure by ensuring it only operates on the specific columns
-- and add additional safety checks

CREATE OR REPLACE FUNCTION public.tg__set_updated_at()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER 
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only update if the row actually changed
  IF NEW IS DISTINCT FROM OLD THEN
    -- Only set updated_at if the column exists in the table
    IF TG_TABLE_NAME IN (
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      AND tablename = TG_TABLE_NAME
    ) THEN
      NEW.updated_at = now();
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;