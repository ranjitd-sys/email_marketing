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