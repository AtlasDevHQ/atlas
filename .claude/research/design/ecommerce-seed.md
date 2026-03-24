# E-commerce Seed Database — Design Document

> Design reference for building a realistic, production-like demo database for Atlas.
> This adds a DTC e-commerce company database as an alternative to the cybersecurity SaaS demo (62 tables, ~500K rows). The e-commerce seed has 52 tables, ~480K rows, and covers a pandemic-era home goods brand with marketplace expansion.

## Why

The cybersec demo proves Atlas handles messy B2B SaaS data. But e-commerce is the most common analytics use case — every data team has dealt with order tables, customer segments, shipping carriers, and promotion attribution. A second demo seed lets users evaluate Atlas against the data patterns they already know.

Real e-commerce databases have:
- Price columns that changed from dollars to cents mid-migration
- Carrier fields that evolved from free text to FK references
- Orphaned payments from deleted test orders
- Denormalized reporting tables that drift from source of truth
- Abandoned import artifacts and pre-migration backups
- Inconsistent enum values from years of manual entry

## Company Profile: "NovaMart"

A DTC (direct-to-consumer) home goods brand founded in 2020 during the pandemic. Started with bedding, expanded to kitchen/bath/outdoor. Launched a small marketplace in 2022 (third-party sellers alongside own inventory — like Target marketplace). ~8,000 customers, 800 products, 25,000 orders spanning 2020–2025.

## Target Scale

| Metric | Count |
|--------|-------|
| Tables | 52 |
| Total rows | ~480K |
| Largest table (order_events) | ~60K rows |
| Second largest (order_items) | ~55K rows |
| Time span | 2020–2025 (pandemic boom → normalization) |
| Customers | ~8,000 |
| Products | 800 |
| Orders | 25,000 |

---

## Schema Design

### 1. Core Commerce — 6 tables

| Table | Rows | Notes |
|-------|------|-------|
| `customers` | 8,000 | Has both `phone` and `mobile_phone` (schema evolution) |
| `customer_addresses` | 12,000 | ~1.5 per customer avg. Missing FK to customers |
| `customer_segments` | 10 | VIP, Regular, New, At-Risk, etc. |
| `customer_segment_assignments` | 9,000 | Has denormalized `segment_name` column |
| `loyalty_accounts` | 5,500 | Points system, tier field with case inconsistency |
| `loyalty_transactions` | 18,000 | Points earned/redeemed events |

**Tech debt in this group:**
- `customers.phone` (TEXT, original) — always populated
- `customers.mobile_phone` (TEXT NULL, added 2022) — preferred by the app, populated for ~85% of customers (all post-2022, ~30% of pre-2022). App uses `COALESCE(mobile_phone, phone)`
- `customer_addresses.customer_id` → `customers.id` — NO FK CONSTRAINT
- `customer_segment_assignments.segment_name` (TEXT) — denormalized from `customer_segments.name`. Out of sync for rows where the segment was renamed
- `loyalty_accounts.tier` has inconsistent values: 'Gold', 'gold', 'GOLD', 'Silver', 'silver'

### 2. Product Catalog — 7 tables

| Table | Rows | Notes |
|-------|------|-------|
| `categories` | 25 | Hierarchical (parent_id self-ref) |
| `products` | 800 | Has both `price` (dollars) and `price_cents` (cents, added 2023) |
| `product_variants` | 3,200 | Size/color/material combos |
| `product_images` | 4,000 | Multiple per product |
| `product_tags` | 2,500 | Flexible tagging |
| `inventory_levels` | 3,200 | Per-variant per-warehouse |
| `warehouses` | 5 | Fulfillment centers |

**Tech debt in this group:**
- `products.price` (NUMERIC, dollars, original) — always populated
- `products.price_cents` (INTEGER, cents, added 2023) — NULL for ~40% of products. App uses `price_cents / 100.0` when available, falls back to `price`
- `products.seller_id` → `sellers.id` — NO FK CONSTRAINT (marketplace products only, ~20% of products have non-NULL seller_id)
- `inventory_levels.variant_id` → `product_variants.id` — NO FK CONSTRAINT

