-- Multi-env tracer seed — prod environment.
-- 1000 customers, 500 orders, plus a vip_tier column that dev/staging
-- don't have. Schema divergence catches the case where a query written
-- against prod silently succeeds against staging by referencing only
-- shared columns — the explicit `vip_tier` probe in the e2e suite
-- ensures the env picker is honest.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  vip_tier    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  total_cents  INTEGER NOT NULL,
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO customers (email, vip_tier)
SELECT
  'prod-' || i || '@example.test',
  CASE WHEN i % 50 = 0 THEN 'gold'
       WHEN i % 10 = 0 THEN 'silver'
       ELSE NULL
  END
FROM generate_series(1, 1000) AS i;

INSERT INTO orders (customer_id, total_cents)
SELECT (i % 1000) + 1, (i * 137) % 50000 + 1000
FROM generate_series(1, 500) AS i;
