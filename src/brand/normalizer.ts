const MAX_BRAND_LENGTH = 80;
const MIN_BRAND_LENGTH = 1;

const REJECTED_BRANDS = new Set([
  "amazon",
  "sponsored",
  "advertisement",
  "visit the store",
  "brand",
  "brand name",
  "n a",
  "na",
  "not available",
  "unknown",
  "generic",
  "no brand",
]);

const BYLINE_PREFIX = /^visit\s+the\s+/i;
const BYLINE_SUFFIX = /\s+store$/i;

const BRAND_LABEL = /^(?:brand(?:\s+name)?|manufacturer(?:\s+name)?)$/i;

export function normalizeBrandName(name: string): string {
  if (typeof name !== "string") return "";

  let value = name
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  if (value.length === 0) return "";

  value = value
    .replace(/^["'“”‘’\s]+/, "")
    .replace(/["'“”‘’\s.,:;!?-]+$/, "")
    .trim();

  if (value.length < MIN_BRAND_LENGTH) return "";
  if (value.length > MAX_BRAND_LENGTH) return "";
  if (!/[\p{L}\p{N}]/u.test(value)) return "";

  const lowered = value.toLowerCase();
  if (REJECTED_BRANDS.has(lowered)) return "";

  return lowered;
}

export function isPlausibleBrandName(name: string): boolean {
  const normalized = normalizeBrandName(name);
  if (normalized.length === 0) return false;
  if (/\d{4,}/.test(normalized)) return false;
  return true;
}

export function extractBrandFromByline(bylineText: string): string {
  if (typeof bylineText !== "string") return "";
  const trimmed = bylineText.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "";

  let value = trimmed;
  if (BYLINE_PREFIX.test(value)) {
    value = value.replace(BYLINE_PREFIX, "");
  } else {
    return "";
  }

  if (BYLINE_SUFFIX.test(value)) {
    value = value.replace(BYLINE_SUFFIX, "");
  }

  return value.replace(/\s+/g, " ").trim();
}

export function isBrandLabel(label: string): boolean {
  return BRAND_LABEL.test(label.replace(/\s+/g, " ").trim());
}