### 3. Marketplace — 4 tables

| Table | Rows | Notes |
|-------|------|-------|
| `sellers` | 80 | Third-party marketplace sellers |
| `seller_applications` | 120 | Includes rejected/pending |
| `seller_payouts` | 2,000 | Monthly payouts |
| `seller_performance` | 400 | Monthly metrics per seller |

Clean group, no significant tech debt.

### 4. Orders & Transactions — 7 tables

| Table | Rows | Notes |
|-------|------|-------|
| `orders` | 25,000 | Has denormalized `customer_email`. `shipping_cost` changed from dollars to cents mid-2023 |
| `order_items` | 55,000 | ~2.2 items per order avg. Missing FK to product_variants |
| `order_events` | 60,000 | Status timeline (placed, confirmed, shipped, delivered, etc.) — LARGEST TABLE |
| `payments` | 26,000 | Some orders have multiple payments (split pay). Missing FK to orders for ~1.5% |
| `refunds` | 2,500 | Linked to payments |
| `gift_cards` | 500 | Issued gift cards |
| `gift_card_transactions` | 1,200 | Usage log |

**Tech debt in this group:**
- `orders.customer_email` (TEXT) — denormalized from `customers.email`. Drifts when customer updates their email
- `orders.shipping_cost` (NUMERIC) — was dollars, now stores cents for orders after 2023-06. Old data NOT migrated. Queries must check `order_date` to interpret correctly
- `order_items.product_variant_id` → `product_variants.id` — NO FK CONSTRAINT
- `order_events.order_id` → `orders.id` — NO FK CONSTRAINT
- `payments.order_id` — ~1.5% reference nonexistent order IDs (orphaned from deleted test orders)

### 5. Shipping & Fulfillment — 5 tables

| Table | Rows | Notes |
|-------|------|-------|
| `shipments` | 22,000 | Has both `carrier` (text) and `carrier_id` (integer, added 2024) |
| `shipment_items` | 48,000 | Line items per shipment |
| `shipping_carriers` | 8 | UPS, FedEx, USPS, DHL, etc. |
| `returns` | 3,000 | Return requests. `reason` has case inconsistency |
| `return_items` | 4,500 | Items within a return |

**Tech debt in this group:**
- `shipments.carrier` (TEXT, original: 'UPS', 'FedEx', etc.) — always populated
- `shipments.carrier_id` (INTEGER, added 2024) — NULL for ~60% of older shipments. App prefers `carrier_id` JOIN when available, falls back to `carrier` text
- `shipment_items.shipment_id` → `shipments.id` — NO FK CONSTRAINT
- `returns.reason` has inconsistent values: 'Defective', 'defective', 'DEFECTIVE', 'Wrong Item', 'wrong_item'

### 6. Marketing & Promotions — 5 tables

| Table | Rows | Notes |
|-------|------|-------|
| `promotions` | 200 | Discount codes, flash sales |
| `promotion_usages` | 8,000 | Which orders used which promo |
| `email_campaigns` | 50 | Marketing campaigns |
| `email_sends` | 30,000 | Individual email deliveries |
| `utm_tracking` | 15,000 | UTM parameter tracking for attribution |

**Tech debt in this group:**
- `utm_tracking.customer_id` → `customers.id` — NO FK CONSTRAINT
- `promotion_usages.promotion_id` → `promotions.id` — NO FK CONSTRAINT
- `promotion_usages.order_id` → `orders.id` — NO FK CONSTRAINT

### 7. Reviews — 3 tables

| Table | Rows | Notes |
|-------|------|-------|
| `product_reviews` | 6,000 | Has both `rating` (INTEGER 1-5) and `rating_decimal` (NUMERIC, added 2024) |
| `review_responses` | 1,500 | Seller/brand responses |
| `review_helpfulness` | 8,000 | Upvote/downvote on reviews |

