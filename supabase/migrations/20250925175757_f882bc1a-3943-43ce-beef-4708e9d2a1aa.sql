-- Fix remaining Security Definer issues by removing SECURITY DEFINER from utility functions
-- that don't need elevated privileges

-- Remove SECURITY DEFINER from safe_to_float - it's just a utility function
CREATE OR REPLACE FUNCTION public.safe_to_float(val text)
 RETURNS double precision
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN val::float8;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$function$;

-- Remove SECURITY DEFINER from safe_to_int - it's just a utility function  
CREATE OR REPLACE FUNCTION public.safe_to_int(val text)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN val::integer;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$function$;