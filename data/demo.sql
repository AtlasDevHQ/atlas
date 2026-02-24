-- Atlas demo schema (PostgreSQL)
-- Auto-loaded by docker-compose postgres service

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  employee_count INTEGER NOT NULL,
  founded_year INTEGER NOT NULL,
  country TEXT NOT NULL,
  revenue NUMERIC,
  valuation NUMERIC
);

CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  department TEXT NOT NULL,
  seniority TEXT NOT NULL,
  title TEXT NOT NULL,
  start_date DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  monthly_value NUMERIC NOT NULL,
  contract_start DATE NOT NULL,
  contract_end DATE
);