**Tech debt in this group:**
- `product_reviews.rating` (INTEGER, 1-5, original) — always populated
- `product_reviews.rating_decimal` (NUMERIC, 1.0-5.0, added 2024) — NULL for ~70% of older reviews. App uses `rating_decimal` when available, falls back to `rating::numeric`
- `review_helpfulness.review_id` → `product_reviews.id` — NO FK CONSTRAINT
- `review_helpfulness.customer_id` → `customers.id` — NO FK CONSTRAINT

### 8. Reporting / Denormalized — 5 tables

| Table | Rows | Notes |
|-------|------|-------|
| `daily_sales_summary` | 1,800 | Daily rollup of order totals |
| `monthly_revenue_summary` | 60 | Monthly aggregates |
| `orders_denormalized` | 25,000 | Fat table: order + customer + first item info |
| `product_performance_cache` | 800 | Pre-computed product metrics |
| `customer_ltv_cache` | 8,000 | Pre-computed customer lifetime value |

These are pure denormalization. No FK constraints on any of them. The `orders_denormalized` table duplicates `orders` with joined columns from `customers` and the first `order_items` row.

### 9. Site Analytics — 3 tables

| Table | Rows | Notes |
|-------|------|-------|
| `page_views` | 20,000 | Page view events |
| `cart_events` | 15,000 | Add/remove/abandon cart actions |
| `search_queries` | 5,000 | Site search log |

**Tech debt in this group:**
- `page_views.customer_id` → `customers.id` — NO FK CONSTRAINT (nullable, NULL for anonymous visitors)
- `cart_events.customer_id` → `customers.id` — NO FK CONSTRAINT (nullable, NULL for anonymous visitors)

### 10. Internal / Ops — 3 tables

| Table | Rows | Notes |
|-------|------|-------|
| `admin_users` | 30 | Internal staff |
| `admin_audit_log` | 10,000 | Admin actions |
| `system_settings` | 20 | Key-value config |

Clean tables.

### 11. Legacy & Abandoned — 4 tables

| Table | Rows | Description |
|-------|------|-------------|
| `old_orders_v1` | 3,000 | Pre-migration order table from 2020. Different column names than `orders` (e.g., `order_total` instead of `total_cents`, `cust_email` instead of `customer_email`). Has data but nothing reads from it |
| `temp_product_import_2023` | 500 | One-time CSV import artifact. Columns don't match `products` schema (e.g., `import_sku` and `import_price` that don't exist elsewhere). Left behind |
| `legacy_analytics_events` | 8,000 | Old event tracking system. Replaced by `page_views` + `cart_events` in 2024. Generic event schema with `event_name` TEXT and `event_data` TEXT columns |
| `payment_methods_backup` | 2,000 | Backup created during Stripe-to-Adyen payment processor migration. Columns match old payment schema. No FK to current tables |

---

## Tech Debt Catalog

### Pattern 1: Abandoned Tables (4 tables)
All tables in group 11 above. They should be droppable but nobody has gotten around to it. The profiler should ideally flag these as potentially unused.

**Detection heuristics the profiler could use:**
- Table name contains 'legacy', 'old', 'temp', 'backup', 'v1'
- No FK constraints pointing TO this table (nothing depends on it)
- All data older than some threshold
- Column names don't match any other table's FK references

### Pattern 2: Schema Evolution Artifacts (10 instances)
| Table | Column(s) | Issue |
|-------|-----------|-------|
| `products` | `price` + `price_cents` | Dollars-to-cents migration, both columns kept |
| `customers` | `phone` + `mobile_phone` | Newer column preferred, old one kept |
| `customers` | `acquisition_source` | Case-inconsistent ('Google', 'google', 'GOOGLE', 'organic', 'Organic') |
| `shipments` | `carrier` + `carrier_id` | Text-to-FK migration, both columns kept |
| `orders` | `shipping_cost` | Dollars-to-cents mid-2023, old data not migrated |
| `product_reviews` | `rating` + `rating_decimal` | Integer-to-decimal migration, both columns kept |
| `loyalty_accounts` | `tier` | Case-inconsistent enum values |
| `returns` | `reason` | Case-inconsistent enum values |
| `customer_segment_assignments` | `segment_name` | Denormalized, sometimes out of sync with source |
| `orders` | `customer_email` | Denormalized, drifts when customer updates email |

