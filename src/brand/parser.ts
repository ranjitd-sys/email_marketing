import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { AMAZON_IN_ORIGIN } from "../config/env";
import {
  extractBrandFromByline,
  isBrandLabel,
  isPlausibleBrandName,
  normalizeBrandName,
} from "./normalizer";
import type {
  BrandExtraction,
  BrandExtractionResult,
  BrandSource,
  ProductResultEntry,
  ProductResultPage,
} from "./types";

const ASIN_REGEX = /^[A-Z0-9]{10}$/;
const ASIN_IN_PATH = /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/;

const FACEOUT = "div.p13n-sc-uncoverable-faceout";
const GRID_CARD = "div.zg-grid-general-faceout";
const NEXT_PAGE = "li.a-last a[href]";
const NEXT_PAGE_FALLBACK = 'a.a-normal[href*="pg="]';
const NEXT_PAGE_LABEL = /next\s*page/i;

const TITLE_LINE_CLAMP = "div[class*='p13n-sc-css-line-clamp']";
const TITLE_TRUNCATE = "div[class*='p13n-sc-truncate']";
const TITLE_FALLBACK = "span.a-text-normal.a-size-base-plus.a-color-base";

const BRAND_TABLE_ROW = "tr.po-brand";
const BRAND_SPEC_TH = "th.prodDetSectionEntry";
const BRAND_SPEC_TD = "td.prodDetAttrValue";
const BRAND_LIST_ITEM = "li.a-list-item";
const BRAND_VALUE_CLASS = "span.po-break-word";
const BYLINE = "#bylineInfo";
const CARD_BRAND = "[data-brand], .a-size-base.a-color-secondary.a-text-bold";

const JSON_LD = 'script[type="application/ld+json"]';

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function canonicalProductUrl(asin: string): string {
  return `${AMAZON_IN_ORIGIN}/dp/${asin}`;
}

function extractTitle($: cheerio.CheerioAPI, node: Element): string | null {
  const scope = $(node);
  const clamp = scope.find(TITLE_LINE_CLAMP).first();
  if (clamp.length > 0) {
    const text = collapse(clamp.text());
    if (text.length > 0) return text;
  }

  const truncate = scope.find(TITLE_TRUNCATE).first();
  if (truncate.length > 0) {
    const text = collapse(truncate.text());
    if (text.length > 0) return text;
  }

  const fallback = scope.find(TITLE_FALLBACK).first();
  if (fallback.length > 0) {
    const text = collapse(fallback.text());
    if (text.length > 0) return text;
  }

  const image = scope.find("img[alt]").first();
  if (image.length > 0) {
    const alt = collapse(image.attr("alt") ?? "");
    if (alt.length > 0) return alt;
  }

  const link = scope.find('a[href*="/dp/"]').first();
  if (link.length > 0) {
    const text = collapse(link.text());
    if (text.length > 0) return text;
  }

  return null;
}

function findNextPageUrl($: cheerio.CheerioAPI): string | null {
  const candidate = $(NEXT_PAGE).first();
  if (candidate.length > 0) {
    const href = candidate.attr("href");
    if (href) {
      try {
        return new URL(href, AMAZON_IN_ORIGIN).toString();
      } catch {
        return null;
      }
    }
  }

  const links = $(NEXT_PAGE_FALLBACK).toArray();
  for (const node of links) {
    const text = collapse($(node).text());
    if (!NEXT_PAGE_LABEL.test(text)) continue;
    const href = $(node).attr("href");
    if (!href) continue;
    try {
      return new URL(href, AMAZON_IN_ORIGIN).toString();
    } catch {
      return null;
    }
  }

  return null;
}

