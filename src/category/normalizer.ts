import { AMAZON_IN_ORIGIN } from "../config/env";

const AMAZON_IN_HOSTS = new Set(["www.amazon.in", "amazon.in"]);

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const NODE_ID_REGEX = /^\d{3,}$/;

const BEST_SELLERS_PREFIX = "/gp/bestsellers";

export function normalizeCategoryUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, AMAZON_IN_ORIGIN);
  } catch {
    throw new TypeError(`Cannot parse URL: "${url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`Not an HTTP(S) URL: "${url}"`);
  }

  if (!AMAZON_IN_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new TypeError(`Not an Amazon.in URL: "${url}"`);
  }

  let path = parsed.pathname;

  const refIndex = path.indexOf("/ref=");
  if (refIndex !== -1) {
    path = path.slice(0, refIndex);
  }

  if (!path.startsWith(BEST_SELLERS_PREFIX)) {
    throw new TypeError(`Not a bestsellers category path: "${url}"`);
  }

  const tail = path
    .slice(BEST_SELLERS_PREFIX.length)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  path = BEST_SELLERS_PREFIX + (tail.length > 0 ? `/${tail}/` : "/");

  const segments = tail.split("/").filter(Boolean);
  if (segments.length > 2) {
    throw new TypeError(`Unexpected number of path segments: "${url}"`);
  }
  for (const segment of segments) {
    if (!(SLUG_REGEX.test(segment) || NODE_ID_REGEX.test(segment))) {
      throw new TypeError(`Invalid category path segment "${segment}" in "${url}"`);
    }
  }

  return `${AMAZON_IN_ORIGIN}${path}`;
}

export function isCategoryUrl(url: string): boolean {
  try {
    normalizeCategoryUrl(url);
    return true;
  } catch {
    return false;
  }
}
