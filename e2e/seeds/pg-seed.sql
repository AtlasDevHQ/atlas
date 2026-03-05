-- Minimal PostgreSQL seed for E2E tests.
-- Creates a test_orders table with sample data.

CREATE TABLE IF NOT EXISTS test_orders (
  id SERIAL PRIMARY KEY,
  customer_name VARCHAR(100) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO test_orders (customer_name, amount, status, created_at) VALUES
  ('Alice', 150.00, 'completed', '2025-01-15'),
  ('Bob', 250.00, 'completed', '2025-02-01'),
  ('Charlie', 75.50, 'pending', '2025-03-10'),
  ('Diana', 320.00, 'completed', '2025-03-15'),
  ('Eve', 99.99, 'cancelled', '2025-04-01');
