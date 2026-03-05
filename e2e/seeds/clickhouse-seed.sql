-- Minimal ClickHouse seed for E2E tests.
-- Creates a test_orders table with sample data.

CREATE TABLE IF NOT EXISTS test_orders (
  id UInt32,
  customer_name String,
  amount Decimal(10, 2),
  status String DEFAULT 'pending',
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY id;

INSERT INTO test_orders (id, customer_name, amount, status, created_at) VALUES
  (1, 'Alice', 150.00, 'completed', '2025-01-15 00:00:00'),
  (2, 'Bob', 250.00, 'completed', '2025-02-01 00:00:00'),
  (3, 'Charlie', 75.50, 'pending', '2025-03-10 00:00:00'),
  (4, 'Diana', 320.00, 'completed', '2025-03-15 00:00:00'),
  (5, 'Eve', 99.99, 'cancelled', '2025-04-01 00:00:00');
