import * as cheerio from "cheerio";
import { AMAZON_IN_ORIGIN } from "../config/env";
import { extractSellerIdFromProfileUrl, normalizeSellerName, sellerIdentityKey } from "./normalizers";
import type { ParsedSeller, ParsedSellerProfile } from "./types";

const SELLER_TRIGGER = "#sellerProfileTriggerId";
const SELLER_TRIGGER_FALLBACK = 'a[href*="seller="]';
const SELLER_NAME = "#sellerName, [data-testid='seller-name']";
const BUSINESS_LABELS = /^(business name|legal name|registered name)$/i;
const ADDRESS_LABELS = /^(business address|registered address|address)$/i;
const SPEC_LABEL = "th.prodDetSectionEntry, td.a-span3, .a-text-bold";

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function absoluteUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, AMAZON_IN_ORIGIN).toString();
  } catch {
    return null;
  }
}

export function parseSellerFromProductPage(html: string): ParsedSeller | null {
  const $ = cheerio.load(html);

  let anchor = $(SELLER_TRIGGER).first();
  if (anchor.length === 0) {
    anchor = $(SELLER_TRIGGER_FALLBACK).first();
  }
  if (anchor.length === 0) return null;

  const name = normalizeSellerName(anchor.text());
  if (name.length === 0) return null;

  const href = anchor.attr("href");
  const externalId = extractSellerIdFromProfileUrl(href ?? null);

  return {
    name,
    normalizedName: sellerIdentityKey(name),
    externalId,
    profileUrl: externalId ? `${AMAZON_IN_ORIGIN}/sp?seller=${externalId}` : absoluteUrl(href),
  };
}

export function parseSellerProfile(html: string): ParsedSellerProfile | null {
  if (typeof html !== "string" || html.length === 0) return null;
  const $ = cheerio.load(html);

  let name: string | null = null;
  const nameNode = $(SELLER_NAME).first();
  if (nameNode.length > 0) {
    name = collapse(nameNode.text()) || null;
  }
  if (!name) {
    const title = collapse($("title").first().text());
    const match = /Seller Profile:\s*(.+)$/i.exec(title);
    if (match?.[1]) name = collapse(match[1]) || null;
  }

  let legalName: string | null = null;
  let businessName: string | null = null;
  let businessAddress: string | null = null;

  $("tr, li").each((_, row) => {
    const labelNode = $(row).find(SPEC_LABEL).first();
    if (labelNode.length === 0) return;
    const label = collapse(labelNode.text());
    if (label.length === 0 || label.length > 60) return;
    const value = collapse(
      $(row).find("td").last().text() || $(row).clone().children().last().text()
    );
    if (value.length === 0) return;

    if (BUSINESS_LABELS.test(label)) {
      if (/legal|registered/i.test(label)) legalName = value;
      else businessName = value;
    } else if (ADDRESS_LABELS.test(label)) {
      businessAddress = value;
    }
  });

  let website: string | null = null;
  const siteNode = $('a[href^="http"]')
    .toArray()
    .map((a) => $(a).attr("href") ?? "")
    .find((href) => !/amazon\./i.test(href) && !/media-amazon|ssl-images/i.test(href));
  if (siteNode) website = siteNode;

  if (!name && !legalName && !businessName && !businessAddress && !website) return null;

  return { name, legalName, businessName, businessAddress, website };
}
