-- Multi-env tracer seed — dev environment.
-- 10 customers, 5 orders. Schema matches staging; row counts differ.
-- Divergence is the whole point: identical seeds across envs would let a
-- routing bug pass as a false green.

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
SELECT 'dev-' || i || '@example.test'
FROM generate_series(1, 10) AS i;

INSERT INTO orders (customer_id, total_cents)
SELECT (i % 10) + 1, (i * 137) % 5000 + 100
FROM generate_series(1, 5) AS i;
