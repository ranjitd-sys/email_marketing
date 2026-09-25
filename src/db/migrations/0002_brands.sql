CREATE TABLE IF NOT EXISTS brands (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS category_brands (
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    brand_id BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (category_id, brand_id)
);

CREATE INDEX IF NOT EXISTS category_brands_brand_id_idx ON category_brands(brand_id);

ALTER TABLE categories ADD COLUMN IF NOT EXISTS brand_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE categories ADD COLUMN IF NOT EXISTS brand_processing_started_at TIMESTAMPTZ;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS brand_processed_at TIMESTAMPTZ;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS brand_locked_by TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS brand_locked_at TIMESTAMPTZ;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS brand_attempts INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'categories_brand_status_check'
    ) THEN
        ALTER TABLE categories ADD CONSTRAINT categories_brand_status_check
            CHECK (brand_status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS categories_brand_status_crawl_order_idx
    ON categories(brand_status, crawl_order);

CREATE INDEX IF NOT EXISTS categories_brand_locked_at_idx
    ON categories(brand_locked_at);
