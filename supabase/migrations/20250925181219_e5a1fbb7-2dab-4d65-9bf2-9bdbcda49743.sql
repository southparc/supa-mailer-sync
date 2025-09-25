-- Fix the remaining Function Search Path Mutable warnings and make functions more secure
-- These functions don't have SET search_path which can be a security issue

-- Fix v_tax_parameters_on function by adding search_path
CREATE OR REPLACE FUNCTION public.v_tax_parameters_on(peildatum date)
RETURNS SETOF tax_parameters
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  with ranked as (
    select
      tp,  -- keep as composite
      row_number() over (
        partition by tp.country, tp.regime, tp.code
        order by tp.valid_from desc, tp.updated_at desc nulls last
      ) as rn
    from public.tax_parameters tp
    where tp.valid_from <= peildatum
      and (tp.valid_to is null or tp.valid_to >= peildatum)
      and tp.status in ('enacted','proposed')
  )
  select (tp).*  -- expand composite to exact table columns
  from ranked
  where rn = 1;
$function$;

-- Let's also check if we can replace the trigger function with a different approach
-- or at least document why it needs SECURITY DEFINER
COMMENT ON FUNCTION public.tg__set_updated_at() IS 'Trigger function that requires SECURITY DEFINER to update timestamps regardless of user permissions. This is standard and necessary for trigger functionality.';