### Pattern 3: Missing Constraints (19 missing FKs)
| From Table | Column | Should Reference | Constraint Exists? |
|-----------|--------|-----------------|-------------------|
| `customer_addresses` | `customer_id` | `customers.id` | NO |
| `order_items` | `product_variant_id` | `product_variants.id` | NO |
| `order_events` | `order_id` | `orders.id` | NO |
| `products` | `seller_id` | `sellers.id` | NO |
| `inventory_levels` | `variant_id` | `product_variants.id` | NO |
| `payments` | `order_id` | `orders.id` | NO |
| `utm_tracking` | `customer_id` | `customers.id` | NO |
| `page_views` | `customer_id` | `customers.id` | NO |
| `cart_events` | `customer_id` | `customers.id` | NO |
| `review_helpfulness` | `review_id` | `product_reviews.id` | NO |
| `review_helpfulness` | `customer_id` | `customers.id` | NO |
| `promotion_usages` | `promotion_id` | `promotions.id` | NO |
| `promotion_usages` | `order_id` | `orders.id` | NO |
| `shipment_items` | `shipment_id` | `shipments.id` | NO |
| `loyalty_transactions` | `order_id` | `orders.id` | NO |
| `gift_card_transactions` | `order_id` | `orders.id` | NO |
| `shipments` | `carrier_id` | `shipping_carriers.id` | NO |
| `search_queries` | `customer_id` | `customers.id` | NO |
| `search_queries` | `clicked_product_id` | `products.id` | NO |

Also:
- ~1.5% of `payments.order_id` reference nonexistent orders (orphaned from deleted test orders)
- `products.seller_id` is NULL for ~80% of products (first-party only) — no constraint, no NOT NULL

### Pattern 4: Denormalization & Duplication
- `orders_denormalized` — pre-joined orders + customer + first item info
- `daily_sales_summary` — daily rollup of order totals
- `monthly_revenue_summary` — monthly aggregates
- `product_performance_cache` — pre-computed product metrics (revenue, units sold, avg rating)
- `customer_ltv_cache` — lifetime value estimates per customer
- `orders.customer_email` — copied from `customers.email`
- `customer_segment_assignments.segment_name` — copied from `customer_segments.name`

---

## Data Generation Strategy

### Postgres (`data/ecommerce.sql`)

Use `GENERATE_SERIES` + `random()` for bulk data generation. Strategy:

1. **DDL first** — all CREATE TABLE statements, indexes, comments
2. **Reference data** — small tables with static INSERT (categories, customer_segments, warehouses, shipping_carriers, admin_users, system_settings)
3. **Core entities** — customers, products, sellers via GENERATE_SERIES
4. **Product data** — variants, images, tags, inventory via GENERATE_SERIES
5. **Order data** — orders, order_items, order_events via GENERATE_SERIES with pandemic temporal curve
6. **Transaction data** — payments, refunds, gift_cards, shipments via GENERATE_SERIES
7. **Engagement data** — reviews, marketing, site analytics via GENERATE_SERIES
8. **Reporting tables** — populated via INSERT...SELECT from core tables
9. **Legacy tables** — static INSERTs with intentionally different schemas

Use arrays for realistic enum values:
```sql
(ARRAY['Bedding','Kitchen','Bath','Outdoor','Lighting','Storage','Decor','Rugs','Furniture'])[1 + (random() * 8)::int]
```

Temporal distribution: pandemic curve using `power(random(), 0.5)` shaped to match:
- 2020: ~2K orders (launch ramp)
- 2021: ~6K orders (pandemic peak)
- 2022: ~5.5K orders (marketplace launch boost, then normalization)
- 2023: ~5K orders (steady state)
- 2024: ~4K orders (slight decline)
- 2025: ~2.5K orders (partial year)

