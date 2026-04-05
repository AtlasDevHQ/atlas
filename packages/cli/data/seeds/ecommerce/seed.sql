-- ==========================================================================
-- NovaMart — E-commerce DTC Brand Demo Database (PostgreSQL)
-- ==========================================================================
-- ~52 tables, ~480K rows. Realistic tech debt patterns:
--   1. Abandoned/legacy tables (4 tables nobody reads)
--   2. Schema evolution artifacts (columns that changed meaning)
--   3. Missing/wrong constraints (logical FKs without DB constraints)
--   4. Denormalization & duplication (reporting tables, copied columns)
--
-- Company: NovaMart — DTC home goods brand (bedding, kitchen, bath, outdoor)
-- Founded 2020 (pandemic), launched marketplace 2022.
-- Time span: 2020–2025 (pandemic boom → normalization)
--
-- Usage:  psql $ATLAS_DATASOURCE_URL -f data/ecommerce.sql
-- Reset:  bun run db:reset  (nukes volume, re-seeds)
-- ==========================================================================

BEGIN;
SELECT setseed(0.57);  -- reproducible random data (different from cybersec 0.42)

-- ==========================================================================
-- DROP (safe re-run)
-- ==========================================================================
DROP TABLE IF EXISTS payment_methods_backup CASCADE;
DROP TABLE IF EXISTS legacy_analytics_events CASCADE;
DROP TABLE IF EXISTS temp_product_import_2023 CASCADE;
DROP TABLE IF EXISTS old_orders_v1 CASCADE;
DROP TABLE IF EXISTS system_settings CASCADE;
DROP TABLE IF EXISTS admin_audit_log CASCADE;
DROP TABLE IF EXISTS admin_users CASCADE;
DROP TABLE IF EXISTS search_queries CASCADE;
DROP TABLE IF EXISTS cart_events CASCADE;
DROP TABLE IF EXISTS page_views CASCADE;
DROP TABLE IF EXISTS customer_ltv_cache CASCADE;
DROP TABLE IF EXISTS product_performance_cache CASCADE;
DROP TABLE IF EXISTS orders_denormalized CASCADE;
DROP TABLE IF EXISTS monthly_revenue_summary CASCADE;
DROP TABLE IF EXISTS daily_sales_summary CASCADE;
DROP TABLE IF EXISTS review_helpfulness CASCADE;
DROP TABLE IF EXISTS review_responses CASCADE;
DROP TABLE IF EXISTS product_reviews CASCADE;
DROP TABLE IF EXISTS utm_tracking CASCADE;
DROP TABLE IF EXISTS email_sends CASCADE;
DROP TABLE IF EXISTS email_campaigns CASCADE;
DROP TABLE IF EXISTS promotion_usages CASCADE;
DROP TABLE IF EXISTS promotions CASCADE;
DROP TABLE IF EXISTS return_items CASCADE;
DROP TABLE IF EXISTS returns CASCADE;
DROP TABLE IF EXISTS shipping_carriers CASCADE;
DROP TABLE IF EXISTS shipment_items CASCADE;
DROP TABLE IF EXISTS shipments CASCADE;
DROP TABLE IF EXISTS gift_card_transactions CASCADE;
DROP TABLE IF EXISTS gift_cards CASCADE;
DROP TABLE IF EXISTS refunds CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS order_events CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS seller_performance CASCADE;
DROP TABLE IF EXISTS seller_payouts CASCADE;
DROP TABLE IF EXISTS seller_applications CASCADE;
DROP TABLE IF EXISTS sellers CASCADE;
DROP TABLE IF EXISTS inventory_levels CASCADE;
DROP TABLE IF EXISTS product_tags CASCADE;
DROP TABLE IF EXISTS product_images CASCADE;
DROP TABLE IF EXISTS product_variants CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS warehouses CASCADE;
DROP TABLE IF EXISTS loyalty_transactions CASCADE;
DROP TABLE IF EXISTS loyalty_accounts CASCADE;
DROP TABLE IF EXISTS customer_segment_assignments CASCADE;
DROP TABLE IF EXISTS customer_segments CASCADE;
DROP TABLE IF EXISTS customer_addresses CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

-- ==========================================================================
-- 1. SCHEMA
-- ==========================================================================

-- ---------- 1.1 Core Commerce ----------

