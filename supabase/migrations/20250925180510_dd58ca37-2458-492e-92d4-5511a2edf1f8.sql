-- Remove SECURITY DEFINER from sync_figlo_client_v2 to rely on RLS policies
-- This function should only operate on data the user has access to via RLS

CREATE OR REPLACE FUNCTION public.sync_figlo_client_v2(p_client_id uuid, p_client jsonb, p_partners jsonb DEFAULT '[]'::jsonb, p_houses jsonb DEFAULT '[]'::jsonb, p_insurances jsonb DEFAULT '[]'::jsonb, p_pensions jsonb DEFAULT '[]'::jsonb, p_investments jsonb DEFAULT '[]'::jsonb, p_liabilities jsonb DEFAULT '[]'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_now timestamptz := now();
  rec jsonb;
begin
  -- client upsert (alleen velden die je aanlevert overschrijven)
  update public.clients c
  set first_name            = coalesce(p_client->>'firstName', c.first_name),
      last_name             = coalesce(p_client->>'lastName', c.last_name),
      email                 = coalesce(p_client->>'email', c.email),
      birth_date            = coalesce((p_client->>'birthDate')::date, c.birth_date),
      gender                = coalesce(p_client->>'gender', c.gender),
      city                  = coalesce(p_client->>'city', c.city),
      zip                   = coalesce(p_client->>'zip', c.zip),
      country               = coalesce(p_client->>'country', c.country),
      gross_income          = coalesce((p_client->>'grossIncome')::float8, c.gross_income),
      net_monthly_income    = coalesce((p_client->>'netMonthlyIncome')::float8, c.net_monthly_income),
      net_monthly_spending  = coalesce((p_client->>'netMonthlySpend')::float8, c.net_monthly_spending),
      saving_balance        = coalesce((p_client->>'savingBalance')::float8, c.saving_balance),
      investment_balance    = coalesce((p_client->>'investmentBalance')::float8, c.investment_balance),
      pension_income        = coalesce((p_client->>'pensionIncome')::float8, c.pension_income),
      retirement_target_age = coalesce((p_client->>'retirementTargetAge')::int, c.retirement_target_age),
      risk_profile          = coalesce(p_client->>'riskProfile', c.risk_profile),
      figloCfid             = coalesce(p_client->>'figloCfid', c.figloCfid),
      figloTagName          = coalesce(p_client->>'figloTagName', c.figloTagName),
      figloLastSyncAt       = v_now,
      figloRawSnapshot      = p_client->'rawSnapshot'
  where c.id = p_client_id;

  if not found then
    raise exception 'client % not found', p_client_id using errcode = 'NO_DATA_FOUND';
  end if;

  -- partners
  for rec in select * from jsonb_array_elements(p_partners)
  loop
    insert into public.partners (
      client_id, figloSourceId, first_name, last_name, email, gross_income, gender, initials, prefix, created_at, updated_at
    ) values (
      p_client_id,
      rec->>'figloSourceId',
      rec->>'firstName',
      rec->>'lastName',
      rec->>'email',
      (rec->>'grossIncome')::float8,
      rec->>'gender',
      rec->>'initials',
      rec->>'prefix',
      v_now, v_now
    )
    on conflict (client_id, figloSourceId) do update
      set first_name = excluded.first_name,
          last_name  = excluded.last_name,
          email      = excluded.email,
          gross_income = excluded.gross_income,
          gender     = excluded.gender,
          initials   = excluded.initials,
          prefix     = excluded.prefix,
          updated_at = v_now;
  end loop;

  -- houses / hypotheek
  for rec in select * from jsonb_array_elements(p_houses)
  loop
    insert into public.house_objects (
      client_id, figloSourceId, display_name, is_owner_occupied, home_value,
      mortgage_amount, mortgage_remaining, annuity_amount, annuity_target_amount,
      energy_label, mortgage_interest_rate, current_rent, ltv, created_at, updated_at
    ) values (
      p_client_id,
      rec->>'figloSourceId',
      rec->>'displayName',
      (rec->>'isOwnerOccupied')::bool,
      (rec->>'homeValue')::float8,
      (rec->>'mortgageAmount')::float8,
      (rec->>'mortgageRemaining')::float8,
      (rec->>'annuityAmount')::float8,
      (rec->>'annuityTargetAmount')::float8,
      rec->>'energyLabel',
      (rec->>'mortgageInterestRate')::float8,
      (rec->>'currentRent')::float8,
      (rec->>'ltv')::float8,
      v_now, v_now
    )
    on conflict (client_id, figloSourceId) do update
      set display_name = excluded.display_name,
          is_owner_occupied = excluded.is_owner_occupied,
          home_value = excluded.home_value,
          mortgage_amount = excluded.mortgage_amount,
          mortgage_remaining = excluded.mortgage_remaining,
          annuity_amount = excluded.annuity_amount,
          annuity_target_amount = excluded.annuity_target_amount,
          energy_label = excluded.energy_label,
          mortgage_interest_rate = excluded.mortgage_interest_rate,
          current_rent = excluded.current_rent,
          ltv = excluded.ltv,
          updated_at = v_now;
  end loop;

  -- insurances
  for rec in select * from jsonb_array_elements(p_insurances)
  loop
    insert into public.insurances (
      client_id, figloSourceId, display_name, type, value, disability_percentage, death_risk_assurance_amount, created_at, updated_at
    ) values (
      p_client_id,
      rec->>'figloSourceId',
      rec->>'displayName',
      rec->>'type',
      (rec->>'value')::float8,
      nullif(rec->>'disabilityPercentage','')::int,
      (rec->>'deathRiskAssuranceAmount')::float8,
      v_now, v_now
    )
    on conflict (client_id, figloSourceId) do update
      set display_name = excluded.display_name,
          type = excluded.type,
          value = excluded.value,
          disability_percentage = excluded.disability_percentage,
          death_risk_assurance_amount = excluded.death_risk_assurance_amount,
          updated_at = v_now;
  end loop;

  -- pensions
  for rec in select * from jsonb_array_elements(p_pensions)
  loop
    insert into public.pensions (
      client_id, figloSourceId, provider, type, expected_annual_payout, created_at
    ) values (
      p_client_id,
      rec->>'figloSourceId',
      rec->>'provider',
      rec->>'type',
      (rec->>'expectedAnnualPayout')::float8,
      v_now
    )
    on conflict (client_id, figloSourceId) do update
      set provider = excluded.provider,
          type = excluded.type,
          expected_annual_payout = excluded.expected_annual_payout;
  end loop;

  -- investments
  for rec in select * from jsonb_array_elements(p_investments)
  loop
    insert into public.investments (
      client_id, figloSourceId, name, type, current_value, created_at
    ) values (
      p_client_id,
      rec->>'figloSourceId',
      rec->>'name',
      rec->>'type',
      (rec->>'currentValue')::float8,
      v_now
    )
    on conflict (client_id, figloSourceId) do update
      set name = excluded.name,
          type = excluded.type,
          current_value = excluded.current_value;
  end loop;

  -- liabilities
  for rec in select * from jsonb_array_elements(p_liabilities)
  loop
    insert into public.liabilities (
      client_id, figloSourceId, name, type, total_amount, created_at
    ) values (
      p_client_id,
      rec->>'figloSourceId',
      rec->>'name',
      rec->>'type',
      (rec->>'totalAmount')::float8,
      v_now
    )
    on conflict (client_id, figloSourceId) do update
      set name = excluded.name,
          type = excluded.type,
          total_amount = excluded.total_amount;
  end loop;

end;
$function$;