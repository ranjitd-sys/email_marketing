CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    asin TEXT NOT NULL UNIQUE,
    title TEXT,
    brand_id BIGINT REFERENCES brands(id),
    url TEXT,
    price NUMERIC,
    mrp NUMERIC,
    discount NUMERIC,
    rating NUMERIC,
    review_count INTEGER,
    availability TEXT,
    description TEXT,
    manufacturer TEXT,
    model_number TEXT,
    product_type TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    product_status TEXT NOT NULL DEFAULT 'PENDING',
    processing_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    locked_by TEXT,
    locked_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_brand_id_idx ON products(brand_id);
CREATE INDEX IF NOT EXISTS products_product_status_idx ON products(product_status);

CREATE TABLE IF NOT EXISTS category_products (
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (category_id, product_id)
);

CREATE INDEX IF NOT EXISTS category_products_product_id_idx ON category_products(product_id);

CREATE TABLE IF NOT EXISTS brand_products (
    brand_id BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (brand_id, product_id)
);

CREATE INDEX IF NOT EXISTS brand_products_product_id_idx ON brand_products(product_id);

CREATE TABLE IF NOT EXISTS sellers (
    id BIGSERIAL PRIMARY KEY,
    external_id TEXT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    public_profile_url TEXT,
    legal_name TEXT,
    public_business_name TEXT,
    public_business_address TEXT,
    public_website TEXT,
    seller_status TEXT NOT NULL DEFAULT 'PENDING',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sellers_external_id_key
    ON sellers(external_id) WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sellers_normalized_name_no_ext_key
    ON sellers(normalized_name) WHERE external_id IS NULL;

CREATE INDEX IF NOT EXISTS sellers_seller_status_idx ON sellers(seller_status);

CREATE TABLE IF NOT EXISTS seller_products (
    seller_id BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (seller_id, product_id)
);

CREATE INDEX IF NOT EXISTS seller_products_product_id_idx ON seller_products(product_id);

CREATE TABLE IF NOT EXISTS contacts (
    id BIGSERIAL PRIMARY KEY,
    seller_id BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
    contact_type TEXT NOT NULL,
    contact_value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id BIGINT,
    source TEXT NOT NULL,
    source_url TEXT,
    context TEXT,
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_unique_key
    ON contacts (
        contact_type,
        normalized_value,
        source,
        COALESCE(context, ''),
        COALESCE(entity_id, 0)
    );

CREATE INDEX IF NOT EXISTS contacts_seller_id_idx ON contacts(seller_id);
CREATE INDEX IF NOT EXISTS contacts_entity_idx ON contacts(entity_type, entity_id);

ALTER TABLE category_brands ADD COLUMN IF NOT EXISTS product_seller_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE category_brands ADD COLUMN IF NOT EXISTS product_seller_locked_by TEXT;
ALTER TABLE category_brands ADD COLUMN IF NOT EXISTS product_seller_locked_at TIMESTAMPTZ;
ALTER TABLE category_brands ADD COLUMN IF NOT EXISTS product_seller_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE category_brands ADD COLUMN IF NOT EXISTS product_seller_processing_started_at TIMESTAMPTZ;
ALTER TABLE category_brands ADD COLUMN IF NOT EXISTS product_seller_processed_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'category_brands_product_seller_status_check'
    ) THEN
        ALTER TABLE category_brands ADD CONSTRAINT category_brands_product_seller_status_check
            CHECK (product_seller_status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS category_brands_ps_status_idx
    ON category_brands(product_seller_status, category_id, brand_id);

CREATE INDEX IF NOT EXISTS category_brands_ps_locked_at_idx
    ON category_brands(product_seller_locked_at);
