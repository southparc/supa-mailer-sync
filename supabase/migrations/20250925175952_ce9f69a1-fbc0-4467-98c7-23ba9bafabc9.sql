-- Remove SECURITY DEFINER from upsert_tax_parameter if it doesn't need elevated privileges
-- This function only operates on tax_parameters table which has proper RLS policies

CREATE OR REPLACE FUNCTION public.upsert_tax_parameter(p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_country     text := p->>'country';
  v_regime      text := p->>'regime';
  v_code        text := p->>'code';
  v_name        text := p->>'name';
  v_value_num   numeric := nullif(p->>'value_numeric','')::numeric;
  v_value_text  text := nullif(p->>'value_text','');
  v_currency    text := nullif(p->>'currency','');
  v_unit        text := nullif(p->>'unit','');
  v_status      text := p->>'status';  -- 'enacted' | 'proposed' | 'review'
  v_valid_from  date := (p->>'valid_from')::date;
  v_valid_to    date := nullif(p->>'valid_to','')::date;
  v_source_url  text := nullif(p->>'source_url','');
  v_source_ref  text := nullif(p->>'source_ref','');
begin
  if v_country is null or v_regime is null or v_code is null or v_name is null or v_valid_from is null then
    raise exception 'Missing required fields (country, regime, code, name, valid_from)';
  end if;

  -- Upsert on a logical key; add a unique index for this if not present:
  -- create unique index if not exists tax_params_uq on public.tax_parameters(country, regime, code, valid_from);

  insert into public.tax_parameters as tp
    (country, regime, code, name,
     value_numeric, value_text, currency, unit,
     status, valid_from, valid_to, source_url, source_ref, updated_at)
  values
    (v_country, v_regime, v_code, v_name,
     v_value_num, v_value_text, v_currency, v_unit,
     v_status, v_valid_from, v_valid_to, v_source_url, v_source_ref, now())
  on conflict (country, regime, code, valid_from)
  do update set
     name         = excluded.name,
     value_numeric= excluded.value_numeric,
     value_text   = excluded.value_text,
     currency     = excluded.currency,
     unit         = excluded.unit,
     status       = excluded.status,
     valid_to     = excluded.valid_to,
     source_url   = excluded.source_url,
     source_ref   = excluded.source_ref,
     updated_at   = now();
end;
$function$;