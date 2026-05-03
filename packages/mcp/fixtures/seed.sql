-- Atlas MCP demo fixture — small accounts/companies/people dataset.
-- Hydrated by `bunx @useatlas/mcp serve` into a local SQLite file when no
-- ATLAS_DATASOURCE_URL is configured. Schema mirrors a tiny CRM so the
-- bundled semantic layer (companies, accounts, people) lights up the
-- explore + executeSQL tools out of the box.

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  employees INTEGER NOT NULL,
  founded_year INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  plan TEXT NOT NULL,
  monthly_revenue_usd INTEGER NOT NULL,
  status TEXT NOT NULL,
  signed_up_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL
);

INSERT INTO companies (id, name, industry, employees, founded_year) VALUES
  (1, 'Acme Robotics', 'Manufacturing', 480, 1998),
  (2, 'Northwind Trading', 'Retail', 120, 2014),
  (3, 'Globex Analytics', 'Software', 65, 2019),
  (4, 'Initech', 'Software', 240, 2003),
  (5, 'Soylent Foods', 'CPG', 1100, 1985);

INSERT INTO accounts (id, company_id, plan, monthly_revenue_usd, status, signed_up_at) VALUES
  (101, 1, 'enterprise', 24000, 'active', '2024-02-11'),
  (102, 2, 'team',         3200, 'active', '2024-09-03'),
  (103, 3, 'starter',       490, 'trialing', '2025-01-22'),
  (104, 4, 'enterprise', 18500, 'active', '2023-08-30'),
  (105, 5, 'team',         5400, 'churned', '2022-04-17');

INSERT INTO people (id, company_id, full_name, email, role) VALUES
  (1001, 1, 'Maya Chen',     'maya@acme.example',     'VP Engineering'),
  (1002, 1, 'Tom Patel',     'tom@acme.example',      'Data Lead'),
  (1003, 2, 'Priya Anand',   'priya@northwind.example','Head of Sales'),
  (1004, 3, 'Lars Olafsen',  'lars@globex.example',   'CEO'),
  (1005, 4, 'Bill Lumbergh', 'bill@initech.example',  'COO'),
  (1006, 5, 'Sam Reyes',     'sam@soylent.example',   'Director of Ops');
