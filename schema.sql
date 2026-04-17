-- ContractRadar Database Schema
-- Run this in your Supabase SQL editor

-- ── Contracts table ──────────────────────────────────────────────────────────
create table contracts (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  file_name text,
  vendor_name text not null,
  monthly_cost numeric,
  annual_cost numeric,
  renewal_date date,
  contract_start_date date,
  auto_renewal boolean default false,
  auto_renewal_notice_days integer,
  termination_notice_days integer,
  price_escalation_clause text,
  sla_commitments text[] default '{}',
  red_flags text[] default '{}',
  overpay_flag boolean default false,
  overpay_reason text,
  contract_type text check (contract_type in ('SaaS', 'Professional Services', 'Infrastructure', 'Hardware', 'Other')),
  payment_terms text,
  governing_law text,
  analyzed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for fast company lookups
create index idx_contracts_company_id on contracts(company_id);
create index idx_contracts_renewal_date on contracts(renewal_date);
create index idx_contracts_company_renewal on contracts(company_id, renewal_date);

-- ── Alert configs table ──────────────────────────────────────────────────────
create table alert_configs (
  id uuid primary key default gen_random_uuid(),
  company_id text unique not null,
  email text not null,
  company_name text default 'My Company',
  alert_days_before integer[] default '{30,60,90}',
  weekly_digest boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_alert_configs_company on alert_configs(company_id);
create index idx_alert_configs_digest on alert_configs(weekly_digest) where weekly_digest = true;

-- ── Updated_at trigger ───────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger contracts_updated_at
  before update on contracts
  for each row execute function update_updated_at();

create trigger alert_configs_updated_at
  before update on alert_configs
  for each row execute function update_updated_at();

-- ── Row Level Security (optional, for multi-tenant safety) ───────────────────
-- Enable if you add user auth via Supabase Auth
-- alter table contracts enable row level security;
-- alter table alert_configs enable row level security;