CREATE TABLE customers (
    id              SERIAL PRIMARY KEY,
    email           TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    phone           TEXT,            -- TECH DEBT: original phone column
    mobile_phone    TEXT,            -- TECH DEBT: added 2022, preferred. App uses COALESCE(mobile_phone, phone)
    acquisition_source TEXT,         -- TECH DEBT: case-inconsistent ('Google', 'google', 'GOOGLE', 'organic', 'Organic')
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE customer_addresses (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER,             -- TECH DEBT: NO FK to customers
    label       TEXT DEFAULT 'home',
    street      TEXT NOT NULL,
    city        TEXT NOT NULL,
    state       TEXT,
    zip         TEXT,
    country     TEXT NOT NULL DEFAULT 'US',
    is_default  BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_segments (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_segment_assignments (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    segment_id   INTEGER NOT NULL REFERENCES customer_segments(id),
    segment_name TEXT,               -- TECH DEBT: denormalized from customer_segments.name, sometimes out of sync
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_accounts (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    points       INTEGER NOT NULL DEFAULT 0,
    tier         TEXT,               -- TECH DEBT: case-inconsistent ('Gold','gold','GOLD','Silver','silver')
    enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_transactions (
    id                SERIAL PRIMARY KEY,
    loyalty_account_id INTEGER NOT NULL REFERENCES loyalty_accounts(id),
    type              TEXT NOT NULL,   -- 'earn', 'redeem', 'adjust', 'expire'
    points            INTEGER NOT NULL,
    description       TEXT,
    order_id          INTEGER,         -- reference only, no FK
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.2 Product Catalog ----------

CREATE TABLE categories (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_id   INTEGER REFERENCES categories(id),
    slug        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
    id       SERIAL PRIMARY KEY,
    name     TEXT NOT NULL,
    code     TEXT NOT NULL UNIQUE,
    city     TEXT NOT NULL,
    state    TEXT NOT NULL,
    country  TEXT NOT NULL DEFAULT 'US',
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE products (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL,
    category_id  INTEGER NOT NULL REFERENCES categories(id),
    seller_id    INTEGER,             -- TECH DEBT: NO FK to sellers (~20% are marketplace products)
    price        NUMERIC(10,2),       -- TECH DEBT: original, in dollars
    price_cents  INTEGER,             -- TECH DEBT: added 2023, in cents. NULL for ~40% of products
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_variants (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    sku         TEXT NOT NULL,
    name        TEXT NOT NULL,        -- e.g. 'Queen / White / Cotton'
    price_cents INTEGER,
    weight_oz   INTEGER,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_images (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    url         TEXT NOT NULL,
    alt_text    TEXT,
    position    INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_tags (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    tag         TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_levels (
    id           SERIAL PRIMARY KEY,
    variant_id   INTEGER,             -- TECH DEBT: NO FK to product_variants
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    quantity     INTEGER NOT NULL DEFAULT 0,
    reorder_point INTEGER DEFAULT 10,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.3 Marketplace ----------

CREATE TABLE sellers (
    id              SERIAL PRIMARY KEY,
    company_name    TEXT NOT NULL,
    contact_email   TEXT NOT NULL,
    commission_rate NUMERIC(4,2) NOT NULL DEFAULT 15.00,
    status          TEXT NOT NULL DEFAULT 'active',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seller_applications (
    id              SERIAL PRIMARY KEY,
    company_name    TEXT NOT NULL,
    contact_email   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at     TIMESTAMPTZ,
    notes           TEXT
);

CREATE TABLE seller_payouts (
    id          SERIAL PRIMARY KEY,
    seller_id   INTEGER NOT NULL REFERENCES sellers(id),
    amount_cents INTEGER NOT NULL,
    period_start DATE NOT NULL,
    period_end   DATE NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    paid_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seller_performance (
    id             SERIAL PRIMARY KEY,
    seller_id      INTEGER NOT NULL REFERENCES sellers(id),
    month          DATE NOT NULL,
    total_orders   INTEGER DEFAULT 0,
    total_revenue_cents INTEGER DEFAULT 0,
    return_rate    NUMERIC(5,2),
    avg_rating     NUMERIC(3,2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.4 Orders & Transactions ----------

CREATE TABLE orders (
    id              SERIAL PRIMARY KEY,
    customer_id     INTEGER NOT NULL REFERENCES customers(id),
    customer_email  TEXT,             -- TECH DEBT: denormalized from customers.email
    status          TEXT NOT NULL DEFAULT 'pending',
    subtotal_cents  INTEGER NOT NULL,
    shipping_cost   NUMERIC(10,2),    -- TECH DEBT: was dollars, now stores cents for orders after 2023-06. Old data NOT migrated
    tax_cents       INTEGER DEFAULT 0,
    total_cents     INTEGER NOT NULL,
    shipping_address_id INTEGER,
    promotion_id    INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id                 SERIAL PRIMARY KEY,
    order_id           INTEGER NOT NULL REFERENCES orders(id),
    product_variant_id INTEGER,        -- TECH DEBT: NO FK to product_variants
    product_name       TEXT NOT NULL,
    quantity           INTEGER NOT NULL DEFAULT 1,
    unit_price_cents   INTEGER NOT NULL,
    total_cents        INTEGER NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_events (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER,               -- TECH DEBT: NO FK to orders
    event_type  TEXT NOT NULL,         -- 'placed','confirmed','processing','shipped','delivered','canceled','returned'
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER,           -- TECH DEBT: NO FK to orders. ~1.5% reference nonexistent orders (orphaned from deleted test orders)
    method          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    amount_cents    INTEGER NOT NULL,
    provider_ref    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
    id           SERIAL PRIMARY KEY,
    payment_id   INTEGER NOT NULL REFERENCES payments(id),
    amount_cents INTEGER NOT NULL,
    reason       TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gift_cards (
    id             SERIAL PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    initial_cents  INTEGER NOT NULL,
    balance_cents  INTEGER NOT NULL,
    issued_to      INTEGER REFERENCES customers(id),
    status         TEXT NOT NULL DEFAULT 'active',
    expires_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gift_card_transactions (
    id           SERIAL PRIMARY KEY,
    gift_card_id INTEGER NOT NULL REFERENCES gift_cards(id),
    order_id     INTEGER,
    amount_cents INTEGER NOT NULL,
    type         TEXT NOT NULL,        -- 'issue', 'redeem', 'refund'
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.5 Shipping & Fulfillment ----------

CREATE TABLE shipping_carriers (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    tracking_url_template TEXT,
    is_active   BOOLEAN DEFAULT true
);

CREATE TABLE shipments (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER NOT NULL REFERENCES orders(id),
    warehouse_id    INTEGER REFERENCES warehouses(id),
    carrier         TEXT,              -- TECH DEBT: original text field ('UPS','FedEx',etc.)
    carrier_id      INTEGER,           -- TECH DEBT: added 2024, logical FK to shipping_carriers (NO CONSTRAINT). NULL for ~60% of older shipments
    tracking_number TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    shipped_at      TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipment_items (
    id           SERIAL PRIMARY KEY,
    shipment_id  INTEGER,              -- TECH DEBT: NO FK to shipments
    order_item_id INTEGER NOT NULL,
    quantity     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE returns (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER NOT NULL REFERENCES orders(id),
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    reason       TEXT,                 -- TECH DEBT: case-inconsistent ('Defective','defective','DEFECTIVE','Wrong Item','wrong_item')
    status       TEXT NOT NULL DEFAULT 'requested',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ
);

CREATE TABLE return_items (
    id              SERIAL PRIMARY KEY,
    return_id       INTEGER NOT NULL REFERENCES returns(id),
    order_item_id   INTEGER NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 1,
    condition       TEXT DEFAULT 'unopened'
);

-- ---------- 1.6 Marketing & Promotions ----------

CREATE TABLE promotions (
    id           SERIAL PRIMARY KEY,
    code         TEXT NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,        -- 'percentage', 'fixed_amount', 'free_shipping', 'bogo'
    value        NUMERIC(10,2),
    min_order_cents INTEGER,
    max_uses     INTEGER,
    times_used   INTEGER DEFAULT 0,
    starts_at    TIMESTAMPTZ NOT NULL,
    ends_at      TIMESTAMPTZ,
    is_active    BOOLEAN DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE promotion_usages (
    id           SERIAL PRIMARY KEY,
    promotion_id INTEGER,              -- TECH DEBT: NO FK to promotions
    order_id     INTEGER,              -- TECH DEBT: NO FK to orders
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    discount_cents INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_campaigns (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    subject      TEXT NOT NULL,
    type         TEXT NOT NULL,        -- 'promotional','transactional','retention','winback'
    status       TEXT NOT NULL DEFAULT 'draft',
    sent_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_sends (
    id           SERIAL PRIMARY KEY,
    campaign_id  INTEGER NOT NULL REFERENCES email_campaigns(id),
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    status       TEXT NOT NULL DEFAULT 'sent',
    opened_at    TIMESTAMPTZ,
    clicked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE utm_tracking (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER,              -- TECH DEBT: NO FK to customers
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    landing_page TEXT,
    order_id     INTEGER,              -- reference only
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.7 Reviews ----------

CREATE TABLE product_reviews (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER NOT NULL REFERENCES products(id),
    customer_id     INTEGER NOT NULL REFERENCES customers(id),
    rating          INTEGER NOT NULL,           -- TECH DEBT: original INTEGER 1-5
    rating_decimal  NUMERIC(3,1),               -- TECH DEBT: added 2024, NULL for ~70% of older reviews
    title           TEXT,
    body            TEXT,
    is_verified     BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE review_responses (
    id          SERIAL PRIMARY KEY,
    review_id   INTEGER NOT NULL REFERENCES product_reviews(id),
    responder   TEXT NOT NULL,         -- 'NovaMart Team' or seller name
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE review_helpfulness (
    id          SERIAL PRIMARY KEY,
    review_id   INTEGER,               -- TECH DEBT: NO FK to product_reviews
    customer_id INTEGER,               -- TECH DEBT: NO FK to customers
    helpful     BOOLEAN NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.8 Reporting / Denormalized ----------

CREATE TABLE daily_sales_summary (
    id              SERIAL PRIMARY KEY,
    sale_date       DATE NOT NULL,
    total_orders    INTEGER DEFAULT 0,
    total_revenue_cents INTEGER DEFAULT 0,
    total_items     INTEGER DEFAULT 0,
    avg_order_value_cents INTEGER DEFAULT 0,
    return_count    INTEGER DEFAULT 0
);

CREATE TABLE monthly_revenue_summary (
    id              SERIAL PRIMARY KEY,
    month           DATE NOT NULL,
    revenue_cents   INTEGER DEFAULT 0,
    order_count     INTEGER DEFAULT 0,
    new_customers   INTEGER DEFAULT 0,
    returning_customers INTEGER DEFAULT 0,
    avg_order_value_cents INTEGER DEFAULT 0
);

CREATE TABLE orders_denormalized (
    id                  SERIAL PRIMARY KEY,
    order_id            INTEGER,
    customer_id         INTEGER,
    customer_name       TEXT,
    customer_email      TEXT,
    order_status        TEXT,
    total_cents         INTEGER,
    item_count          INTEGER,
    first_item_name     TEXT,
    shipping_city       TEXT,
    shipping_state      TEXT,
    created_at          TIMESTAMPTZ
);

CREATE TABLE product_performance_cache (
    id                  SERIAL PRIMARY KEY,
    product_id          INTEGER,
    product_name        TEXT,
    category_name       TEXT,
    total_sold          INTEGER DEFAULT 0,
    total_revenue_cents INTEGER DEFAULT 0,
    avg_rating          NUMERIC(3,2),
    review_count        INTEGER DEFAULT 0,
    return_rate         NUMERIC(5,2),
    calculated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_ltv_cache (
    id                  SERIAL PRIMARY KEY,
    customer_id         INTEGER,
    total_orders        INTEGER DEFAULT 0,
    total_spent_cents   INTEGER DEFAULT 0,
    first_order_at      TIMESTAMPTZ,
    last_order_at       TIMESTAMPTZ,
    avg_order_value_cents INTEGER DEFAULT 0,
    predicted_ltv_cents INTEGER,
    segment             TEXT,
    calculated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.9 Site Analytics ----------

CREATE TABLE page_views (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER,              -- TECH DEBT: NO FK to customers (nullable for anonymous)
    session_id   TEXT,
    page_url     TEXT NOT NULL,
    referrer     TEXT,
    device_type  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cart_events (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER,              -- TECH DEBT: NO FK to customers
    session_id   TEXT,
    event_type   TEXT NOT NULL,        -- 'add', 'remove', 'update_qty', 'abandon'
    product_id   INTEGER,
    variant_id   INTEGER,
    quantity     INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE search_queries (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER,
    session_id   TEXT,
    query        TEXT NOT NULL,
    results_count INTEGER,
    clicked_product_id INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.10 Internal / Ops ----------

CREATE TABLE admin_users (
    id          SERIAL PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    full_name   TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'support',
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_log (
    id           SERIAL PRIMARY KEY,
    admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
    action       TEXT NOT NULL,
    resource_type TEXT,
    resource_id  TEXT,
    details      TEXT,
    ip_address   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE system_settings (
    id          SERIAL PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 1.11 Legacy & Abandoned ----------

CREATE TABLE old_orders_v1 (
    id              SERIAL PRIMARY KEY,
    cust_email      TEXT,              -- different name than customer_id
    order_total     NUMERIC(10,2),     -- different: dollars, not cents
    order_status    TEXT,              -- different values than current orders.status
    item_list       TEXT,              -- CSV of items in a single text field
    placed_date     TIMESTAMPTZ,       -- different name than created_at
    shipped_date    TIMESTAMPTZ
);

CREATE TABLE temp_product_import_2023 (
    id              SERIAL PRIMARY KEY,
    import_name     TEXT,
    import_sku      TEXT,
    import_price    TEXT,              -- stored as text, not numeric
    import_category TEXT,
    raw_csv_line    TEXT,
    imported_at     TIMESTAMPTZ DEFAULT '2023-09-15'::timestamptz
);

CREATE TABLE legacy_analytics_events (
    id              SERIAL PRIMARY KEY,
    event_name      TEXT,              -- different from page_views/cart_events structure
    event_data      TEXT,              -- JSON-as-text blob
    user_ref        TEXT,              -- string user reference, not integer FK
    page_url        TEXT,
    timestamp       TIMESTAMPTZ        -- different column name than created_at
);

CREATE TABLE payment_methods_backup (
    id              SERIAL PRIMARY KEY,
    cust_id         INTEGER,           -- old column name, doesn't match customers.id range
    card_type       TEXT,              -- 'visa','mastercard','amex' — different from payments.method
    last_four       TEXT,
    exp_month       INTEGER,
    exp_year        INTEGER,
    is_primary      BOOLEAN DEFAULT false,
    created_date    TIMESTAMPTZ        -- different name than created_at
);


-- ==========================================================================
-- 2. INDEXES
-- ==========================================================================

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_created ON customers(created_at);
CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX idx_customer_segment_assignments_customer ON customer_segment_assignments(customer_id);
CREATE INDEX idx_loyalty_accounts_customer ON loyalty_accounts(customer_id);
CREATE INDEX idx_loyalty_transactions_account ON loyalty_transactions(loyalty_account_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_seller ON products(seller_id);
CREATE INDEX idx_product_variants_product ON product_variants(product_id);
CREATE INDEX idx_inventory_levels_variant ON inventory_levels(variant_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_events_order ON order_events(order_id);
CREATE INDEX idx_order_events_created ON order_events(created_at);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_shipments_order ON shipments(order_id);
CREATE INDEX idx_shipment_items_shipment ON shipment_items(shipment_id);
CREATE INDEX idx_returns_order ON returns(order_id);
CREATE INDEX idx_promotions_code ON promotions(code);
CREATE INDEX idx_email_sends_campaign ON email_sends(campaign_id);
CREATE INDEX idx_email_sends_customer ON email_sends(customer_id);
CREATE INDEX idx_utm_tracking_customer ON utm_tracking(customer_id);
CREATE INDEX idx_product_reviews_product ON product_reviews(product_id);
CREATE INDEX idx_review_helpfulness_review ON review_helpfulness(review_id);
CREATE INDEX idx_page_views_customer ON page_views(customer_id);
CREATE INDEX idx_page_views_created ON page_views(created_at);
CREATE INDEX idx_cart_events_customer ON cart_events(customer_id);
CREATE INDEX idx_search_queries_created ON search_queries(created_at);
CREATE INDEX idx_admin_audit_log_admin ON admin_audit_log(admin_user_id);
CREATE INDEX idx_admin_audit_log_created ON admin_audit_log(created_at);
CREATE INDEX idx_orders_denormalized_order ON orders_denormalized(order_id);
CREATE INDEX idx_orders_denormalized_created ON orders_denormalized(created_at);


-- ==========================================================================
-- 3. REFERENCE DATA
-- ==========================================================================

-- ---------- Categories (25, hierarchical) ----------
INSERT INTO categories (name, parent_id, slug, description) VALUES
    ('Bedding',     NULL, 'bedding',     'Sheets, duvets, pillows, mattress toppers'),
    ('Kitchen',     NULL, 'kitchen',     'Cookware, utensils, storage, appliances'),
    ('Bath',        NULL, 'bath',        'Towels, shower curtains, bath accessories'),
    ('Outdoor',     NULL, 'outdoor',     'Patio furniture, planters, outdoor decor'),
    ('Home Decor',  NULL, 'home-decor',  'Candles, art, mirrors, rugs');

INSERT INTO categories (name, parent_id, slug, description) VALUES
    ('Sheets',           1, 'bedding-sheets',          'Flat sheets, fitted sheets, sheet sets'),
    ('Duvets & Covers',  1, 'bedding-duvets',          'Duvet inserts and covers'),
    ('Pillows',          1, 'bedding-pillows',          'Sleeping pillows and shams'),
    ('Mattress Toppers', 1, 'bedding-toppers',          'Memory foam and down toppers'),
    ('Cookware',         2, 'kitchen-cookware',         'Pots, pans, skillets'),
    ('Utensils',         2, 'kitchen-utensils',         'Spatulas, tongs, whisks'),
    ('Storage',          2, 'kitchen-storage',          'Containers, organizers, pantry'),
    ('Small Appliances', 2, 'kitchen-appliances',       'Blenders, toasters, coffee makers'),
    ('Towels',           3, 'bath-towels',              'Bath towels, hand towels, washcloths'),
    ('Shower',           3, 'bath-shower',              'Curtains, caddies, mats'),
    ('Accessories',      3, 'bath-accessories',         'Soap dispensers, mirrors, organizers'),
    ('Patio Furniture',  4, 'outdoor-patio',            'Tables, chairs, loungers'),
    ('Planters',         4, 'outdoor-planters',         'Pots, window boxes, stands'),
    ('Outdoor Decor',    4, 'outdoor-decor',            'Lights, rugs, cushions'),
    ('Candles',          5, 'decor-candles',            'Scented, decorative, candle holders'),
    ('Wall Art',         5, 'decor-wall-art',           'Prints, frames, tapestries'),
    ('Rugs',             5, 'decor-rugs',               'Area rugs, runners, mats'),
    ('Mirrors',          5, 'decor-mirrors',            'Wall mirrors, floor mirrors, vanity'),
    ('Throws & Blankets',1, 'bedding-throws',           'Throw blankets and weighted blankets'),
    ('Knife Sets',       2, 'kitchen-knives',           'Chef knives, knife blocks, sharpeners');

-- ---------- Warehouses (5) ----------
INSERT INTO warehouses (name, code, city, state, country) VALUES
    ('East Coast Hub',      'EC1', 'Edison',       'NJ', 'US'),
    ('West Coast Hub',      'WC1', 'Ontario',      'CA', 'US'),
    ('Central Warehouse',   'CW1', 'Louisville',   'KY', 'US'),
    ('Southeast Fulfillment','SE1', 'Atlanta',     'GA', 'US'),
    ('Pacific Northwest',   'PNW', 'Portland',     'OR', 'US');

-- ---------- Shipping Carriers (8) ----------
INSERT INTO shipping_carriers (name, code, tracking_url_template, is_active) VALUES
    ('UPS',              'UPS',   'https://www.ups.com/track?tracknum={tracking}',    true),
    ('FedEx',            'FEDEX', 'https://www.fedex.com/fedextrack/?tracknumbers={tracking}', true),
    ('USPS',             'USPS',  'https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking}', true),
    ('DHL',              'DHL',   'https://www.dhl.com/us-en/home/tracking.html?tracking-id={tracking}', true),
    ('OnTrac',           'ONTRC', 'https://www.ontrac.com/tracking.asp?tracking={tracking}', true),
    ('Amazon Logistics', 'AMZL',  NULL, true),
    ('LaserShip',        'LASER', NULL, true),
    ('Veho',             'VEHO',  NULL, false);

-- ---------- Customer Segments (10) ----------
INSERT INTO customer_segments (name, description) VALUES
    ('VIP',          'Top spenders, >$1000 lifetime value'),
    ('Regular',      'Active customers with 3+ orders'),
    ('New',          'First order within last 90 days'),
    ('At-Risk',      'No orders in last 180 days'),
    ('Churned',      'No orders in last 365 days'),
    ('High-Value',   'Average order value >$150'),
    ('Bargain',      'Primarily uses promo codes'),
    ('Marketplace',  'Primarily buys from marketplace sellers'),
    ('Loyal',        'Enrolled in loyalty program, active'),
    ('Dormant',      'Has account but never ordered');


-- ==========================================================================
-- 4. CORE ENTITY DATA
-- ==========================================================================

-- ---------- Customers (8,000) ----------
INSERT INTO customers (email, full_name, phone, mobile_phone, acquisition_source, created_at, is_active)
SELECT
    lower(first) || '.' || lower(last) || floor(random() * 1000)::int || '@' ||
        (ARRAY['gmail.com','yahoo.com','outlook.com','icloud.com','hotmail.com','protonmail.com','aol.com','mail.com'])[1 + floor(random() * 8)::int],
    first || ' ' || last,
    -- TECH DEBT: phone is original column, always populated
    '(' || (200 + floor(random() * 800)::int) || ') ' || lpad(floor(random() * 1000)::int::text, 3, '0') || '-' || lpad(floor(random() * 10000)::int::text, 4, '0'),
    -- TECH DEBT: mobile_phone added 2022, NULL for ~15% of all customers (~79% are post-2022)
    CASE WHEN created_ts > '2022-01-01'::timestamptz OR random() < 0.3
        THEN '+1' || (200 + floor(random() * 800)::int) || lpad(floor(random() * 10000000)::int::text, 7, '0')
        ELSE NULL
    END,
    -- TECH DEBT: case-inconsistent acquisition_source
    (ARRAY[
        'Google','Google','Google','google','GOOGLE',
        'Facebook','Facebook','facebook',
        'Instagram','instagram',
        'Organic','organic','ORGANIC',
        'Referral','referral',
        'Email','email',
        'TikTok','tiktok',
        'Direct','direct'
    ])[1 + floor(random() * 21)::int],
    created_ts,
    CASE WHEN random() < 0.92 THEN true ELSE false END
FROM (
    SELECT
        g,
        (ARRAY['Emma','Liam','Olivia','Noah','Ava','William','Sophia','James','Isabella','Oliver',
               'Mia','Benjamin','Charlotte','Elijah','Amelia','Lucas','Harper','Mason','Evelyn','Logan',
               'Luna','Alexander','Ella','Daniel','Chloe','Henry','Penelope','Sebastian','Layla','Jack',
               'Riley','Aiden','Zoey','Owen','Nora','Samuel','Lily','Jacob','Eleanor','David'])[1 + floor(random() * 40)::int] AS first,
        (ARRAY['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
               'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
               'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson',
               'Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores'])[1 + floor(random() * 40)::int] AS last,
        -- Pandemic-era founding: more customers in 2020-2021
        '2020-01-15'::timestamptz + (power(random(), 0.6) * interval '1825 days') AS created_ts
    FROM generate_series(1, 8000) AS g
) AS src;

-- ---------- Customer Addresses (12,000) ----------
INSERT INTO customer_addresses (customer_id, label, street, city, state, zip, country, is_default, created_at)
SELECT
    -- TECH DEBT: ~2% reference nonexistent customer IDs
    CASE
        WHEN g <= 11760 THEN 1 + floor(random() * 8000)::int
        ELSE 8001 + floor(random() * 500)::int
    END,
    (ARRAY['home','home','home','work','work','other'])[1 + floor(random() * 6)::int],
    floor(random() * 9999 + 1)::int || ' ' ||
        (ARRAY['Oak','Maple','Cedar','Pine','Elm','Willow','Birch','Walnut','Main','Park',
               'Lake','River','Hill','Meadow','Spring','Valley','Sunset','Harbor','Forest','Garden'])[1 + floor(random() * 20)::int]
        || ' ' ||
        (ARRAY['St','Ave','Blvd','Dr','Ln','Way','Ct','Pl','Rd','Cir'])[1 + floor(random() * 10)::int],
    (ARRAY['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','San Diego',
           'Dallas','Austin','Jacksonville','San Francisco','Columbus','Charlotte','Indianapolis',
           'Seattle','Denver','Nashville','Portland','Las Vegas'])[1 + floor(random() * 20)::int],
    (ARRAY['NY','CA','IL','TX','AZ','PA','TX','CA','TX','TX','FL','CA','OH','NC','IN',
           'WA','CO','TN','OR','NV'])[1 + floor(random() * 20)::int],
    lpad(floor(random() * 90000 + 10000)::int::text, 5, '0'),
    'US',
    CASE WHEN g % 3 = 0 THEN true ELSE false END,
    '2020-01-15'::timestamptz + (random() * interval '1825 days')
FROM generate_series(1, 12000) AS g;

-- ---------- Customer Segment Assignments (9,000) ----------
INSERT INTO customer_segment_assignments (customer_id, segment_id, segment_name, assigned_at)
SELECT
    1 + floor(random() * 8000)::int,
    seg_id,
    -- TECH DEBT: segment_name denormalized, ~12% out of sync with customer_segments.name
    CASE
        WHEN random() < 0.12 THEN (ARRAY['vip','VIP Customer','regular_customer','new_user','at-risk','high_value','bargain_hunter'])[1 + floor(random() * 7)::int]
        ELSE (SELECT name FROM customer_segments WHERE id = seg_id)
    END,
    '2020-06-01'::timestamptz + (random() * interval '1700 days')
FROM (
    SELECT g, 1 + floor(random() * 10)::int AS seg_id
    FROM generate_series(1, 9000) AS g
) AS src;

-- ---------- Loyalty Accounts (5,500) ----------
INSERT INTO loyalty_accounts (customer_id, points, tier, enrolled_at, updated_at)
SELECT
    1 + floor(random() * 8000)::int,
    floor(random() * 5000)::int,
    -- TECH DEBT: tier with case-inconsistent values
    (ARRAY[
        'Bronze','Bronze','Bronze','Bronze',
        'Silver','Silver','Silver','silver','SILVER',
        'Gold','Gold','gold','GOLD',
        'Platinum','Platinum'
    ])[1 + floor(random() * 15)::int],
    enrolled_ts,
    enrolled_ts + (random() * interval '365 days')
FROM (
    SELECT g, '2020-06-01'::timestamptz + (random() * interval '1700 days') AS enrolled_ts
    FROM generate_series(1, 5500) AS g
) AS src;

-- ---------- Loyalty Transactions (18,000) ----------
INSERT INTO loyalty_transactions (loyalty_account_id, type, points, description, order_id, created_at)
SELECT
    1 + floor(random() * 5500)::int,
    txn_type,
    CASE txn_type
        WHEN 'earn'   THEN floor(random() * 200 + 10)::int
        WHEN 'redeem' THEN -floor(random() * 500 + 50)::int
        WHEN 'adjust' THEN floor(random() * 100 - 50)::int
        WHEN 'expire' THEN -floor(random() * 300 + 100)::int
    END,
    CASE txn_type
        WHEN 'earn'   THEN 'Points earned from order'
        WHEN 'redeem' THEN 'Points redeemed for discount'
        WHEN 'adjust' THEN 'Manual adjustment by admin'
        WHEN 'expire' THEN 'Points expired (12-month policy)'
    END,
    CASE WHEN txn_type IN ('earn','redeem') THEN 1 + floor(random() * 25000)::int ELSE NULL END,
    '2020-09-01'::timestamptz + (power(random(), 0.5) * interval '1700 days')
FROM (
    SELECT g,
        (ARRAY['earn','earn','earn','earn','earn','earn','redeem','redeem','redeem','adjust','expire'])[1 + floor(random() * 11)::int] AS txn_type
    FROM generate_series(1, 18000) AS g
) AS src;


-- ==========================================================================
-- 5. PRODUCT DATA
-- ==========================================================================

-- ---------- Products (800) ----------
INSERT INTO products (name, slug, category_id, seller_id, price, price_cents, description, status, created_at)
SELECT
    product_name,
    lower(replace(replace(product_name, ' ', '-'), '''', '')) || '-' || g,
    1 + floor(random() * 25)::int,
    -- ~20% are marketplace products (seller_id set), TECH DEBT: no FK
    CASE WHEN random() < 0.20 THEN 1 + floor(random() * 80)::int ELSE NULL END,
    price_val,
    -- TECH DEBT: price_cents added 2023, NULL for ~40% of older products
    CASE
        WHEN created_ts > '2023-01-01'::timestamptz THEN (price_val * 100)::int
        WHEN random() < 0.3 THEN (price_val * 100)::int
        ELSE NULL
    END,
    'Premium quality ' || lower(product_name) || ' for your home. Made with sustainable materials.',
    (ARRAY['active','active','active','active','active','active','active','discontinued','draft'])[1 + floor(random() * 9)::int],
    created_ts
FROM (
    SELECT
        g,
        (ARRAY['Egyptian Cotton Sheet Set','Bamboo Pillowcase','Memory Foam Pillow','Linen Duvet Cover',
               'Waffle Weave Blanket','Down Alternative Comforter','Silk Pillowcase','Percale Sheet Set',
               'Cast Iron Skillet','Nonstick Pan Set','Chef Knife','Cutting Board Set',
               'Turkish Bath Towel','Waffle Bath Robe','Shower Caddy','Bath Mat Set',
               'Patio Lounge Chair','Outdoor Planter','Solar String Lights','Ceramic Vase',
               'Soy Candle Set','Wall Print','Area Rug','Throw Pillow',
               'Weighted Blanket','Mattress Topper','Knife Block Set','Spice Rack',
               'Hand Towel Set','Vanity Mirror','Outdoor Cushion','Table Runner'])[1 + floor(random() * 32)::int]
            || ' ' ||
            (ARRAY['Classic','Premium','Luxe','Essential','Heritage','Modern','Artisan','Coastal'])[1 + floor(random() * 8)::int]
        AS product_name,
        round((19.99 + random() * 280)::numeric, 2) AS price_val,
        '2020-01-15'::timestamptz + (power(random(), 0.7) * interval '1825 days') AS created_ts
    FROM generate_series(1, 800) AS g
) AS src;

-- ---------- Product Variants (3,200) ----------
INSERT INTO product_variants (product_id, sku, name, price_cents, weight_oz, is_active, created_at)
SELECT
    product_id,
    'NVM-' || lpad(product_id::text, 4, '0') || '-' || lpad(g::text, 3, '0'),
    size_val || ' / ' || color_val,
    (2999 + floor(random() * 20000))::int,
    (8 + floor(random() * 120))::int,
    CASE WHEN random() < 0.9 THEN true ELSE false END,
    '2020-02-01'::timestamptz + (random() * interval '1800 days')
FROM (
    SELECT
        g,
        ((g - 1) / 4) + 1 AS product_id,
        (ARRAY['Twin','Full','Queen','King','One Size','Small','Medium','Large'])[1 + floor(random() * 8)::int] AS size_val,
        (ARRAY['White','Ivory','Gray','Navy','Sage','Blush','Charcoal','Sand','Ocean','Terracotta'])[1 + floor(random() * 10)::int] AS color_val
    FROM generate_series(1, 3200) AS g
) AS src;

-- ---------- Product Images (4,000) ----------
INSERT INTO product_images (product_id, url, alt_text, position, created_at)
SELECT
    1 + floor(random() * 800)::int,
    'https://cdn.novamart.com/products/' || md5(random()::text) || '.jpg',
    'Product image',
    (g % 5),
    '2020-02-01'::timestamptz + (random() * interval '1800 days')
FROM generate_series(1, 4000) AS g;

-- ---------- Product Tags (2,500) ----------
INSERT INTO product_tags (product_id, tag, created_at)
SELECT
    1 + floor(random() * 800)::int,
    (ARRAY['organic','sustainable','bestseller','new-arrival','sale','eco-friendly','handmade',
           'luxury','trending','limited-edition','bundle','gift-idea','seasonal','clearance','exclusive'])[1 + floor(random() * 15)::int],
    '2020-03-01'::timestamptz + (random() * interval '1800 days')
FROM generate_series(1, 2500) AS g;

-- ---------- Inventory Levels (3,200) ----------
INSERT INTO inventory_levels (variant_id, warehouse_id, quantity, reorder_point, updated_at)
SELECT
    g,   -- TECH DEBT: no FK to product_variants
    1 + floor(random() * 5)::int,
    floor(random() * 200)::int,
    (ARRAY[5, 10, 15, 20, 25])[1 + floor(random() * 5)::int],
    now() - (random() * interval '30 days')
FROM generate_series(1, 3200) AS g;


-- ==========================================================================
-- 6. MARKETPLACE DATA
-- ==========================================================================

-- ---------- Sellers (80) ----------
INSERT INTO sellers (company_name, contact_email, commission_rate, status, joined_at)
SELECT
    seller_name || ' ' || seller_suffix,
    lower(seller_name) || '@' || lower(seller_suffix) || '.com',
    (ARRAY[12.00, 15.00, 15.00, 15.00, 18.00, 20.00])[1 + floor(random() * 6)::int],
    (ARRAY['active','active','active','active','active','active','suspended','pending'])[1 + floor(random() * 8)::int],
    '2022-01-01'::timestamptz + (random() * interval '1095 days')
FROM (
    SELECT
        g,
        (ARRAY['Artisan','Heritage','Pacific','Summit','Golden','Nordic','Urban','Coastal',
               'Evergreen','Sunset','Harvest','Alpine','Terra','Atlas','Bloom'])[((g-1) % 15) + 1] AS seller_name,
        (ARRAY['Home Co','Living','Goods','Craft','Designs','Supply'])[((g-1) / 15) + 1] AS seller_suffix
    FROM generate_series(1, 80) AS g
) AS src;

-- ---------- Seller Applications (120) ----------
INSERT INTO seller_applications (company_name, contact_email, status, applied_at, reviewed_at, notes)
SELECT
    'Applicant Store ' || g,
    'apply' || g || '@seller-app.com',
    (ARRAY['approved','approved','approved','rejected','rejected','pending','pending','pending'])[1 + floor(random() * 8)::int],
    applied_ts,
    CASE WHEN random() < 0.7 THEN applied_ts + (random() * interval '14 days') ELSE NULL END,
    CASE WHEN random() < 0.3 THEN 'Reviewed by marketplace ops team' ELSE NULL END
FROM (
    SELECT g, '2022-01-01'::timestamptz + (random() * interval '1095 days') AS applied_ts
    FROM generate_series(1, 120) AS g
) AS src;


-- ==========================================================================
-- 7. ORDER & TRANSACTION DATA
-- ==========================================================================

-- ---------- Orders (25,000) ----------
-- Pandemic growth curve: 2020 ~2K, 2021 ~6K peak, 2022-2025 normalization
INSERT INTO orders (customer_id, customer_email, status, subtotal_cents, shipping_cost, tax_cents, total_cents, shipping_address_id, promotion_id, created_at)
SELECT
    cust_id,
    -- TECH DEBT: denormalized customer_email
    (SELECT email FROM customers WHERE id = cust_id),
    (ARRAY['delivered','delivered','delivered','delivered','delivered','delivered',
           'shipped','shipped','processing','confirmed','pending','canceled','returned'])[1 + floor(random() * 13)::int],
    subtotal,
    -- TECH DEBT: shipping_cost in dollars pre-2023-06, cents after. Old data NOT migrated
    CASE
        WHEN order_ts < '2023-06-01'::timestamptz THEN round((random() * 15 + 5)::numeric, 2)
        ELSE round((random() * 1500 + 500)::numeric, 2)  -- cents (5.00-20.00 in cents = 500-2000)
    END,
    floor(subtotal * 0.08)::int,
    subtotal + floor(subtotal * 0.08)::int + floor(random() * 1500 + 500)::int,  -- TECH DEBT: shipping component is independent of shipping_cost column (totals don't reconcile)
    CASE WHEN random() < 0.8 THEN 1 + floor(random() * 12000)::int ELSE NULL END,
    CASE WHEN random() < 0.15 THEN 1 + floor(random() * 200)::int ELSE NULL END,
    order_ts
FROM (
    SELECT
        g,
        1 + floor(random() * 8000)::int AS cust_id,
        (3000 + floor(random() * 25000))::int AS subtotal,
        -- Pandemic growth curve
        CASE
            WHEN g <= 2000  THEN '2020-03-01'::timestamptz + (random() * interval '305 days')
            WHEN g <= 8000  THEN '2021-01-01'::timestamptz + (random() * interval '365 days')
            WHEN g <= 13000 THEN '2022-01-01'::timestamptz + (random() * interval '365 days')
            WHEN g <= 18000 THEN '2023-01-01'::timestamptz + (random() * interval '365 days')
            WHEN g <= 22500 THEN '2024-01-01'::timestamptz + (random() * interval '365 days')
            ELSE                 '2025-01-01'::timestamptz + (random() * interval '56 days')
        END AS order_ts
    FROM generate_series(1, 25000) AS g
) AS src;

-- ---------- Order Items (55,000) ----------
INSERT INTO order_items (order_id, product_variant_id, product_name, quantity, unit_price_cents, total_cents, created_at)
SELECT
    order_id,
    -- TECH DEBT: no FK to product_variants
    1 + floor(random() * 3200)::int,
    (ARRAY['Egyptian Cotton Sheet Set','Bamboo Pillowcase','Memory Foam Pillow','Linen Duvet Cover',
           'Cast Iron Skillet','Nonstick Pan Set','Turkish Bath Towel','Waffle Bath Robe',
           'Patio Lounge Chair','Soy Candle Set','Area Rug','Throw Pillow',
           'Weighted Blanket','Mattress Topper','Chef Knife','Cutting Board Set',
           'Solar String Lights','Ceramic Vase','Wall Print','Hand Towel Set'])[1 + floor(random() * 20)::int],
    qty,
    unit_price,
    unit_price * qty,
    '2020-03-01'::timestamptz + (power(g::float / 55000, 1.0) * interval '1795 days')
FROM (
    SELECT
        g,
        1 + floor(random() * 25000)::int AS order_id,
        (ARRAY[1,1,1,1,1,1,2,2,3])[1 + floor(random() * 9)::int] AS qty,
        (1999 + floor(random() * 15000))::int AS unit_price
    FROM generate_series(1, 55000) AS g
) AS src;

-- ---------- Order Events (60,000) ----------
INSERT INTO order_events (order_id, event_type, description, created_at)
SELECT
    -- TECH DEBT: no FK to orders
    1 + floor(random() * 25000)::int,
    (ARRAY['placed','placed','confirmed','confirmed','processing','processing',
           'shipped','shipped','shipped','delivered','delivered','delivered',
           'canceled','returned'])[1 + floor(random() * 14)::int],
    (ARRAY['Order placed by customer','Payment confirmed','Order sent to fulfillment',
           'Shipped via carrier','Out for delivery','Delivered to customer',
           'Canceled by customer','Return initiated','Refund processed'])[1 + floor(random() * 9)::int],
    '2020-03-01'::timestamptz + (power(g::float / 60000, 1.0) * interval '1795 days')
FROM generate_series(1, 60000) AS g;

-- ---------- Payments (26,000) ----------
INSERT INTO payments (order_id, method, status, amount_cents, provider_ref, created_at)
SELECT
    -- TECH DEBT: ~1.5% reference nonexistent orders (orphaned from deleted test orders)
    CASE
        WHEN g <= 25610 THEN 1 + floor(random() * 25000)::int
        ELSE 25001 + floor(random() * 500)::int
    END,
    (ARRAY['credit_card','credit_card','credit_card','credit_card','debit_card','debit_card',
           'paypal','paypal','apple_pay','google_pay','gift_card','klarna'])[1 + floor(random() * 12)::int],
    (ARRAY['completed','completed','completed','completed','completed','completed','completed',
           'pending','failed','refunded'])[1 + floor(random() * 10)::int],
    (3000 + floor(random() * 30000))::int,
    'pay_' || md5(random()::text || g::text),
    '2020-03-01'::timestamptz + (power(g::float / 26000, 1.0) * interval '1795 days')
FROM generate_series(1, 26000) AS g;

-- ---------- Refunds (2,500) ----------
INSERT INTO refunds (payment_id, amount_cents, reason, status, created_at)
SELECT
    1 + floor(random() * 26000)::int,
    (1000 + floor(random() * 15000))::int,
    (ARRAY['Defective product','Wrong item shipped','Changed mind','Item not as described',
           'Late delivery','Duplicate order','Quality issue','Better price found'])[1 + floor(random() * 8)::int],
    (ARRAY['completed','completed','completed','completed','pending','processing','denied'])[1 + floor(random() * 7)::int],
    '2020-06-01'::timestamptz + (power(random(), 0.5) * interval '1700 days')
FROM generate_series(1, 2500) AS g;

-- ---------- Gift Cards (500) ----------
INSERT INTO gift_cards (code, initial_cents, balance_cents, issued_to, status, expires_at, created_at)
SELECT
    'NVM-' || upper(substr(md5(random()::text), 1, 4)) || '-' || upper(substr(md5(random()::text), 1, 4)),
    initial,
    CASE WHEN random() < 0.3 THEN 0 ELSE floor(initial * random())::int END,
    CASE WHEN random() < 0.7 THEN 1 + floor(random() * 8000)::int ELSE NULL END,
    (ARRAY['active','active','active','active','redeemed','expired','disabled'])[1 + floor(random() * 7)::int],
    CASE WHEN random() < 0.8 THEN now() + (random() * interval '365 days') ELSE now() - (random() * interval '180 days') END,
    '2020-06-01'::timestamptz + (random() * interval '1700 days')
FROM (
    SELECT g, (ARRAY[2500, 5000, 7500, 10000, 15000, 25000])[1 + floor(random() * 6)::int] AS initial
    FROM generate_series(1, 500) AS g
) AS src;

-- ---------- Gift Card Transactions (1,200) ----------
INSERT INTO gift_card_transactions (gift_card_id, order_id, amount_cents, type, created_at)
SELECT
    1 + floor(random() * 500)::int,
    CASE WHEN txn_type IN ('redeem','refund') THEN 1 + floor(random() * 25000)::int ELSE NULL END,
    (ARRAY[2500, 5000, 1000, 3000, 7500])[1 + floor(random() * 5)::int],
    txn_type,
    '2020-09-01'::timestamptz + (random() * interval '1700 days')
FROM (
    SELECT g, (ARRAY['issue','issue','redeem','redeem','redeem','refund'])[1 + floor(random() * 6)::int] AS txn_type
    FROM generate_series(1, 1200) AS g
) AS src;


-- ==========================================================================
-- 8. SHIPPING & FULFILLMENT DATA
-- ==========================================================================

-- ---------- Shipments (22,000) ----------
INSERT INTO shipments (order_id, warehouse_id, carrier, carrier_id, tracking_number, status, shipped_at, delivered_at, created_at)
SELECT
    1 + floor(random() * 25000)::int,
    1 + floor(random() * 5)::int,
    -- TECH DEBT: carrier text always populated
    (ARRAY['UPS','UPS','FedEx','FedEx','USPS','USPS','DHL','OnTrac'])[1 + floor(random() * 8)::int],
    -- TECH DEBT: carrier_id added 2024, NULL for ~60% of older shipments
    CASE
        WHEN ship_ts > '2024-01-01'::timestamptz THEN 1 + floor(random() * 8)::int
        WHEN random() < 0.15 THEN 1 + floor(random() * 8)::int
        ELSE NULL
    END,
    'NVM' || upper(substr(md5(random()::text), 1, 12)),
    (ARRAY['delivered','delivered','delivered','delivered','delivered','delivered',
           'in_transit','in_transit','shipped','pending','returned'])[1 + floor(random() * 11)::int],
    ship_ts,
    CASE WHEN random() < 0.85 THEN ship_ts + ((2 + random() * 8) * interval '1 day') ELSE NULL END,
    ship_ts - (random() * interval '2 days')
FROM (
    SELECT
        g,
        '2020-03-15'::timestamptz + (power(g::float / 22000, 1.0) * interval '1780 days') AS ship_ts
    FROM generate_series(1, 22000) AS g
) AS src;

-- ---------- Shipment Items (48,000) ----------
INSERT INTO shipment_items (shipment_id, order_item_id, quantity)
SELECT
    -- TECH DEBT: no FK to shipments
    1 + floor(random() * 22000)::int,
    1 + floor(random() * 55000)::int,
    (ARRAY[1,1,1,1,1,2,2,3])[1 + floor(random() * 8)::int]
FROM generate_series(1, 48000) AS g;

-- ---------- Returns (3,000) ----------
INSERT INTO returns (order_id, customer_id, reason, status, created_at, resolved_at)
SELECT
    1 + floor(random() * 25000)::int,
    1 + floor(random() * 8000)::int,
    -- TECH DEBT: reason with case-inconsistent values
    (ARRAY[
        'Defective','Defective','defective','DEFECTIVE',
        'Wrong Item','Wrong Item','wrong_item','WRONG ITEM',
        'Not as described','not_as_described',
        'Changed mind','Changed Mind','changed_mind',
        'Too small','Too large',
        'Better price elsewhere','Arrived late'
    ])[1 + floor(random() * 17)::int],
    (ARRAY['requested','approved','approved','approved','completed','completed','completed','denied'])[1 + floor(random() * 8)::int],
    return_ts,
    CASE WHEN random() < 0.7 THEN return_ts + (random() * interval '14 days') ELSE NULL END
FROM (
    SELECT g, '2020-06-01'::timestamptz + (power(random(), 0.5) * interval '1700 days') AS return_ts
    FROM generate_series(1, 3000) AS g
) AS src;

-- ---------- Return Items (4,500) ----------
INSERT INTO return_items (return_id, order_item_id, quantity, condition)
SELECT
    1 + floor(random() * 3000)::int,
    1 + floor(random() * 55000)::int,
    1,
    (ARRAY['unopened','unopened','opened','opened','damaged','defective'])[1 + floor(random() * 6)::int]
FROM generate_series(1, 4500) AS g;


-- ==========================================================================
-- 9. MARKETING & PROMOTIONS DATA
-- ==========================================================================

-- ---------- Promotions (200) ----------
INSERT INTO promotions (code, name, type, value, min_order_cents, max_uses, times_used, starts_at, ends_at, is_active, created_at)
SELECT
    upper(promo_prefix || floor(random() * 100)::int),
    promo_prefix || ' ' || (ARRAY['Sale','Special','Savings','Deal','Offer'])[1 + floor(random() * 5)::int],
    promo_type,
    CASE promo_type
        WHEN 'percentage'    THEN (ARRAY[10, 15, 20, 25, 30])[1 + floor(random() * 5)::int]
        WHEN 'fixed_amount'  THEN (ARRAY[5, 10, 15, 20, 50])[1 + floor(random() * 5)::int]
        WHEN 'free_shipping' THEN 0
        WHEN 'bogo'          THEN 50
    END,
    CASE WHEN random() < 0.6 THEN (ARRAY[2500, 5000, 7500, 10000])[1 + floor(random() * 4)::int] ELSE NULL END,
    CASE WHEN random() < 0.5 THEN (ARRAY[100, 500, 1000, 5000])[1 + floor(random() * 4)::int] ELSE NULL END,
    floor(random() * 500)::int,
    start_ts,
    CASE WHEN random() < 0.7 THEN start_ts + ((7 + floor(random() * 83)) * interval '1 day') ELSE NULL END,
    CASE WHEN random() < 0.3 THEN true ELSE false END,
    start_ts
FROM (
    SELECT
        g,
        (ARRAY['WELCOME','SUMMER','WINTER','SPRING','FALL','FLASH','HOLIDAY','BDAY',
               'VIP','SAVE','DEAL','CLEARANCE','NEW','THANKS','LOYALTY'])[1 + floor(random() * 15)::int] AS promo_prefix,
        (ARRAY['percentage','percentage','percentage','fixed_amount','fixed_amount','free_shipping','bogo'])[1 + floor(random() * 7)::int] AS promo_type,
        '2020-03-01'::timestamptz + (random() * interval '1795 days') AS start_ts
    FROM generate_series(1, 200) AS g
) AS src;

-- ---------- Promotion Usages (8,000) ----------
INSERT INTO promotion_usages (promotion_id, order_id, customer_id, discount_cents, created_at)
SELECT
    -- TECH DEBT: no FK to promotions or orders
    1 + floor(random() * 200)::int,
    1 + floor(random() * 25000)::int,
    1 + floor(random() * 8000)::int,
    (ARRAY[500, 1000, 1500, 2000, 2500, 3000, 5000])[1 + floor(random() * 7)::int],
    '2020-06-01'::timestamptz + (power(random(), 0.5) * interval '1700 days')
FROM generate_series(1, 8000) AS g;

-- ---------- Email Campaigns (50) ----------
INSERT INTO email_campaigns (name, subject, type, status, sent_at, created_at)
SELECT
    campaign_name || ' - ' || g,
    CASE campaign_type
        WHEN 'promotional'  THEN (ARRAY['Dont miss our biggest sale!','New arrivals just dropped','Your exclusive deal inside'])[1 + floor(random() * 3)::int]
        WHEN 'transactional' THEN (ARRAY['Your order has shipped','Welcome to NovaMart','Your receipt'])[1 + floor(random() * 3)::int]
        WHEN 'retention'     THEN (ARRAY['We miss you!','Time for a refresh?','Your points are expiring'])[1 + floor(random() * 3)::int]
        WHEN 'winback'       THEN (ARRAY['Come back for 20% off','Its been a while...','Special offer just for you'])[1 + floor(random() * 3)::int]
    END,
    campaign_type,
    (ARRAY['sent','sent','sent','sent','draft','scheduled'])[1 + floor(random() * 6)::int],
    CASE WHEN random() < 0.8 THEN '2020-06-01'::timestamptz + (random() * interval '1700 days') ELSE NULL END,
    '2020-06-01'::timestamptz + (random() * interval '1700 days')
FROM (
    SELECT
        g,
        (ARRAY['Summer Sale','Winter Clearance','New Arrivals','Flash Sale','Holiday Special',
               'Welcome Series','Loyalty Reward','Re-engagement','Anniversary','VIP Preview'])[1 + floor(random() * 10)::int] AS campaign_name,
        (ARRAY['promotional','promotional','promotional','transactional','retention','winback'])[1 + floor(random() * 6)::int] AS campaign_type
    FROM generate_series(1, 50) AS g
) AS src;

-- ---------- Email Sends (30,000) ----------
INSERT INTO email_sends (campaign_id, customer_id, status, opened_at, clicked_at, created_at)
SELECT
    1 + floor(random() * 50)::int,
    1 + floor(random() * 8000)::int,
    (ARRAY['delivered','delivered','delivered','delivered','bounced','unsubscribed'])[1 + floor(random() * 6)::int],
    CASE WHEN random() < 0.35 THEN sent_ts + (random() * interval '3 days') ELSE NULL END,
    CASE WHEN random() < 0.12 THEN sent_ts + (random() * interval '3 days') ELSE NULL END,
    sent_ts
FROM (
    SELECT g, '2020-06-01'::timestamptz + (power(random(), 0.5) * interval '1700 days') AS sent_ts
    FROM generate_series(1, 30000) AS g
) AS src;

-- ---------- UTM Tracking (15,000) ----------
INSERT INTO utm_tracking (customer_id, utm_source, utm_medium, utm_campaign, utm_content, landing_page, order_id, created_at)
SELECT
    -- TECH DEBT: no FK to customers
    CASE WHEN random() < 0.7 THEN 1 + floor(random() * 8000)::int ELSE NULL END,
    (ARRAY['google','google','google','facebook','facebook','instagram','instagram',
           'tiktok','email','email','pinterest','bing','twitter'])[1 + floor(random() * 13)::int],
    (ARRAY['cpc','cpc','organic','social','social','email','display','referral'])[1 + floor(random() * 8)::int],
    (ARRAY['summer_sale','winter_clearance','new_arrivals','retargeting','brand_awareness',
           'flash_sale','holiday_2024','spring_launch','loyalty_program','back_to_school'])[1 + floor(random() * 10)::int],
    CASE WHEN random() < 0.5 THEN (ARRAY['hero_banner','sidebar','carousel','popup','footer'])[1 + floor(random() * 5)::int] ELSE NULL END,
    (ARRAY['/','/','/collections/bedding','/collections/kitchen','/collections/bath',
           '/collections/outdoor','/collections/sale','/products/bestseller'])[1 + floor(random() * 8)::int],
    CASE WHEN random() < 0.2 THEN 1 + floor(random() * 25000)::int ELSE NULL END,
    '2020-06-01'::timestamptz + (power(random(), 0.4) * interval '1700 days')
FROM generate_series(1, 15000) AS g;


-- ==========================================================================
-- 10. REVIEWS DATA
-- ==========================================================================

-- ---------- Product Reviews (6,000) ----------
INSERT INTO product_reviews (product_id, customer_id, rating, rating_decimal, title, body, is_verified, created_at)
SELECT
    1 + floor(random() * 800)::int,
    1 + floor(random() * 8000)::int,
    rating_int,
    -- TECH DEBT: rating_decimal added 2024, NULL for ~70% of older reviews
    CASE
        WHEN review_ts > '2024-01-01'::timestamptz THEN rating_int + round((random() * 0.8 - 0.4)::numeric, 1)
        WHEN random() < 0.1 THEN rating_int + round((random() * 0.8 - 0.4)::numeric, 1)
        ELSE NULL
    END,
    (ARRAY['Love it!','Great quality','Just okay','Not what I expected','Perfect for our home',
           'Highly recommend','Good value','Disappointed','Beautiful design','Exceeded expectations',
           'Decent for the price','Amazing product','Would buy again','Meh','Exactly as described'])[1 + floor(random() * 15)::int],
    (ARRAY['This is exactly what I was looking for. Great quality and fast shipping.',
           'The material feels premium and the color is accurate to the photos.',
           'Its okay but not as soft as I expected for the price.',
           'Arrived damaged. Customer service was helpful though.',
           'We bought two of these and love them both. Highly recommend!',
           'Perfect addition to our bedroom. Looks and feels luxurious.',
           'Decent product but the stitching could be better.',
           'Not worth the premium price. You can find similar quality elsewhere.',
           'Bought this as a gift and the recipient loved it.',
           'The color was slightly different from the photo but still nice.'])[1 + floor(random() * 10)::int],
    random() < 0.65,
    review_ts
FROM (
    SELECT
        g,
        (ARRAY[1,2,3,3,4,4,4,5,5,5])[1 + floor(random() * 10)::int] AS rating_int,
        '2020-06-01'::timestamptz + (power(random(), 0.5) * interval '1700 days') AS review_ts
    FROM generate_series(1, 6000) AS g
) AS src;

-- ---------- Review Responses (1,500) ----------
INSERT INTO review_responses (review_id, responder, body, created_at)
SELECT
    1 + floor(random() * 6000)::int,
    CASE WHEN random() < 0.7 THEN 'NovaMart Team' ELSE 'Seller: ' || (ARRAY['Artisan Home Co','Heritage Living','Pacific Goods','Summit Craft'])[1 + floor(random() * 4)::int] END,
    (ARRAY['Thank you for your feedback! We are glad you love it.',
           'We are sorry to hear about your experience. Please reach out to our support team.',
           'Thanks for the kind words! We hope you enjoy it for years to come.',
           'We appreciate your honest review. We have forwarded your feedback to our quality team.',
           'Sorry for the inconvenience. We have issued a replacement.'])[1 + floor(random() * 5)::int],
    '2020-09-01'::timestamptz + (power(random(), 0.5) * interval '1650 days')
FROM generate_series(1, 1500) AS g;

-- ---------- Review Helpfulness (8,000) ----------
INSERT INTO review_helpfulness (review_id, customer_id, helpful, created_at)
SELECT
    -- TECH DEBT: no FK to product_reviews or customers
    1 + floor(random() * 6000)::int,
    1 + floor(random() * 8000)::int,
    random() < 0.75,
    '2020-09-01'::timestamptz + (power(random(), 0.5) * interval '1650 days')
FROM generate_series(1, 8000) AS g;


-- ==========================================================================
-- 11. SITE ANALYTICS DATA
-- ==========================================================================

-- ---------- Page Views (20,000) ----------
INSERT INTO page_views (customer_id, session_id, page_url, referrer, device_type, created_at)
SELECT
    -- TECH DEBT: no FK to customers, nullable for anonymous
    CASE WHEN random() < 0.6 THEN 1 + floor(random() * 8000)::int ELSE NULL END,
    'sess_' || md5(random()::text || g::text),
    (ARRAY['/','/collections/bedding','/collections/kitchen','/collections/bath','/collections/outdoor',
           '/collections/sale','/products/' || floor(random() * 800 + 1)::int,'/cart','/checkout',
           '/account','/account/orders','/search','/about','/contact'])[1 + floor(random() * 14)::int],
    (ARRAY['https://google.com','https://facebook.com','https://instagram.com',
           'https://pinterest.com','https://tiktok.com',NULL,NULL,NULL])[1 + floor(random() * 8)::int],
    (ARRAY['desktop','desktop','desktop','mobile','mobile','mobile','mobile','tablet'])[1 + floor(random() * 8)::int],
    '2021-01-01'::timestamptz + (power(random(), 0.35) * interval '1520 days')
FROM generate_series(1, 20000) AS g;

-- ---------- Cart Events (15,000) ----------
INSERT INTO cart_events (customer_id, session_id, event_type, product_id, variant_id, quantity, created_at)
SELECT
    -- TECH DEBT: no FK to customers
    CASE WHEN random() < 0.7 THEN 1 + floor(random() * 8000)::int ELSE NULL END,
    'sess_' || md5(random()::text || g::text),
    (ARRAY['add','add','add','add','remove','update_qty','abandon','abandon'])[1 + floor(random() * 8)::int],
    1 + floor(random() * 800)::int,
    1 + floor(random() * 3200)::int,
    (ARRAY[1,1,1,1,2,2,3])[1 + floor(random() * 7)::int],
    '2021-01-01'::timestamptz + (power(random(), 0.35) * interval '1520 days')
FROM generate_series(1, 15000) AS g;

-- ---------- Search Queries (5,000) ----------
INSERT INTO search_queries (customer_id, session_id, query, results_count, clicked_product_id, created_at)
SELECT
    CASE WHEN random() < 0.6 THEN 1 + floor(random() * 8000)::int ELSE NULL END,
    'sess_' || md5(random()::text || g::text),
    (ARRAY['sheets','pillow','towel','duvet','blanket','kitchen','bath mat','outdoor',
           'rug','candle','gift','sale','queen sheets','king duvet','bath towel set',
           'throw blanket','cast iron','knife set','planter','mirror'])[1 + floor(random() * 20)::int],
    floor(random() * 50)::int,
    CASE WHEN random() < 0.4 THEN 1 + floor(random() * 800)::int ELSE NULL END,
    '2021-01-01'::timestamptz + (power(random(), 0.35) * interval '1520 days')
FROM generate_series(1, 5000) AS g;


-- ==========================================================================
-- 12. REPORTING / DENORMALIZED TABLES
-- ==========================================================================

-- ---------- Daily Sales Summary (~1,800 days: 2020-03-01 to 2025-02-26) ----------
INSERT INTO daily_sales_summary (sale_date, total_orders, total_revenue_cents, total_items, avg_order_value_cents, return_count)
SELECT
    ('2020-03-01'::date + g),
    order_count,
    order_count * (5000 + floor(random() * 10000))::int,
    order_count * 2,
    (5000 + floor(random() * 10000))::int,
    CASE WHEN random() < 0.3 THEN floor(random() * 5)::int ELSE 0 END
FROM (
    SELECT
        g,
        -- Pandemic curve in daily order count
        CASE
            WHEN g < 305  THEN 3 + floor(random() * 8)::int    -- 2020: low ramp
            WHEN g < 670  THEN 10 + floor(random() * 20)::int  -- 2021: peak
            WHEN g < 1035 THEN 8 + floor(random() * 15)::int   -- 2022: normalization
            WHEN g < 1400 THEN 7 + floor(random() * 12)::int   -- 2023: stable
            WHEN g < 1766 THEN 6 + floor(random() * 10)::int   -- 2024: stable
            ELSE               5 + floor(random() * 8)::int    -- 2025: partial
        END AS order_count
    FROM generate_series(0, 1799) AS g
) AS src;

-- ---------- Monthly Revenue Summary (60 months: 2020-03 to 2025-02) ----------
INSERT INTO monthly_revenue_summary (month, revenue_cents, order_count, new_customers, returning_customers, avg_order_value_cents)
SELECT
    ('2020-03-01'::date + (g * 30)),
    revenue,
    order_count,
    floor(order_count * 0.4)::int,
    floor(order_count * 0.6)::int,
    CASE WHEN order_count > 0 THEN revenue / order_count ELSE 0 END
FROM (
    SELECT
        g,
        -- Pandemic curve
        CASE
            WHEN g < 10 THEN (100 + floor(random() * 200))::int * 10000   -- 2020: ramp
            WHEN g < 22 THEN (300 + floor(random() * 400))::int * 10000   -- 2021: peak
            WHEN g < 34 THEN (200 + floor(random() * 300))::int * 10000   -- 2022: normalize
            WHEN g < 46 THEN (180 + floor(random() * 250))::int * 10000   -- 2023: stable
            WHEN g < 58 THEN (160 + floor(random() * 200))::int * 10000   -- 2024: stable
            ELSE              (140 + floor(random() * 180))::int * 10000   -- 2025: partial
        END AS revenue,
        CASE
            WHEN g < 10 THEN 100 + floor(random() * 200)::int
            WHEN g < 22 THEN 400 + floor(random() * 500)::int
            WHEN g < 34 THEN 300 + floor(random() * 350)::int
            WHEN g < 46 THEN 250 + floor(random() * 300)::int
            WHEN g < 58 THEN 220 + floor(random() * 280)::int
            ELSE              200 + floor(random() * 250)::int
        END AS order_count
    FROM generate_series(0, 59) AS g
) AS src;

-- ---------- Orders Denormalized (25,000) ----------
INSERT INTO orders_denormalized (order_id, customer_id, customer_name, customer_email, order_status, total_cents, item_count, first_item_name, shipping_city, shipping_state, created_at)
SELECT
    o.id,
    o.customer_id,
    c.full_name,
    c.email,
    o.status,
    o.total_cents,
    (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id),
    (SELECT product_name FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1),
    ca.city,
    ca.state,
    o.created_at
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN customer_addresses ca ON ca.id = o.shipping_address_id
LIMIT 25000;

-- ---------- Product Performance Cache (800) ----------
INSERT INTO product_performance_cache (product_id, product_name, category_name, total_sold, total_revenue_cents, avg_rating, review_count, return_rate, calculated_at)
SELECT
    p.id,
    p.name,
    cat.name,
    COALESCE((SELECT sum(oi.quantity) FROM order_items oi WHERE oi.product_name = p.name), 0)::int,
    COALESCE((SELECT sum(oi.total_cents) FROM order_items oi WHERE oi.product_name = p.name), 0)::int,
    COALESCE((SELECT round(avg(pr.rating)::numeric, 2) FROM product_reviews pr WHERE pr.product_id = p.id), NULL),
    COALESCE((SELECT count(*) FROM product_reviews pr WHERE pr.product_id = p.id), 0)::int,
    round((random() * 8)::numeric, 2),
    now() - (random() * interval '7 days')
FROM products p
LEFT JOIN categories cat ON cat.id = p.category_id
LIMIT 800;

-- ---------- Customer LTV Cache (8,000) ----------
INSERT INTO customer_ltv_cache (customer_id, total_orders, total_spent_cents, first_order_at, last_order_at, avg_order_value_cents, predicted_ltv_cents, segment, calculated_at)
SELECT
    c.id,
    COALESCE(order_stats.cnt, 0)::int,
    COALESCE(order_stats.total, 0)::int,
    order_stats.first_at,
    order_stats.last_at,
    CASE WHEN COALESCE(order_stats.cnt, 0) > 0 THEN (order_stats.total / order_stats.cnt)::int ELSE 0 END,
    CASE WHEN COALESCE(order_stats.cnt, 0) > 0 THEN (order_stats.total * (1.5 + random()))::int ELSE 0 END,
    (ARRAY['VIP','High-Value','Regular','New','At-Risk','Churned','Dormant'])[1 + floor(random() * 7)::int],
    now() - (random() * interval '7 days')
FROM customers c
LEFT JOIN (
    SELECT customer_id, count(*) AS cnt, sum(total_cents) AS total, min(created_at) AS first_at, max(created_at) AS last_at
    FROM orders
    GROUP BY customer_id
) order_stats ON order_stats.customer_id = c.id
LIMIT 8000;


-- ==========================================================================
-- 13. MARKETPLACE PAYOUTS & PERFORMANCE
-- ==========================================================================

-- ---------- Seller Payouts (2,000) ----------
INSERT INTO seller_payouts (seller_id, amount_cents, period_start, period_end, status, paid_at, created_at)
SELECT
    1 + floor(random() * 80)::int,
    (5000 + floor(random() * 50000))::int,
    period_start,
    period_start + interval '1 month',
    (ARRAY['paid','paid','paid','paid','paid','pending','processing'])[1 + floor(random() * 7)::int],
    CASE WHEN random() < 0.8 THEN period_start + interval '1 month' + (random() * interval '5 days') ELSE NULL END,
    period_start
FROM (
    SELECT g, ('2022-02-01'::date + ((g * 15) % 1095))::date AS period_start
    FROM generate_series(1, 2000) AS g
) AS src;

-- ---------- Seller Performance (400) ----------
INSERT INTO seller_performance (seller_id, month, total_orders, total_revenue_cents, return_rate, avg_rating, created_at)
SELECT
    ((g - 1) % 80) + 1,
    ('2022-02-01'::date + (((g - 1) / 80) * 30)),
    floor(random() * 50 + 5)::int,
    (10000 + floor(random() * 200000))::int,
    round((random() * 10)::numeric, 2),
    round((3.0 + random() * 2)::numeric, 2),
    ('2022-03-01'::date + (((g - 1) / 80) * 30))::timestamptz
FROM generate_series(1, 400) AS g;


-- ==========================================================================
-- 14. INTERNAL / OPS DATA
-- ==========================================================================

-- ---------- Admin Users (30) ----------
INSERT INTO admin_users (email, full_name, role, is_active, created_at)
SELECT
    lower(first) || '.' || lower(last) || '@novamart.com',
    first || ' ' || last,
    (ARRAY['admin','admin','manager','manager','support','support','support','support','support','warehouse'])[1 + floor(random() * 10)::int],
    CASE WHEN g <= 25 THEN true ELSE false END,
    '2020-01-01'::timestamptz + (random() * interval '365 days')
FROM (
    SELECT
        g,
        (ARRAY['Sarah','Mike','Jessica','Tom','Emily','Chris','Rachel','David','Lisa','Kevin',
               'Amanda','Brian','Megan','Ryan','Lauren','Nick','Tina','Josh','Diana','Mark',
               'Kelly','Peter','Grace','Sam','Alex','Robin','Casey','Jordan','Morgan','Taylor'])[g] AS first,
        (ARRAY['Chen','Patel','Kim','Santos','Mueller','Johansson','O''Brien','Nakamura','Silva','Andersen',
               'Ivanov','Kowalski','Tanaka','Svensson','Park','Dubois','Fernandez','Ali','Nguyen','Rossi',
               'Müller','Sato','Costa','Berg','Larsen','Moreau','Reyes','Khan','Lee','Fischer'])[g] AS last
    FROM generate_series(1, 30) AS g
) AS src;

-- ---------- Admin Audit Log (10,000) ----------
INSERT INTO admin_audit_log (admin_user_id, action, resource_type, resource_id, details, ip_address, created_at)
SELECT
    1 + floor(random() * 30)::int,
    (ARRAY['login','logout','view_order','update_order','cancel_order','issue_refund',
           'update_product','create_promotion','update_customer','export_data',
           'view_report','manage_seller','update_settings','manage_return','view_analytics'])[1 + floor(random() * 15)::int],
    (ARRAY['order','product','customer','promotion','seller','return','report','settings'])[1 + floor(random() * 8)::int],
    floor(random() * 25000)::int::text,
    CASE WHEN random() < 0.3 THEN '{"ip":"10.0.' || floor(random() * 255)::int || '.' || floor(random() * 255)::int || '"}' ELSE NULL END,
    '10.0.' || floor(random() * 255)::int || '.' || floor(random() * 255)::int,
    '2020-01-15'::timestamptz + (power(random(), 0.3) * interval '1870 days')
FROM generate_series(1, 10000) AS g;

-- ---------- System Settings (20) ----------
INSERT INTO system_settings (key, value, updated_at) VALUES
    ('site.name',                'NovaMart',                                 '2020-01-15'::timestamptz),
    ('site.tagline',             'Premium Home Goods, Delivered',            '2020-01-15'::timestamptz),
    ('shipping.free_threshold',  '7500',                                     '2023-06-01'::timestamptz),
    ('shipping.default_carrier', 'UPS',                                      '2020-01-15'::timestamptz),
    ('tax.default_rate',         '0.08',                                     '2020-01-15'::timestamptz),
    ('loyalty.points_per_dollar','1',                                        '2020-09-01'::timestamptz),
    ('loyalty.redeem_rate',      '100',                                      '2020-09-01'::timestamptz),
    ('return.window_days',       '30',                                       '2020-01-15'::timestamptz),
    ('marketplace.commission',   '0.15',                                     '2022-01-01'::timestamptz),
    ('marketplace.payout_day',   '15',                                       '2022-01-01'::timestamptz),
    ('email.from_address',       'hello@novamart.com',                       '2020-01-15'::timestamptz),
    ('email.support_address',    'support@novamart.com',                     '2020-01-15'::timestamptz),
    ('analytics.enabled',        'true',                                     '2021-01-01'::timestamptz),
    ('review.moderation',        'auto',                                     '2021-06-01'::timestamptz),
    ('inventory.low_stock_alert','true',                                     '2020-06-01'::timestamptz),
    ('inventory.reorder_auto',   'false',                                    '2023-01-01'::timestamptz),
    ('checkout.guest_allowed',   'true',                                     '2020-01-15'::timestamptz),
    ('checkout.max_items',       '50',                                       '2020-01-15'::timestamptz),
    ('promo.stack_allowed',      'false',                                    '2021-01-01'::timestamptz),
    ('maintenance_mode',         'false',                                    '2024-01-15'::timestamptz);


-- ==========================================================================
-- 15. LEGACY & ABANDONED TABLE DATA
-- ==========================================================================

-- ---------- old_orders_v1 (3,000) — pre-migration 2020 orders ----------
INSERT INTO old_orders_v1 (cust_email, order_total, order_status, item_list, placed_date, shipped_date)
SELECT
    'customer' || floor(random() * 2000)::int || '@' || (ARRAY['gmail.com','yahoo.com','outlook.com'])[1 + floor(random() * 3)::int],
    round((29.99 + random() * 300)::numeric, 2),   -- dollars, not cents
    (ARRAY['complete','shipped','processing','canceled','pending','refunded'])[1 + floor(random() * 6)::int],
    'SKU-' || lpad(floor(random() * 999)::int::text, 3, '0') || ' x' || (1 + floor(random() * 3)::int)
        || CASE WHEN random() < 0.4 THEN ', SKU-' || lpad(floor(random() * 999)::int::text, 3, '0') || ' x1' ELSE '' END,
    placed_ts,
    CASE WHEN random() < 0.6 THEN placed_ts + (random() * interval '7 days') ELSE NULL END
FROM (
    SELECT g, '2020-01-15'::timestamptz + (random() * interval '365 days') AS placed_ts
    FROM generate_series(1, 3000) AS g
) AS src;

-- ---------- temp_product_import_2023 (500) — CSV import artifact ----------
INSERT INTO temp_product_import_2023 (import_name, import_sku, import_price, import_category, raw_csv_line, imported_at)
SELECT
    'Imported Product ' || g,
    'IMP-' || lpad(g::text, 4, '0'),
    -- stored as text, not numeric
    '$' || round((9.99 + random() * 200)::numeric, 2)::text,
    (ARRAY['bedding','kitchen','bath','outdoor','decor','unknown',''])[1 + floor(random() * 7)::int],
    'Imported Product ' || g || ',IMP-' || lpad(g::text, 4, '0') || ',$' || round((9.99 + random() * 200)::numeric, 2) || ',bedding',
    '2023-09-15'::timestamptz + (random() * interval '3 hours')
FROM generate_series(1, 500) AS g;

-- ---------- legacy_analytics_events (8,000) — old tracking system ----------
INSERT INTO legacy_analytics_events (event_name, event_data, user_ref, page_url, timestamp)
SELECT
    (ARRAY['page_view','click','scroll','form_submit','purchase','add_to_cart','remove_from_cart',
           'search','signup','login'])[1 + floor(random() * 10)::int],
    '{"session":"' || md5(random()::text) || '","ua":"Chrome"}',
    'user_' || floor(random() * 5000)::int,   -- string reference, not integer FK
    (ARRAY['/','/products','/cart','/checkout','/account','/collections','/search'])[1 + floor(random() * 7)::int],
    '2020-06-01'::timestamptz + (random() * interval '1095 days')  -- stopped mid-2023
FROM generate_series(1, 8000) AS g;

-- ---------- payment_methods_backup (2,000) — Stripe→Adyen migration backup ----------
INSERT INTO payment_methods_backup (cust_id, card_type, last_four, exp_month, exp_year, is_primary, created_date)
SELECT
    floor(random() * 10000 + 5000)::int,    -- old customer IDs (5000-15000 range, don't match current customers)
    (ARRAY['visa','visa','visa','mastercard','mastercard','amex','discover'])[1 + floor(random() * 7)::int],
    lpad(floor(random() * 10000)::int::text, 4, '0'),
    1 + floor(random() * 12)::int,
    2023 + floor(random() * 4)::int,
    CASE WHEN g <= 1500 THEN true ELSE false END,
    '2020-01-15'::timestamptz + (random() * interval '1095 days')
FROM generate_series(1, 2000) AS g;


COMMIT;

-- ==========================================================================
-- Verify row counts
-- ==========================================================================
SELECT 'Row counts:' AS info;
SELECT schemaname, relname AS table_name, n_live_tup AS row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
