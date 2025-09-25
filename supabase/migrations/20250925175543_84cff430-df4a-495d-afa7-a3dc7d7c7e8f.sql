-- Fix Security Definer View issues by removing SECURITY DEFINER from functions that don't need it
-- These functions already have proper RLS checks built-in

-- Fix full_client function - remove SECURITY DEFINER since it already checks auth.uid()
CREATE OR REPLACE FUNCTION public.full_client(email text)
 RETURNS TABLE(id uuid, supabase_auth_id uuid, first_name text, last_name text, email text, phone text, age integer, country text, employment_type text, planning_status text, risk_profile text, gross_income double precision, net_monthly_income double precision, net_monthly_spending double precision, saving_balance double precision, investment_balance double precision, pension_income double precision, retirement_target_age integer, monthly_fixed_costs double precision, monthly_variable_costs double precision, consumer_credit_amount double precision, house_id integer, is_owner_occupied boolean, home_value double precision, mortgage_remaining double precision, mortgage_interest_rate double precision, annuity_amount double precision, annuity_target_amount double precision, energy_label text, current_rent double precision, house_ltv double precision, contract_id integer, contract_display_name text, contract_type text, contract_value double precision, dvo double precision, max_loan double precision, is_damage_client boolean, insurance_id integer, insurance_display_name text, insurance_type text, insurance_value double precision, disability_percentage integer, death_risk_assurance_amount double precision, financial_goal_id integer, financial_goal_description text, financial_goal_amount double precision, goal_priority text, liability_id integer, liability_name text, liability_type text, liability_total_amount double precision, investment_id integer, investment_name text, investment_type text, investment_current_value double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  with
  latest_house as (
    select distinct on (client_id) *
    from public.house_objects
    order by client_id, coalesce(updated_at, created_at) desc nulls last
  ),
  latest_contract as (
    select distinct on (client_id) *
    from public.contracts
    order by client_id, coalesce(updated_at, created_at) desc nulls last
  ),
  latest_insurance as (
    select distinct on (client_id) *
    from public.insurances
    order by client_id, coalesce(updated_at, created_at) desc nulls last
  ),
  latest_goal as (
    select distinct on (client_id) *
    from public.financial_goals
    order by client_id, coalesce(updated_at, created_at) desc nulls last
  ),
  latest_liability as (
    select distinct on (client_id) *
    from public.liabilities
    order by client_id, created_at desc nulls last
  ),
  latest_investment as (
    select distinct on (client_id) *
    from public.investments
    order by client_id, created_at desc nulls last
  )
  select
    -- client
    c.id, c.supabase_auth_id, c.first_name, c.last_name,
    c.email, c.phone, c.age, c.country,
    c.employment_type, c.planning_status, c.risk_profile,
    c.gross_income, c.net_monthly_income, c.net_monthly_spending,
    c.saving_balance, c.investment_balance, c.pension_income, c.retirement_target_age,
    c.monthly_fixed_costs, c.monthly_variable_costs, c.consumer_credit_amount,
    -- house
    h.id, h.is_owner_occupied, h.home_value, h.mortgage_remaining, h.mortgage_interest_rate,
    h.annuity_amount, h.annuity_target_amount, h.energy_label, h.current_rent, h.ltv,
    -- contract
    ct.id, ct.display_name, ct.type, ct.value, ct.dvo, ct.max_loan, ct.is_damage_client,
    -- insurance
    ins.id, ins.display_name, ins.type, ins.value, ins.disability_percentage, ins.death_risk_assurance_amount,
    -- goal
    fg.id, fg.description, fg.amount, fg.goal_priority,
    -- liability & investment
    liab.id, liab.name, liab.type, liab.total_amount,
    inv.id,  inv.name, inv.type, inv.current_value
  from public.clients c
  left join latest_house h on h.client_id = c.id
  left join latest_contract ct on ct.client_id = c.id
  left join latest_insurance ins on ins.client_id = c.id
  left join latest_goal fg on fg.client_id = c.id
  left join latest_liability liab on liab.client_id = c.id
  left join latest_investment inv on inv.client_id = c.id
  where c.email = full_client.email
    and c.supabase_auth_id = auth.uid();
$function$;