Orphaned FKs: ~1-2% of logical FK columns reference nonexistent IDs (generated by offsetting GENERATE_SERIES ranges).

Case-inconsistent enum values: use weighted random to mix cases ('Gold' 60%, 'gold' 25%, 'GOLD' 15%).

---

## Interesting Questions This Data Supports

### Sales & Revenue
- "What's the monthly revenue trend since launch?"
- "Top 10 products by total revenue"
- "Average order value by customer segment"
- "Which categories have the highest return rate?"
- "Revenue breakdown: own products vs marketplace"

### Customer Analytics
- "How many customers are in each loyalty tier?"
- "What's the customer retention rate by cohort?"
- "Average customer lifetime value by acquisition source"
- "Which customers have the most orders?"
- "Breakdown of new vs returning customers per month"

### Operations
- "Average delivery time by carrier"
- "Return rate by product category"
- "Inventory levels below reorder point"
- "Shipping cost per order over time" (requires knowing about the dollars-to-cents migration)
- "Top reasons for returns" (requires handling case-inconsistent values)

### Marketing
- "Campaign conversion rates"
- "Which UTM sources drive the most revenue?"
- "Promo code usage rate by campaign"
- "Email open/click rates by campaign type"

### Tech Debt Discovery (what the profiler should help surface)
- "What tables look abandoned?" → includes 4 legacy tables
- "Why are there two price fields on products?"
- "Why don't loyalty tier values match between rows?"
- "Compare orders_denormalized with orders"
- "Why does shipping_cost look wrong for older orders?"

---

## Implementation Phases

### Phase 1: Schema & Seed (Postgres)
**Files:** `packages/cli/data/ecommerce.sql`
**Effort:** Large — 52 tables, DDL + GENERATE_SERIES data generation
**Dependencies:** None

Create the full Postgres seed file with:
- All 52 tables with proper DDL
- Strategic indexes (not too many, not too few — realistic)
- Comments on some tables but not all (realistic)
- Reference data (static INSERTs)
- Bulk data via GENERATE_SERIES with pandemic-curve temporal distribution
- Legacy tables with intentionally different naming/structure
- Orphaned FK rows and case-inconsistent enums

### Phase 2: Demo Integration
**Files:** `packages/cli/bin/atlas.ts`, `create-atlas/index.ts`
**Effort:** Small — add `--demo ecommerce` flag, update create-atlas TUI
**Dependencies:** Phase 1

Update `atlas init --demo` to accept the new dataset name:
- `--demo` or `--demo simple` → current 3-table demo (backward compatible)
- `--demo cybersec` → cybersecurity SaaS database (existing)
- `--demo ecommerce` → NovaMart e-commerce database (new)

Update `create-atlas` to offer dataset choice:
- "Simple (3 tables, quick start)" — default
- "Cybersecurity SaaS (62 tables, realistic)" — PostgreSQL only
- "E-commerce DTC (52 tables, realistic)" — PostgreSQL only

### Phase 3: Profiler Improvements
**Files:** `packages/cli/bin/atlas.ts`, new tests
**Effort:** Medium — new heuristics, e-commerce-specific patterns
**Dependencies:** Phase 1 (use as test fixture)

Improvements this dataset specifically exercises:
- [ ] **Unit migration detection** — detect columns that changed units (dollars → cents) based on value ranges or column name patterns (`price` + `price_cents`)
- [ ] **Temporal data inconsistency** — detect columns where value interpretation changed at a date boundary (e.g., `shipping_cost`)
- [ ] **Unused table heuristics** — flag tables named `old_*`, `temp_*`, `legacy_*`, `*_backup` or with no inbound FKs and stale data
- [ ] **Enum normalization** — detect case-inconsistent enum values and note in YAML
- [ ] **Denormalized table detection** — flag tables with many columns matching other tables
- [ ] **FK inference from naming** — detect `*_id` columns that reference `{tablename}.id`

### Phase 4: Documentation
**Files:** `docs/guides/demo-datasets.md`, README updates
**Effort:** Small
**Dependencies:** Phases 1-2

