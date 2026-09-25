import type { CrawlConfig } from "../config/env";
import { log } from "../logger";

export class FetchPageError extends Error {
  readonly url: string;
  readonly status: number | null;

  constructor(message: string, url: string, status: number | null = null, cause?: unknown) {
    super(message, { cause });
    this.name = "FetchPageError";
    this.url = url;
    this.status = status;
  }
}

export interface HttpClient {
  fetchPage(url: string): Promise<string>;
}

export interface HttpClientDeps {
  delayMs: number;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpClient(config: Pick<CrawlConfig, "requestDelayMs" | "requestTimeoutMs" | "maxRetries" | "userAgent">): HttpClient {
  const deps: HttpClientDeps = {
    delayMs: config.requestDelayMs,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    userAgent: config.userAgent,
  };

  async function singleFetch(url: string): Promise<string> {
    await sleep(deps.delayMs);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(deps.timeoutMs),
      headers: {
        "User-Agent": deps.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    });

    if (!response.ok) {
      throw new FetchPageError(`HTTP ${response.status} for ${url}`, url, response.status);
    }

    return response.text();
  }

  async function fetchPage(url: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= deps.maxRetries; attempt++) {
      try {
        log("HTTP_REQUEST", { url, attempt: attempt + 1, max_attempts: deps.maxRetries + 1 });
        const html = await singleFetch(url);
        log("HTTP_RESPONSE", { url, bytes: html.length });
        return html;
      } catch (error) {
        lastError = error;
        const retrying = attempt < deps.maxRetries;
        log("HTTP_REQUEST_FAILED", {
          url,
          attempt: attempt + 1,
          retrying,
          error: String(error),
        });
        if (retrying) {
          const backoffMs = 250 * 2 ** attempt;
          await sleep(backoffMs);
        }
      }
    }

    throw lastError;
  }

  return { fetchPage };
}
