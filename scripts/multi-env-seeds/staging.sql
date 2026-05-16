-- Multi-env tracer seed — staging environment.
-- 100 customers, 50 orders. Same shape as dev — divergence is row count.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  total_cents  INTEGER NOT NULL,
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO customers (email)
SELECT 'staging-' || i || '@example.test'
FROM generate_series(1, 100) AS i;

INSERT INTO orders (customer_id, total_cents)
SELECT (i % 100) + 1, (i * 137) % 5000 + 100
FROM generate_series(1, 50) AS i;
