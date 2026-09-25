import { AMAZON_IN_ORIGIN } from "../config/env";

const ASIN_REGEX = /^[A-Z0-9]{10}$/;
const ASIN_PATH = /\/dp\/([A-Za-z0-9]{10})(?:[/?]|$)/;
const PRODUCT_PATH = /\/gp\/product\/([A-Za-z0-9]{10})(?:[/?]|$)/;
const ASIN_QUERY = /[?&](?:asin|ASIN)=([A-Za-z0-9]{10})(?:&|$)/;
const DATA_ASIN = /data-asin="([A-Za-z0-9]{10})"/;
const NAME_ASIN = /name="ASIN"[^>]*value="([A-Za-z0-9]{10})"/;
const JSON_ASIN = /"asin"\s*:\s*"([A-Za-z0-9]{10})"/;

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EMAIL_SCAN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const LEGAL_SUFFIXES = /\b(private|pvt|limited|ltd|llp|inc|incorporated|corp|corporation|company|co|gmbh|sarl|bv|nv|plc|llc)\b\.?/gi;

export function extractAsin(urlOrHtml: string): string | null {
  if (typeof urlOrHtml !== "string" || urlOrHtml.length === 0) return null;

  const candidates: string[] = [];

  const path = ASIN_PATH.exec(urlOrHtml);
  if (path?.[1]) candidates.push(path[1]);

  const product = PRODUCT_PATH.exec(urlOrHtml);
  if (product?.[1]) candidates.push(product[1]);

  const query = ASIN_QUERY.exec(urlOrHtml);
  if (query?.[1]) candidates.push(query[1]);

  const nameAsin = NAME_ASIN.exec(urlOrHtml);
  if (nameAsin?.[1]) candidates.push(nameAsin[1]);

  const jsonAsin = JSON_ASIN.exec(urlOrHtml);
  if (jsonAsin?.[1]) candidates.push(jsonAsin[1]);

  const dataAsin = DATA_ASIN.exec(urlOrHtml);
  if (dataAsin?.[1]) candidates.push(dataAsin[1]);

  for (const candidate of candidates) {
    if (isValidAsin(candidate)) return candidate.toUpperCase();
  }

  return null;
}

export function isValidAsin(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!ASIN_REGEX.test(value)) return false;
  if (!/[0-9]/.test(value)) return false;
  if (!/[A-Z]/.test(value)) return false;
  return true;
}

export function normalizeProductUrl(url: string): string | null {
  const asin = extractAsin(url);
  if (!asin) return null;
  return `${AMAZON_IN_ORIGIN}/dp/${asin}/`;
}

export function normalizeSellerName(name: string): string {
  if (typeof name !== "string") return "";
  return name
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+/, "")
    .replace(/["'\s]+$/, "")
    .trim();
}

export function sellerIdentityKey(name: string): string {
  const normalized = normalizeSellerName(name).toLowerCase();
  if (normalized.length === 0) return "";
  return normalized
    .replace(/[.,]/g, "")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSellerIdFromProfileUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const match = /[?&]seller=([A-Za-z0-9]+)(?:&|$)/.exec(url);
  return match?.[1] ?? null;
}

export function normalizeEmail(value: string): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/^[<(\[{"'\s]+/, "")
    .replace(/[>)\]}"'.,;\s]+$/, "")
    .trim()
    .toLowerCase();
  if (!EMAIL_REGEX.test(cleaned)) return null;
  return cleaned;
}

export function findEmails(text: string): string[] {
  if (typeof text !== "string") return [];
  const found = text.match(EMAIL_SCAN) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of found) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}

export function normalizePhone(value: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;

  const normalized = `${hasPlus ? "+" : ""}${digits}`;
  if (normalized.replace(/\D/g, "").length < 7) return null;
  return normalized;
}

export function findPhones(text: string): string[] {
  if (typeof text !== "string") return [];
  const matches = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const phone = normalizePhone(raw);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    result.push(phone);
  }
  return result;
}

export function normalizeWebsite(value: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    if (!host.includes(".")) return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${host}${path}`;
  } catch {
    return null;
  }
}

export function findWebsites(text: string): string[] {
  if (typeof text !== "string") return [];
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const site = normalizeWebsite(raw);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    result.push(site);
  }
  return result;
}

export function parseNumeric(text: string | null | undefined): number | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const match = /\d[\d,]*(?:\.\d+)?/.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[0].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function parseInteger(text: string | null | undefined): number | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const match = /\d[\d,]*/.exec(text);
  if (!match) return null;
  const value = Number.parseInt(match[0].replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}
