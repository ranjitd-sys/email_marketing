import * as cheerio from "cheerio";
import {
  extractAsin,
  parseInteger,
  parseNumeric,
} from "./normalizers";
import type { ParsedProduct } from "./types";

const JSON_LD = 'script[type="application/ld+json"]';
const BRAND_TABLE_ROW = "tr.po-brand";
const SPEC_LABEL = "th.prodDetSectionEntry";
const SPEC_VALUE = "td.prodDetAttrValue";
const BYLINE = "#bylineInfo";
const BYLINE_PREFIX = /^visit\s+the\s+/i;
const BYLINE_SUFFIX = /\s+store$/i;

const TITLE = "#productTitle";
const PRICE = "#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .a-price .a-offscreen";
const MRP = ".a-text-price .a-offscreen, #corePrice_feature_div .a-text-price .a-offscreen";
const SAVINGS = ".savingsPercentage";
const REVIEWS = "#acrCustomerReviewText";
const AVAILABILITY = "#availability";
const DESCRIPTION = "#productDescription, #bookDescription_feature_div";
const FEATURES = "#feature-bullets li span.a-list-item, #feature-bullets li";
const LANDING_IMAGE = "#landingImage";
const ALT_IMAGES = "#altImages img";

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function specRows($: cheerio.CheerioAPI): Map<string, string> {
  const rows = new Map<string, string>();

  $(SPEC_LABEL).each((_, th) => {
    const label = collapse($(th).text()).toLowerCase();
    if (label.length === 0) return;
    const value = collapse($(th).next(SPEC_VALUE).first().text());
    if (value.length > 0) rows.set(label, value);
  });

  $(BRAND_TABLE_ROW).each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length >= 2) {
      const label = collapse(cells.eq(0).text()).toLowerCase();
      const value = collapse(cells.eq(1).text());
      if (label.length > 0 && value.length > 0) rows.set(label, value);
    }
  });

  $("li.a-list-item").each((_, li) => {
    const labelNode = $(li).find("span.a-text-bold").first();
    if (labelNode.length === 0) return;
    const label = collapse(labelNode.text()).toLowerCase();
    if (label.length === 0) return;
    const value = collapse($(li).clone().children().last().text());
    if (value.length > 0) rows.set(label, value);
  });

  return rows;
}

function firstMatch($: cheerio.CheerioAPI, selector: string): string | null {
  const values = $(selector)
    .toArray()
    .map((el) => collapse($(el).text()))
    .filter((text) => text.length > 0);
  return values[0] ?? null;
}

function brandFromJsonLd($: cheerio.CheerioAPI): string | null {
  for (const node of $(JSON_LD).toArray()) {
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
      const brand = record["brand"];
      const name =
        typeof brand === "string"
          ? brand
          : brand !== null && typeof brand === "object"
            ? ((brand as Record<string, unknown>)["name"] as string | undefined)
            : undefined;
      if (typeof name === "string" && name.trim().length > 0) return collapse(name);
      for (const value of Object.values(record)) {
        if (value !== null && typeof value === "object") queue.push(value);
      }
    }
  }
  return null;
}

function brandFromByline($: cheerio.CheerioAPI): string | null {
  const text = collapse($(BYLINE).first().text());
  if (text.length === 0) return null;
  if (!BYLINE_PREFIX.test(text)) return null;
  const value = text.replace(BYLINE_PREFIX, "").replace(BYLINE_SUFFIX, "");
  return collapse(value) || null;
}

function extractBrand($: cheerio.CheerioAPI, rows: Map<string, string>): string | null {
  const jsonLd = brandFromJsonLd($);
  if (jsonLd) return jsonLd;
  for (const key of ["brand", "brand name"]) {
    const value = rows.get(key);
    if (value && value.length > 0) return value;
  }
  return brandFromByline($);
}

function collectImages($: cheerio.CheerioAPI): string[] {
  const images = new Set<string>();
  const landing = $(LANDING_IMAGE).first();
  if (landing.length > 0) {
    const hiRes = landing.attr("data-old-hires");
    const src = landing.attr("src");
    if (hiRes) images.add(hiRes);
    else if (src) images.add(src);
  }
  $(ALT_IMAGES).each((_, img) => {
    const src = $(img).attr("src");
    if (src) images.add(src);
  });
  return [...images];
}

function collectFeatures($: cheerio.CheerioAPI): string[] {
  const features = new Set<string>();
  $(FEATURES).each((_, li) => {
    const text = collapse($(li).text());
    if (text.length === 0) return;
    if (/^see more/i.test(text)) return;
    features.add(text);
  });
  return [...features];
}

function ratingValue($: cheerio.CheerioAPI): number | null {
  const popover = $("#acrPopover").first();
  if (popover.length > 0) {
    const title = popover.attr("title");
    const parsed = parseNumeric(title ?? null);
    if (parsed !== null) return parsed;
  }
  return parseNumeric(firstMatch($, "i.a-icon-star span.a-icon-alt, span[data-hook='rating-out-of-text']"));
}

function availabilityText($: cheerio.CheerioAPI): string | null {
  const node = $(AVAILABILITY).first();
  if (node.length === 0) return null;
  const text = collapse(node.clone().find("script").remove().end().text());
  if (text.length > 0) return text;
  const raw = collapse(node.text());
  if (raw.length === 0) return null;
  return collapse(raw.split("{")[0] ?? "");
}

export function parseProductPage(
  html: string,
  url: string,
  fallbackAsin?: string
): ParsedProduct | null {
  if (typeof html !== "string" || html.length === 0) return null;
  const $ = cheerio.load(html);

  const asin = extractAsin(url) ?? extractAsin(html) ?? (fallbackAsin ?? null);
  if (!asin) return null;

  const titleText = collapse($(TITLE).first().text());
  const hasProductMarkers =
    titleText.length > 0 ||
    $(JSON_LD).length > 0 ||
    $(SPEC_LABEL).length > 0 ||
    $('a[href*="/dp/"]').length > 0;
  if (!hasProductMarkers) return null;

  const rows = specRows($);
  const price = parseNumeric(firstMatch($, PRICE));
  const mrp = parseNumeric(firstMatch($, MRP));
  const discountText = firstMatch($, SAVINGS);
  const discountFromText = parseNumeric(discountText?.replace("%", "") ?? null);
  const discount =
    discountFromText !== null
      ? discountFromText
      : price !== null && mrp !== null && mrp > 0
        ? Math.round(((mrp - price) / mrp) * 10000) / 100
        : null;

  const manufacturer = rows.get("manufacturer") ?? rows.get("manufacturer name") ?? null;
  const modelNumber =
    rows.get("model number") ??
    rows.get("item model number") ??
    rows.get("model name") ??
    null;

  const descriptionText = collapse($(DESCRIPTION).first().text());

  return {
    asin,
    title: titleText.length > 0 ? titleText : null,
    brand: extractBrand($, rows),
    price,
    mrp,
    discount,
    rating: ratingValue($),
    reviewCount: parseInteger(firstMatch($, REVIEWS)),
    availability: availabilityText($),
    description: descriptionText.length > 0 ? descriptionText : null,
    features: collectFeatures($),
    images: collectImages($),
    manufacturer,
    modelNumber,
  };
}