Document:
- How to use the ecommerce demo
- What questions to ask
- What tech debt patterns are included
- How this complements the cybersec demo (different domain, different debt patterns)

---

## Table Index (all 52 tables)

| # | Table | Group | Rows | Has Tech Debt |
|---|-------|-------|------|---------------|
| 1 | customers | Core Commerce | 8,000 | dual phone columns |
| 2 | customer_addresses | Core Commerce | 12,000 | missing FK |
| 3 | customer_segments | Core Commerce | 10 | |
| 4 | customer_segment_assignments | Core Commerce | 9,000 | denorm segment_name |
| 5 | loyalty_accounts | Core Commerce | 5,500 | case-inconsistent tier |
| 6 | loyalty_transactions | Core Commerce | 18,000 | |
| 7 | categories | Product Catalog | 25 | |
| 8 | products | Product Catalog | 800 | dual price columns, missing FK |
| 9 | product_variants | Product Catalog | 3,200 | |
| 10 | product_images | Product Catalog | 4,000 | |
| 11 | product_tags | Product Catalog | 2,500 | |
| 12 | inventory_levels | Product Catalog | 3,200 | missing FK |
| 13 | warehouses | Product Catalog | 5 | |
| 14 | sellers | Marketplace | 80 | |
| 15 | seller_applications | Marketplace | 120 | |
| 16 | seller_payouts | Marketplace | 2,000 | |
| 17 | seller_performance | Marketplace | 400 | |
| 18 | orders | Orders | 25,000 | denorm email, shipping_cost unit drift |
| 19 | order_items | Orders | 55,000 | missing FK |
| 20 | order_events | Orders | 60,000 | missing FK |
| 21 | payments | Orders | 26,000 | orphaned FKs |
| 22 | refunds | Orders | 2,500 | |
| 23 | gift_cards | Orders | 500 | |
| 24 | gift_card_transactions | Orders | 1,200 | |
| 25 | shipments | Shipping | 22,000 | dual carrier columns |
| 26 | shipment_items | Shipping | 48,000 | missing FK |
| 27 | shipping_carriers | Shipping | 8 | |
| 28 | returns | Shipping | 3,000 | case-inconsistent reason |
| 29 | return_items | Shipping | 4,500 | |
| 30 | promotions | Marketing | 200 | |
| 31 | promotion_usages | Marketing | 8,000 | missing FKs |
| 32 | email_campaigns | Marketing | 50 | |
| 33 | email_sends | Marketing | 30,000 | |
| 34 | utm_tracking | Marketing | 15,000 | missing FK |
| 35 | product_reviews | Reviews | 6,000 | dual rating columns |
| 36 | review_responses | Reviews | 1,500 | |
| 37 | review_helpfulness | Reviews | 8,000 | missing FKs |
| 38 | daily_sales_summary | Reporting | 1,800 | no FKs |
| 39 | monthly_revenue_summary | Reporting | 60 | no FKs |
| 40 | orders_denormalized | Reporting | 25,000 | no FKs, full duplication |
| 41 | product_performance_cache | Reporting | 800 | no FKs |
| 42 | customer_ltv_cache | Reporting | 8,000 | no FKs |
| 43 | page_views | Analytics | 20,000 | missing FK |
| 44 | cart_events | Analytics | 15,000 | missing FK |
| 45 | search_queries | Analytics | 5,000 | |
| 46 | admin_users | Internal | 30 | |
| 47 | admin_audit_log | Internal | 10,000 | |
| 48 | system_settings | Internal | 20 | |
| 49 | old_orders_v1 | LEGACY | 3,000 | pre-migration schema |
| 50 | temp_product_import_2023 | LEGACY | 500 | one-time import artifact |
| 51 | legacy_analytics_events | LEGACY | 8,000 | replaced by page_views + cart_events |
| 52 | payment_methods_backup | LEGACY | 2,000 | processor migration backup |

**Total: 52 tables, ~480K rows**
