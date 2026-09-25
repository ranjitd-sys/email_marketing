export const AMAZON_IN_ORIGIN = "https://www.amazon.in";
export const ROOT_CATEGORY_URL = "https://www.amazon.in/gp/bestsellers/";

export interface CrawlConfig {
  databaseUrl: string;
  startUrl: string;
  rootName: string;
  batchSize: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  staleProcessingTimeoutMs: number;
  userAgent: string;
}

export const DEFAULT_CONFIG: Omit<CrawlConfig, "databaseUrl"> = {
  startUrl: ROOT_CATEGORY_URL,
  rootName: "Amazon Best Sellers",
  batchSize: 300,
  requestDelayMs: 1000,
  requestTimeoutMs: 15000,
  maxRetries: 2,
  staleProcessingTimeoutMs: 30 * 60 * 1000,
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/125.0 Safari/537.36",
};

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid integer for ${key}: "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CrawlConfig {
  const databaseUrl = env.DATABASE_URL ?? env.TEST_DATABASE_URL;
  if (!databaseUrl || databaseUrl === "") {
    throw new Error("DATABASE_URL is required (set it in .env or the environment)");
  }

  return {
    databaseUrl,
    startUrl: env.START_URL ?? DEFAULT_CONFIG.startUrl,
    rootName: env.ROOT_NAME ?? DEFAULT_CONFIG.rootName,
    batchSize: intFromEnv(env, "BATCH_SIZE", DEFAULT_CONFIG.batchSize),
    requestDelayMs: intFromEnv(env, "REQUEST_DELAY_MS", DEFAULT_CONFIG.requestDelayMs),
    requestTimeoutMs: intFromEnv(env, "REQUEST_TIMEOUT_MS", DEFAULT_CONFIG.requestTimeoutMs),
    maxRetries: intFromEnv(env, "MAX_RETRIES", DEFAULT_CONFIG.maxRetries),
    staleProcessingTimeoutMs: intFromEnv(
      env,
      "STALE_PROCESSING_TIMEOUT_MS",
      DEFAULT_CONFIG.staleProcessingTimeoutMs
    ),
    userAgent: env.USER_AGENT ?? DEFAULT_CONFIG.userAgent,
  };
}

export interface BrandConfig {
  databaseUrl: string;
  workerId: string;
  batchSize: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  brandMaxRetries: number;
  brandLeaseTimeoutMs: number;
  maxCategoryResultPages: number;
  maxProductPagesPerCategory: number;
  userAgent: string;
}

export const DEFAULT_BRAND_CONFIG: Omit<BrandConfig, "databaseUrl" | "workerId"> = {
  batchSize: 300,
  requestDelayMs: DEFAULT_CONFIG.requestDelayMs,
  requestTimeoutMs: DEFAULT_CONFIG.requestTimeoutMs,
  maxRetries: DEFAULT_CONFIG.maxRetries,
  brandMaxRetries: 3,
  brandLeaseTimeoutMs: 15 * 60 * 1000,
  maxCategoryResultPages: 5,
  maxProductPagesPerCategory: 50,
  userAgent: DEFAULT_CONFIG.userAgent,
};

export function defaultWorkerId(): string {
  const host = process.env.HOSTNAME ?? "local";
  return `brand-worker-${host}-${process.pid}`;
}

export function loadBrandConfig(env: NodeJS.ProcessEnv = process.env): BrandConfig {
  const databaseUrl = env.DATABASE_URL ?? env.TEST_DATABASE_URL;
  if (!databaseUrl || databaseUrl === "") {
    throw new Error("DATABASE_URL is required (set it in .env or the environment)");
  }

  const workerId = env.WORKER_ID && env.WORKER_ID !== "" ? env.WORKER_ID : defaultWorkerId();

  return {
    databaseUrl,
    workerId,
    batchSize: intFromEnv(env, "BATCH_SIZE", DEFAULT_BRAND_CONFIG.batchSize),
    requestDelayMs: intFromEnv(
      env,
      "REQUEST_DELAY_MS",
      DEFAULT_BRAND_CONFIG.requestDelayMs
    ),
    requestTimeoutMs: intFromEnv(
      env,
      "REQUEST_TIMEOUT_MS",
      DEFAULT_BRAND_CONFIG.requestTimeoutMs
    ),
    maxRetries: intFromEnv(env, "MAX_RETRIES", DEFAULT_BRAND_CONFIG.maxRetries),
    brandMaxRetries: intFromEnv(
      env,
      "BRAND_MAX_RETRIES",
      DEFAULT_BRAND_CONFIG.brandMaxRetries
    ),
    brandLeaseTimeoutMs: intFromEnv(
      env,
      "BRAND_LEASE_TIMEOUT_MS",
      DEFAULT_BRAND_CONFIG.brandLeaseTimeoutMs
    ),
    maxCategoryResultPages: intFromEnv(
      env,
      "MAX_CATEGORY_RESULT_PAGES",
      DEFAULT_BRAND_CONFIG.maxCategoryResultPages
    ),
    maxProductPagesPerCategory: intFromEnv(
      env,
      "MAX_PRODUCT_PAGES_PER_CATEGORY",
      DEFAULT_BRAND_CONFIG.maxProductPagesPerCategory
    ),
    userAgent: env.USER_AGENT ?? DEFAULT_BRAND_CONFIG.userAgent,
  };
}

