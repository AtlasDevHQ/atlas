# Demo Dataset

> **Note:** This file is a stub. The canonical user-facing reference for the demo dataset lives in [`apps/docs/content/docs/getting-started/demo-datasets.mdx`](../../apps/docs/content/docs/getting-started/demo-datasets.mdx) and is published at <https://docs.useatlas.dev/getting-started/demo-datasets>.

Atlas ships a single canonical demo dataset since 1.4.0 ([#2021](https://github.com/AtlasDevHQ/atlas/issues/2021)): **NovaMart**, a direct-to-consumer e-commerce brand with 13 entities (orders, products, customers, payments, returns, shipments, sellers, …), 52 tables total, ~480K rows.

Earlier releases shipped three seeds (`simple` / `cybersec` / `ecommerce`); the multi-seed picker (originally [#1188](https://github.com/AtlasDevHQ/atlas/issues/1188)) was reverted in 1.4.0. The `--seed` flag was removed; `--demo cybersec` and `--demo simple` now error with a migration message.

For schema overview, canonical questions, tech-debt patterns, and schema-evolution artifacts, see the published docs page linked above.
