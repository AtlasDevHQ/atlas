/**
 * Seeds the demo SQLite database with sample data.
 *
 * Usage: npm run seed
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.resolve("data/atlas.db");
const db = new Database(DB_PATH);

db.exec(`
  DROP TABLE IF EXISTS accounts;
  DROP TABLE IF EXISTS people;
  DROP TABLE IF EXISTS companies;

  CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    industry TEXT NOT NULL,
    employee_count INTEGER NOT NULL,
    founded_year INTEGER NOT NULL,
    country TEXT NOT NULL,
    revenue REAL,
    valuation REAL
  );

  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    department TEXT NOT NULL,
    seniority TEXT NOT NULL,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL
  );

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    monthly_value REAL NOT NULL,
    contract_start TEXT NOT NULL,
    contract_end TEXT
  );
`);

// --- Companies ---
const industries = [
  "Technology",
  "Healthcare",
  "Finance",
  "Retail",
  "Manufacturing",
  "Education",
  "Energy",
  "Media",
];
const countries = ["US", "UK", "DE", "CA", "AU", "FR", "JP", "IN", "BR", "SG"];

const companyInsert = db.prepare(
  `INSERT INTO companies (name, industry, employee_count, founded_year, country, revenue, valuation) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const companyNames = [
  "Acme Corp", "TechVentures", "DataFlow Inc", "CloudSync", "NetPulse",
  "Quantum Labs", "BioGenix", "FinEdge", "RetailHub", "ManuTech",
  "EduSpark", "GreenWatt", "MediaVox", "HealthBridge", "CyberShield",
  "PayStream", "ShopWave", "AutoForge", "LearnPath", "SolarGrid",
  "ContentPeak", "GenomicAI", "LedgerPro", "FreshMart", "RoboWorks",
  "SkillForge", "WindScape", "StreamLine", "VitalCare", "TrustVault",
  "CartFlow", "PrecisionMfg", "BrightMinds", "CleanJoule", "PixelCraft",
  "NeuralMed", "CoinBase Plus", "GrocerEase", "SteelCraft", "CodeAcademy Pro",
  "HydroGen", "AdTech Global", "PharmaLink", "WealthWise", "UrbanMart",
  "NanoFab", "TutorAI", "FusionPower", "CastMedia", "OmniHealth",
];

for (let i = 0; i < 50; i++) {
  const empCount = Math.floor(Math.random() * 2000) + 10;
  const revenue = Math.random() > 0.05 ? Math.floor(Math.random() * 500_000_000) + 100_000 : null;
  const valuation = Math.random() > 0.15 ? Math.floor((revenue ?? 1_000_000) * (2 + Math.random() * 8)) : null;

  companyInsert.run(
    companyNames[i],
    industries[i % industries.length],
    empCount,
    2000 + Math.floor(Math.random() * 24),
    countries[i % countries.length],
    revenue,
    valuation
  );
}

// --- People ---
const departments = ["Engineering", "Sales", "Marketing", "Product", "Operations", "Finance"];
const seniorities = ["Junior", "Mid", "Senior", "Executive"];
const titles: Record<string, string[]> = {
  Engineering: ["Software Engineer", "Backend Engineer", "Frontend Engineer", "DevOps Engineer", "VP Engineering"],
  Sales: ["Account Executive", "SDR", "Sales Manager", "VP Sales", "Enterprise AE"],
  Marketing: ["Marketing Manager", "Content Strategist", "Growth Lead", "VP Marketing", "Brand Manager"],
  Product: ["Product Manager", "Product Designer", "UX Researcher", "VP Product", "Data Analyst"],
  Operations: ["Operations Manager", "HR Manager", "Office Manager", "VP Operations", "Recruiter"],
  Finance: ["Financial Analyst", "Controller", "CFO", "Accountant", "FP&A Manager"],
};

const firstNames = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Sam", "Quinn", "Avery", "Dakota",
  "Jamie", "Reese", "Finley", "Rowan", "Sage", "Blair", "Drew", "Emery", "Hayden", "Lane"];
const lastNames = ["Smith", "Chen", "Patel", "Kim", "Garcia", "Mueller", "Tanaka", "Silva", "Brown", "Lee",
  "Singh", "Williams", "Anderson", "Thomas", "Jackson", "White", "Harris", "Martin", "Davis", "Lopez"];

const personInsert = db.prepare(
  `INSERT INTO people (name, email, company_id, department, seniority, title, start_date) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

for (let i = 0; i < 200; i++) {
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
  const dept = departments[Math.floor(Math.random() * departments.length)];
  const seniority = seniorities[Math.floor(Math.random() * seniorities.length)];
  const deptTitles = titles[dept];
  const title = deptTitles[Math.floor(Math.random() * deptTitles.length)];
  const companyId = Math.floor(Math.random() * 50) + 1;
  const startYear = 2018 + Math.floor(Math.random() * 7);
  const startMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const startDay = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");

  personInsert.run(
    `${firstName} ${lastName}`,
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}@company${companyId}.com`,
    companyId,
    dept,
    seniority,
    title,
    `${startYear}-${startMonth}-${startDay}`
  );
}

// --- Accounts ---
const plans = ["Free", "Starter", "Pro", "Enterprise"];
const statuses = ["Active", "Active", "Active", "Active", "Inactive", "Suspended", "Churned"]; // weighted toward Active
const planPrices: Record<string, [number, number]> = {
  Free: [0, 0],
  Starter: [29, 99],
  Pro: [199, 999],
  Enterprise: [2000, 15000],
};

const accountInsert = db.prepare(
  `INSERT INTO accounts (company_id, plan, status, monthly_value, contract_start, contract_end) VALUES (?, ?, ?, ?, ?, ?)`
);

for (let i = 0; i < 80; i++) {
  const companyId = Math.floor(Math.random() * 50) + 1;
  const plan = plans[Math.floor(Math.random() * plans.length)];
  const status = statuses[Math.floor(Math.random() * statuses.length)];
  const [minPrice, maxPrice] = planPrices[plan];
  const monthlyValue = minPrice + Math.floor(Math.random() * (maxPrice - minPrice + 1));
  const startYear = 2020 + Math.floor(Math.random() * 5);
  const startMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const contractStart = `${startYear}-${startMonth}-01`;

  let contractEnd: string | null = null;
  if (status === "Churned" || Math.random() > 0.7) {
    const endYear = startYear + 1 + Math.floor(Math.random() * 2);
    contractEnd = `${endYear}-${startMonth}-01`;
  }

  accountInsert.run(companyId, plan, status, monthlyValue, contractStart, contractEnd);
}

db.close();

console.log("Seeded atlas.db: 50 companies, 200 people, 80 accounts");
