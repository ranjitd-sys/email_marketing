CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY,

    name TEXT NOT NULL,

    url TEXT NOT NULL UNIQUE,

    parent_id BIGINT REFERENCES categories(id),

    depth INTEGER NOT NULL,

    crawl_order BIGINT NOT NULL UNIQUE,

    status TEXT NOT NULL DEFAULT 'PENDING',

    processing_started_at TIMESTAMPTZ,

    processed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE categories ADD COLUMN IF NOT EXISTS depth INTEGER;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS crawl_order BIGINT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE categories ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

UPDATE categories SET crawl_order = id WHERE crawl_order IS NULL;

ALTER TABLE categories ALTER COLUMN depth SET NOT NULL;
ALTER TABLE categories ALTER COLUMN crawl_order SET NOT NULL;
ALTER TABLE categories ALTER COLUMN status SET DEFAULT 'PENDING';

ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_status_check;
ALTER TABLE categories ADD CONSTRAINT categories_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'));

CREATE UNIQUE INDEX IF NOT EXISTS categories_crawl_order_key ON categories(crawl_order);
CREATE INDEX IF NOT EXISTS categories_parent_id_idx ON categories(parent_id);
CREATE INDEX IF NOT EXISTS categories_status_idx ON categories(status);
CREATE INDEX IF NOT EXISTS categories_crawl_order_idx ON categories(crawl_order);
CREATE INDEX IF NOT EXISTS categories_processing_started_at_idx ON categories(processing_started_at);

CREATE SEQUENCE IF NOT EXISTS categories_crawl_order_seq;
