/**
 * In-memory fixtures for the OKF interop spike tests (#4140).
 *
 * FOREIGN_BUNDLE mirrors the shape of Google's GA4 e-commerce sample bundle
 * (GoogleCloudPlatform/knowledge-catalog okf/bundles/ga4): table concepts
 * with `# Schema` bullet lists, metric/join Reference concepts with sql
 * fences, a dataset concept, and index.md navigation.
 *
 * SEMANTIC_LAYER is a compact Atlas layer (entity + glossary + metrics +
 * catalog) modeled on the ecommerce seed fixtures.
 */

import type { InteropFile } from "../types";

export const FOREIGN_BUNDLE: InteropFile[] = [
  {
    path: "index.md",
    content: `---
okf_version: "0.1"
---

# Shop analytics

* [tables](tables/index.md) - Event export tables.
* [references](references/index.md) - Metric and join definitions.
`,
  },
  {
    path: "datasets/shop_events.md",
    content: `---
type: BigQuery Dataset
title: Shop events dataset
description: Obfuscated e-commerce event export data covering three months.
tags:
- ecommerce
timestamp: '2026-05-28T22:49:59+00:00'
---

# Overview
Event export data for the demo shop.
`,
  },
  {
    path: "tables/events.md",
    content: `---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/demo/datasets/shop/tables/events
title: Events table
description: Contains web event export data for the demo shop.
tags:
- events
- ecommerce
timestamp: '2026-05-28T22:53:05+00:00'
---

# Overview
The \`events\` table contains web event export data for the demo shop.

# Metrics
- [Purchase Count](../references/metrics/purchase_count.md) - Total number of purchases.

# Schema
- \`event_date\` (STRING): The date when the event was logged (YYYYMMDD).
- \`event_timestamp\` (INTEGER): Microseconds (UTC) when the event was received.
- \`event_name\` (STRING): The name of the event.
- \`event_value_in_usd\` (FLOAT): Currency-converted value of the event.
- \`is_active_user\` (BOOLEAN): Whether the user was active in the session.
- \`event_params\` (RECORD): Repeated record of event parameters.

# Joins
- [Events to users](../references/joins/events_users.md) - join on \`user_id\`.
`,
  },
  {
    path: "tables/users.md",
    content: `---
type: BigQuery Table
title: Users table
description: One row per known user.
tags:
- users
timestamp: '2026-05-28T22:53:05+00:00'
---

# Overview
The \`users\` table has one row per known user.

# Schema

| Column       | Type      | Description                     |
|--------------|-----------|---------------------------------|
| \`user_id\`  | STRING    | Unique user identifier.         |
| \`signup_at\`| TIMESTAMP | When the user first signed up.  |
| \`ltv_usd\`  | NUMERIC   | Lifetime value in USD.          |
`,
  },
  {
    path: "references/index.md",
    content: `# References

* [metrics](metrics/index.md) - Metric definitions.
* [joins](joins/index.md) - Join specifications.
`,
  },
  {
    path: "references/metrics/purchase_count.md",
    content: `---
type: Reference
resource: https://example.com/docs/basic-queries
title: Purchase Count
description: Total number of purchase events.
tags:
- metric
timestamp: '2026-05-28T22:51:38+00:00'
---

Total number of purchase events.

\`\`\`sql
COUNT(*) -- filtered to event_name = 'purchase'
\`\`\`

# Citations
- https://example.com/docs/basic-queries
`,
  },
  {
    path: "references/metrics/prose_only_metric.md",
    content: `---
type: Reference
title: Engagement Rate
description: Share of sessions with meaningful engagement.
tags:
- metric
---

Share of sessions with meaningful engagement. Computed upstream; no SQL published.
`,
  },
  {
    path: "references/joins/events_users.md",
    content: `---
type: Reference
title: Join events to users
description: Join event data with the users table.
tags:
- join
---

Join event data with the users table.

\`\`\`sql
events.user_id = users.user_id
\`\`\`
`,
  },
  {
    path: "references/joins/events_ads.md",
    content: `---
type: Reference
title: Join events to ads clicks
description: Join event data with an external ads system.
tags:
- join
---

\`\`\`sql
SHOP_EVENTS.collected.gclid = ADS_CLICKS.gclid
\`\`\`
`,
  },
  {
    path: "references/runbook.md",
    content: `---
type: Playbook
title: Backfill runbook
description: How to backfill a missing day of events.
---

1. Re-run the export job.
`,
  },
  {
    path: "tables/broken.md",
    content: `no frontmatter here at all
`,
  },
];

export const SEMANTIC_LAYER: InteropFile[] = [
  {
    path: "entities/orders.yml",
    content: `name: Orders
type: fact_table
table: orders
grain: one row per order
description: |
  Customer orders - the primary fact table for revenue analysis.
dimensions:
  - name: id
    sql: id
    type: number
    description: Primary key - unique order identifier
    primary_key: true
  - name: status
    sql: status
    type: string
    description: Order fulfillment status
    sample_values: [pending, shipped, cancelled]
  - name: total_cents
    sql: total_cents
    type: number
    description: Order total in cents. Primary revenue field.
  - name: created_at
    sql: created_at
    type: timestamp
    description: When the order was placed
  - name: order_month
    sql: TO_CHAR(created_at, 'YYYY-MM')
    type: string
    description: Year-month the order was placed
    virtual: true
measures:
  - name: order_count
    sql: id
    type: count_distinct
    description: Number of unique orders
  - name: total_gmv_cents
    sql: total_cents
    type: sum
    description: Total GMV in cents
joins:
  - target_entity: Customers
    relationship: many_to_one
    join_columns:
      from: customer_id
      to: id
    description: Each order belongs to one customer
use_cases:
  - GMV and revenue analysis
query_patterns:
  - name: monthly_gmv
    description: Monthly GMV trend
    sql: |-
      SELECT TO_CHAR(created_at, 'YYYY-MM') AS order_month,
             SUM(total_cents) / 100.0 AS gmv_dollars
      FROM orders
      WHERE status != 'cancelled'
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
`,
  },
  {
    path: "entities/customers.yml",
    content: `name: Customers
type: fact_table
table: customers
description: One row per registered customer.
dimensions:
  - name: id
    sql: id
    type: number
    primary_key: true
  - name: email
    sql: email
    type: string
`,
  },
  {
    path: "glossary.yml",
    content: `terms:
  GMV:
    status: defined
    definition: >
      Gross Merchandise Value. Total value of all orders before refunds.
    tables:
      - orders
  revenue:
    status: ambiguous
    note: >
      Could mean gross revenue, net revenue, or seller revenue. ASK the user
      which definition they mean.
    possible_mappings:
      - orders.total_cents
      - payments.amount_cents
`,
  },
  {
    path: "metrics/revenue.yml",
    content: `metrics:
  - id: total_gmv
    label: Total GMV
    description: >
      Gross Merchandise Value - total value of all non-cancelled orders.
    type: atomic
    unit: USD
    source:
      entity: Orders
      measure: total_gmv_cents
    sql: |-
      SELECT SUM(total_cents) / 100.0 AS total_gmv
      FROM orders
      WHERE status != 'cancelled'
    aggregation: sum
    objective: maximize
`,
  },
  {
    path: "catalog.yml",
    content: `version: 1
name: ecommerce
description: Demo e-commerce semantic layer.
entities:
  - name: Orders
    file: entities/orders.yml
  - name: Customers
    file: entities/customers.yml
glossary: glossary.yml
metrics:
  - file: metrics/revenue.yml
    description: Revenue metrics.
`,
  },
];