export function parseProductResults(html: string): ProductResultPage {
  const $ = cheerio.load(html);
  const products: ProductResultEntry[] = [];
  const seen = new Set<string>();

  const containers = $(`${FACEOUT}, ${GRID_CARD}`).toArray();

  for (const node of containers) {
    const scope = $(node);
    const id = scope.attr("id") ?? "";
    const asin = ASIN_REGEX.test(id)
      ? id
      : (() => {
          const href = scope.find('a[href*="/dp/"]').first().attr("href");
          const match = href ? ASIN_IN_PATH.exec(href) : null;
          return match?.[1] ?? null;
        })();

    if (!asin || seen.has(asin)) continue;
    seen.add(asin);

    products.push({
      asin,
      productUrl: canonicalProductUrl(asin),
      title: extractTitle($, node),
      rank: products.length + 1,
    });
  }

  if (products.length === 0) {
    const anchors = $('a[href*="/dp/"]').toArray();
    for (const node of anchors) {
      const href = $(node).attr("href") ?? "";
      const match = ASIN_IN_PATH.exec(href);
      const asin = match?.[1];
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      const title = collapse($(node).text());
      products.push({
        asin,
        productUrl: canonicalProductUrl(asin),
        title: title.length > 0 ? title : null,
        rank: products.length + 1,
      });
    }
  }

  return { products, nextPageUrl: findNextPageUrl($) };
}

function brandFromJsonLd($: cheerio.CheerioAPI): BrandExtraction | null {
  const nodes = $(JSON_LD).toArray();
  for (const node of nodes) {
    const raw = $(node).text();
    if (raw.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length > 0) {
      const current = queue.shift();
      if (Array.isArray(current)) {
        queue.push(...current);
        continue;
      }
      if (current === null || typeof current !== "object") continue;

      const record = current as Record<string, unknown>;
      const typeValue = record["@type"];
      const types = Array.isArray(typeValue) ? typeValue : [typeValue];
      const isProduct = types.some(
        (t) => typeof t === "string" && /product/i.test(t)
      );

      if (isProduct) {
        const brand = record["brand"];
        const name =
          typeof brand === "string"
            ? brand
            : brand !== null && typeof brand === "object"
              ? ((brand as Record<string, unknown>)["name"] as string | undefined)
              : undefined;
        if (typeof name === "string" && isPlausibleBrandName(name)) {
          return { brand: collapse(name), source: "json_ld_product" };
        }
      }

      for (const value of Object.values(record)) {
        if (value !== null && typeof value === "object") queue.push(value);
      }
    }
  }

  return null;
}

function labelValue(
  $: cheerio.CheerioAPI,
  labelNode: Element,
  valueNode: Element | undefined
): { label: string; value: string } | null {
  const label = collapse($(labelNode).text());
  if (label.length === 0) return null;
  const value = valueNode ? collapse($(valueNode).text()) : "";
  return { label, value };
}

function brandFromDetailSpec($: cheerio.CheerioAPI): BrandExtraction | null {
  const row = $(BRAND_TABLE_ROW).first();
  if (row.length > 0) {
    const cells = row.find("td").toArray();
    if (cells.length >= 2) {
      const label = collapse($(cells[0] as Element).text());
      const value = collapse($(cells[1] as Element).text());
      if (isBrandLabel(label) && isPlausibleBrandName(value)) {
        return { brand: value, source: "detail_spec_brand" };
      }
    }
  }

  const labels = $(BRAND_SPEC_TH).toArray();
  for (const labelNode of labels) {
    const label = collapse($(labelNode).text());
    if (!isBrandLabel(label)) continue;
    const valueNode = $(labelNode).next(BRAND_SPEC_TD).first();
    const candidate = valueNode.length > 0 ? valueNode : $(labelNode).next();
    const parsed = labelValue($, labelNode, candidate.get(0) as Element | undefined);
    if (!parsed) continue;
    if (isPlausibleBrandName(parsed.value)) {
      return {
        brand: parsed.value,
        source: label.toLowerCase() === "brand" ? "detail_spec_brand" : "detail_spec_brand_name",
      };
    }
  }

  const items = $(BRAND_LIST_ITEM).toArray();
  for (const itemNode of items) {
    const item = $(itemNode);
    const labelNode = item.find("span.a-text-bold").first();
    if (labelNode.length === 0) continue;
    const label = collapse(labelNode.text());
    if (!isBrandLabel(label)) continue;

    let value = collapse(labelNode.get(0) ? item.clone().children().last().text() : "");
    if (value.length === 0 || value === label) {
      value = collapse(item.text().replace(label, ""));
    }
    if (isPlausibleBrandName(value)) {
      return {
        brand: value,
        source: label.toLowerCase() === "brand" ? "detail_spec_brand" : "detail_spec_brand_name",
      };
    }
  }

  const brandValue = $(BRAND_VALUE_CLASS).first();
  if (brandValue.length > 0) {
    const scope = brandValue.closest("tr, li, div");
    const label = scope.length > 0 ? collapse(scope.find("span.a-text-bold, th").first().text()) : "";
    if (isBrandLabel(label)) {
      const value = collapse(brandValue.text());
      if (isPlausibleBrandName(value)) {
        return { brand: value, source: "detail_spec_brand" };
      }
    }
  }

  return null;
}

