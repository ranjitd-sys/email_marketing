import * as cheerio from "cheerio";
import {
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
} from "./normalizers";
import type { ContactEntityType, ContactSource, ParsedContact } from "./types";

const RAW_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RAW_PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const RAW_URL = /https?:\/\/[^\s"'<>]+/g;

const MANUFACTURER_LABEL = /manufacturer\s+contact/i;
const IMPORTER_LABEL = /importer\s+contact/i;
const PACKER_LABEL = /packer\s+contact/i;
const WARRANTY_LABEL = /warranty\s+contact/i;
const SUPPORT_LABEL = /customer\s+(support|service)\s+contact/i;
const GENERIC_CONTACT_LABEL = /^contact\s+information$/i;

const SELLER_SECTION_SELECTORS = [
  "#seller-profile-container",
  "[data-testid='detailed-seller-information']",
  "#page-section-detail-seller-info",
  "#aag-detail-page-container",
];

interface Region {
  text: string;
  html: string;
  entityType: ContactEntityType;
  context: string;
  source: ContactSource;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function labelValueRegions($: cheerio.CheerioAPI): Region[] {
  const regions: Region[] = [];

  $("tr").each((_, tr) => {
    const labelNode = $(tr).find("th, td.a-span3, td").first();
    if (labelNode.length === 0) return;
    const label = collapse(labelNode.text());
    if (label.length === 0 || label.length > 80) return;

    const valueNode = $(tr).find("td").last();
    if (valueNode.length === 0) return;
    const text = collapse(valueNode.text());
    if (text.length === 0) return;
    const html = $.html(valueNode);

    if (MANUFACTURER_LABEL.test(label)) {
      regions.push({ text, html, entityType: "MANUFACTURER", context: "manufacturer_contact", source: "product_page" });
    } else if (IMPORTER_LABEL.test(label)) {
      regions.push({ text, html, entityType: "OTHER", context: "importer_contact", source: "product_page" });
    } else if (PACKER_LABEL.test(label)) {
      regions.push({ text, html, entityType: "OTHER", context: "packer_contact", source: "product_page" });
    } else if (WARRANTY_LABEL.test(label)) {
      regions.push({ text, html, entityType: "WARRANTY", context: "warranty_contact", source: "product_page" });
    } else if (SUPPORT_LABEL.test(label)) {
      regions.push({ text, html, entityType: "CUSTOMER_SUPPORT", context: "customer_support_contact", source: "product_page" });
    } else if (GENERIC_CONTACT_LABEL.test(label)) {
      regions.push({ text, html, entityType: "UNKNOWN", context: "generic_contact", source: "product_page" });
    }
  });

  return regions;
}

function sellerSectionRegions($: cheerio.CheerioAPI): Region[] {
  const regions: Region[] = [];
  for (const selector of SELLER_SECTION_SELECTORS) {
    $(selector).each((_, node) => {
      const text = collapse($(node).text());
      if (text.length === 0) return;
      regions.push({
        text,
        html: $.html(node),
        entityType: "SELLER",
        context: "seller_business_contact",
        source: "seller_profile",
      });
    });
  }
  return regions;
}

function collectFromText(
  region: Region,
  sourceUrl: string
): ParsedContact[] {
  const contacts: ParsedContact[] = [];

  const push = (
    type: ParsedContact["type"],
    raw: string,
    normalized: string | null
  ) => {
    if (normalized) {
      contacts.push({
        type,
        value: collapse(raw),
        normalizedValue: normalized,
        source: region.source,
        sourceUrl,
        context: region.context,
        entityType: region.entityType,
        entityId: null,
        verificationStatus: "VALID_FORMAT",
      });
    } else {
      contacts.push({
        type,
        value: collapse(raw),
        normalizedValue: collapse(raw).toLowerCase(),
        source: region.source,
        sourceUrl,
        context: region.context,
        entityType: region.entityType,
        entityId: null,
        verificationStatus: "REJECTED",
      });
    }
  };

  for (const raw of region.text.match(RAW_EMAIL) ?? []) {
    if (!raw) continue;
    push("EMAIL", raw, normalizeEmail(raw));
  }

  for (const raw of region.text.match(RAW_URL) ?? []) {
    if (!raw) continue;
    if (/amazon\./i.test(raw) || /media-amazon|ssl-images/i.test(raw)) continue;
    const website = normalizeWebsite(raw);
    push("WEBSITE", raw, website);
  }

  for (const raw of region.text.match(RAW_PHONE) ?? []) {
    if (!raw) continue;
    const around = region.text.slice(
      Math.max(0, region.text.indexOf(raw) - 24),
      region.text.indexOf(raw) + raw.length + 24
    );
    if (!/phone|tel|call|contact|mobile|whatsapp/i.test(around)) continue;
    push("PHONE", raw, normalizePhone(raw));
  }

  return contacts;
}

function collectFromAnchors(
  regions: Region[],
  sourceUrl: string
): ParsedContact[] {
  const contacts: ParsedContact[] = [];
  for (const region of regions) {
    const scoped = cheerio.load(region.html);
    scoped('a[href^="mailto:"], a[href^="tel:"]').each((_, a) => {
      const href = scoped(a).attr("href") ?? "";
      const raw = href.replace(/^(mailto:|tel:)/i, "").split("?")[0] ?? "";
      if (raw.length === 0) return;
      const type = href.toLowerCase().startsWith("mailto:") ? "EMAIL" : "PHONE";
      const normalized = type === "EMAIL" ? normalizeEmail(raw) : normalizePhone(raw);
      contacts.push({
        type,
        value: collapse(raw),
        normalizedValue: normalized ?? collapse(raw).toLowerCase(),
        source: region.source,
        sourceUrl,
        context: region.context,
        entityType: region.entityType,
        entityId: null,
        verificationStatus: normalized ? "VALID_FORMAT" : "REJECTED",
      });
    });
  }
  return contacts;
}

export function extractPublicContacts(html: string, sourceUrl: string): ParsedContact[] {
  if (typeof html !== "string" || html.length === 0) return [];
  const $ = cheerio.load(html);

  const regions = [...labelValueRegions($), ...sellerSectionRegions($)];
  if (regions.length === 0) return [];

  const contacts: ParsedContact[] = [];
  for (const region of regions) {
    contacts.push(...collectFromText(region, sourceUrl));
    contacts.push(...collectFromAnchors([region], sourceUrl));
  }

  const deduped = new Map<string, ParsedContact>();
  for (const contact of contacts) {
    const key = [
      contact.type,
      contact.normalizedValue,
      contact.source,
      contact.context,
      contact.entityType,
      contact.entityId ?? 0,
    ].join("|");
    if (!deduped.has(key)) deduped.set(key, contact);
  }

  return [...deduped.values()];
}