export interface ProductSellerConfig {
  databaseUrl: string;
  workerId: string;
  batchSize: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  maxResultPages: number;
  maxProductsPerWork: number;
  sellerMaxRetries: number;
  sellerLeaseTimeoutMs: number;
  fetchSellerProfiles: boolean;
  maxSellerProfilesPerWork: number;
  userAgent: string;
}

export const DEFAULT_PRODUCT_SELLER_CONFIG: Omit<
  ProductSellerConfig,
  "databaseUrl" | "workerId"
> = {
  batchSize: 100,
  requestDelayMs: DEFAULT_CONFIG.requestDelayMs,
  requestTimeoutMs: DEFAULT_CONFIG.requestTimeoutMs,
  maxRetries: DEFAULT_CONFIG.maxRetries,
  maxConcurrency: 2,
  maxResultPages: 5,
  maxProductsPerWork: 20,
  sellerMaxRetries: 3,
  sellerLeaseTimeoutMs: 15 * 60 * 1000,
  fetchSellerProfiles: true,
  maxSellerProfilesPerWork: 5,
  userAgent: DEFAULT_CONFIG.userAgent,
};

export function defaultProductSellerWorkerId(): string {
  const host = process.env.HOSTNAME ?? "local";
  return `product-seller-worker-${host}-${process.pid}`;
}

function boolFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function loadProductSellerConfig(
  env: NodeJS.ProcessEnv = process.env
): ProductSellerConfig {
  const databaseUrl = env.DATABASE_URL ?? env.TEST_DATABASE_URL;
  if (!databaseUrl || databaseUrl === "") {
    throw new Error("DATABASE_URL is required (set it in .env or the environment)");
  }

  const workerId =
    env.WORKER_ID && env.WORKER_ID !== "" ? env.WORKER_ID : defaultProductSellerWorkerId();

  return {
    databaseUrl,
    workerId,
    batchSize: intFromEnv(env, "BATCH_SIZE", DEFAULT_PRODUCT_SELLER_CONFIG.batchSize),
    requestDelayMs: intFromEnv(
      env,
      "REQUEST_DELAY_MS",
      DEFAULT_PRODUCT_SELLER_CONFIG.requestDelayMs
    ),
    requestTimeoutMs: intFromEnv(
      env,
      "REQUEST_TIMEOUT_MS",
      DEFAULT_PRODUCT_SELLER_CONFIG.requestTimeoutMs
    ),
    maxRetries: intFromEnv(env, "MAX_RETRIES", DEFAULT_PRODUCT_SELLER_CONFIG.maxRetries),
    maxConcurrency: intFromEnv(
      env,
      "MAX_CONCURRENCY",
      DEFAULT_PRODUCT_SELLER_CONFIG.maxConcurrency
    ),
    maxResultPages: intFromEnv(
      env,
      "MAX_RESULT_PAGES",
      DEFAULT_PRODUCT_SELLER_CONFIG.maxResultPages
    ),
    maxProductsPerWork: intFromEnv(
      env,
      "MAX_PRODUCTS_PER_WORK",
      DEFAULT_PRODUCT_SELLER_CONFIG.maxProductsPerWork
    ),
    sellerMaxRetries: intFromEnv(
      env,
      "SELLER_MAX_RETRIES",
      DEFAULT_PRODUCT_SELLER_CONFIG.sellerMaxRetries
    ),
    sellerLeaseTimeoutMs: intFromEnv(
      env,
      "SELLER_LEASE_TIMEOUT_MS",
      DEFAULT_PRODUCT_SELLER_CONFIG.sellerLeaseTimeoutMs
    ),
    fetchSellerProfiles: boolFromEnv(
      env,
      "FETCH_SELLER_PROFILES",
      DEFAULT_PRODUCT_SELLER_CONFIG.fetchSellerProfiles
    ),
    maxSellerProfilesPerWork: intFromEnv(
      env,
      "MAX_SELLER_PROFILES_PER_WORK",
      DEFAULT_PRODUCT_SELLER_CONFIG.maxSellerProfilesPerWork
    ),
    userAgent: env.USER_AGENT ?? DEFAULT_PRODUCT_SELLER_CONFIG.userAgent,
  };
}