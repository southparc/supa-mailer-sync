-- Fix the second Security Definer View issue - full_client_v2 function
-- Remove SECURITY DEFINER since it already has proper access control with admin checks

CREATE OR REPLACE FUNCTION public.full_client_v2(p_email text)
 RETURNS TABLE(id uuid, supabase_auth_id uuid, first_name text, last_name text, email text, phone text, initials text, prefix text, gender text, birth_date date, age integer, country text, employment_type text, planning_status text, risk_profile text, gross_income double precision, net_monthly_income double precision, net_monthly_spending double precision, saving_balance double precision, investment_balance double precision, pension_income double precision, retirement_target_age integer, monthly_fixed_costs double precision, monthly_variable_costs double precision, consumer_credit_amount double precision, house_id integer, is_owner_occupied boolean, home_value double precision, mortgage_amount double precision, mortgage_remaining double precision, mortgage_interest_rate double precision, annuity_amount double precision, annuity_target_amount double precision, energy_label text, current_rent double precision, contract_id integer, dvo double precision, max_loan double precision, is_damage_client boolean, insurance_id integer, disability_percentage integer, death_risk_assurance_amount double precision, insurance_premiums_total double precision, financial_goal_id integer, financial_goal_description text, financial_goal_amount double precision, goal_priority text, liability_id integer, liability_total_amount double precision, investment_id integer, investment_current_value double precision, advisor_name text, advisor_email text, partner_gross_income double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
  with base as (
    select c.*
      from public.clients c
     where lower(c.email) = lower($1)
       and (
            c.supabase_auth_id = auth.uid()
         or exists (
              select 1 from public.admin_users au
               where lower(au.email) = lower(auth.email())
                 and au.is_active = true
         )
       )
     limit 1
  ),
  latest_house as (
    select h.* from public.house_objects h join base b on b.id = h.client_id
    order by h.updated_at desc nulls last limit 1
  ),
  latest_contract as (
    select co.* from public.contracts co join base b on b.id = co.client_id
    order by co.updated_at desc nulls last limit 1
  ),
  -- Get insurance record with disability_percentage, prioritizing non-null values
  insurance_with_disability as (
    select i.*
    from public.insurances i
    join base b on b.id = i.client_id
    where i.disability_percentage is not null
    order by i.disability_percentage desc, i.updated_at desc
    limit 1
  ),
  -- Get insurance record with death_risk_assurance_amount, prioritizing non-null values  
  insurance_with_death_risk as (
    select i.*
    from public.insurances i
    join base b on b.id = i.client_id
    where i.death_risk_assurance_amount is not null
    order by i.death_risk_assurance_amount desc, i.updated_at desc
    limit 1
  ),
  -- Fallback to latest insurance record if no specific values found
  latest_insurance as (
    select i.*
    from public.insurances i
    join base b on b.id = i.client_id
    order by i.updated_at desc nulls last
    limit 1
  ),
  ins_totals as (
    select coalesce(sum(i.value), 0) as insurance_premiums_total
      from public.insurances i join base b on b.id = i.client_id
  ),
  liabilities_totals as (
    select coalesce(sum(l.total_amount), 0) as liability_total_amount
      from public.liabilities l join base b on b.id = l.client_id
  ),
  investments_totals as (
    select coalesce(sum(iv.current_value), 0) as investment_current_value
      from public.investments iv join base b on b.id = iv.client_id
  ),
  latest_goal as (
    select fg.* from public.financial_goals fg join base b on b.id = fg.client_id
    order by fg.updated_at desc nulls last limit 1
  ),
  advisor as (
    select a.name as advisor_name, a.email as advisor_email
      from public.advisors a join base b on b.advisor_id = a.id
     limit 1
  ),
  partner as (
    select coalesce(sum(p.gross_income), 0) as partner_gross_income
      from public.partners p join base b on b.id = p.client_id
  )
  select
    b.id, b.supabase_auth_id, b.first_name, b.last_name, b.email, b.phone, b.initials, b.prefix, b.gender, b.birth_date, b.age,
    b.country, b.employment_type, b.planning_status, b.risk_profile, b.gross_income, b.net_monthly_income, b.net_monthly_spending,
    b.saving_balance, b.investment_balance, b.pension_income, b.retirement_target_age, b.monthly_fixed_costs, b.monthly_variable_costs,
    b.consumer_credit_amount,
    lh.id as house_id, lh.is_owner_occupied, lh.home_value, lh.mortgage_amount, lh.mortgage_remaining,
    lh.mortgage_interest_rate, lh.annuity_amount, lh.annuity_target_amount, lh.energy_label, lh.current_rent,
    lc.id as contract_id, lc.dvo, lc.max_loan, lc.is_damage_client,
    -- Use sophisticated insurance coalescing to prioritize records with specific values
    coalesce(li.id, iwd.id, iwdr.id) as insurance_id,
    coalesce(iwd.disability_percentage, li.disability_percentage) as disability_percentage,
    coalesce(iwdr.death_risk_assurance_amount, iwd.death_risk_assurance_amount, li.death_risk_assurance_amount) as death_risk_assurance_amount,
    it.insurance_premiums_total,
    lg.id as financial_goal_id, lg.description as financial_goal_description, lg.amount as financial_goal_amount, lg.goal_priority,
    (select l2.id from public.liabilities l2 join base bb on bb.id = l2.client_id order by l2.created_at desc nulls last limit 1) as liability_id,
    lt.liability_total_amount,
    (select inv2.id from public.investments inv2 join base bb on bb.id = inv2.client_id order by inv2.created_at desc nulls last limit 1) as investment_id,
    itv.investment_current_value,
    a.advisor_name, a.advisor_email, p.partner_gross_income
  from base b
  left join latest_house     lh  on true
  left join latest_contract  lc  on true
  left join latest_insurance li  on true
  left join insurance_with_disability iwd on true
  left join insurance_with_death_risk iwdr on true
  left join ins_totals       it  on true
  left join liabilities_totals lt on true
  left join investments_totals itv on true
  left join latest_goal      lg  on true
  left join advisor          a   on true
  left join partner          p   on true;
$function$;