function brandFromByline($: cheerio.CheerioAPI): BrandExtraction | null {
  const byline = $(BYLINE).first();
  if (byline.length === 0) return null;
  const brand = extractBrandFromByline(collapse(byline.text()));
  if (!isPlausibleBrandName(brand)) return null;
  return { brand, source: "byline_store" };
}

function brandFromCardMetadata($: cheerio.CheerioAPI): BrandExtraction | null {
  const node = $(CARD_BRAND).first();
  if (node.length === 0) return null;
  const text = collapse(node.text()).replace(/^brand:?\s*/i, "");
  if (!isPlausibleBrandName(text)) return null;
  return { brand: text, source: "card_metadata" };
}

function reasonFor(
  $: cheerio.CheerioAPI,
  html: string
): "no_product_markers" | "no_brand_metadata" | "brand_metadata_empty" | "brand_not_plausible" {
  const hasProductMarker =
    $("title").length > 0 && ($('a[href*="/dp/"]').length > 0 || $("#productTitle").length > 0);
  if (!hasProductMarker) return "no_product_markers";
  if (html.length === 0) return "no_product_markers";

  const sawEmptyBrand =
    $(BRAND_TABLE_ROW).length > 0 || $(BRAND_SPEC_TH).length > 0 || $(BYLINE).length > 0;
  if (sawEmptyBrand) return "brand_metadata_empty";
  return "no_brand_metadata";
}

export function extractBrandFromProductPage(html: string): BrandExtraction | null {
  const $ = cheerio.load(html);

  const ordered: Array<() => BrandExtraction | null> = [
    () => brandFromJsonLd($),
    () => brandFromDetailSpec($),
    () => brandFromByline($),
    () => brandFromCardMetadata($),
  ];

  for (const source of ordered) {
    const found = source();
    if (!found) continue;
    if (!isPlausibleBrandName(found.brand)) continue;
    const brand = collapse(found.brand);
    if (brand.length === 0) continue;
    if (normalizeBrandName(brand).length === 0) continue;
    return { brand, source: found.source };
  }

  return null;
}

export function extractBrandResult(html: string, asin: string): BrandExtractionResult {
  const extraction = extractBrandFromProductPage(html);
  if (extraction) return { asin, extraction, reason: null };

  const $ = cheerio.load(html);
  return { asin, extraction: null, reason: reasonFor($, html) };
}

export function dedupeBrandsByNormalizedName(
  entries: Array<{ brand: string; source: BrandSource }>
): Array<{ brand: string; normalizedName: string; source: BrandSource }> {
  const byNormalized = new Map<
    string,
    { brand: string; normalizedName: string; source: BrandSource }
  >();

  for (const entry of entries) {
    const display = collapse(entry.brand);
    const normalized = normalizeBrandName(display);
    if (normalized.length === 0) continue;
    if (byNormalized.has(normalized)) continue;
    byNormalized.set(normalized, { brand: display, normalizedName: normalized, source: entry.source });
  }

  return [...byNormalized.values()];
}
