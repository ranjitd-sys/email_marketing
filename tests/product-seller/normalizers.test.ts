import { describe, expect, test } from "bun:test";
import {
  extractAsin,
  extractSellerIdFromProfileUrl,
  findEmails,
  findPhones,
  isValidAsin,
  normalizeEmail,
  normalizePhone,
  normalizeProductUrl,
  normalizeSellerName,
  normalizeWebsite,
  sellerIdentityKey,
} from "../../src/product-seller/normalizers";

describe("extractAsin", () => {
  test("extracts from product path URLs", () => {
    expect(extractAsin("https://www.amazon.in/Benro-Tripod/dp/B004TRPV3G/ref=sr_1_1?qid=1")).toBe("B004TRPV3G");
    expect(extractAsin("https://www.amazon.in/dp/B004TRPV3G/")).toBe("B004TRPV3G");
    expect(extractAsin("https://www.amazon.in/gp/product/B005BY9PPQ?x=1")).toBe("B005BY9PPQ");
  });

  test("extracts from query, hidden input and JSON markers", () => {
    expect(extractAsin("https://www.amazon.in/x?asin=B00829NULW&y=2")).toBe("B00829NULW");
    expect(extractAsin('<input type="hidden" name="ASIN" value="B004TRPV3G">')).toBe("B004TRPV3G");
    expect(extractAsin('{"asin":"B005BY9PPQ"}')).toBe("B005BY9PPQ");
  });

  test("rejects values that are not valid ASINs", () => {
    expect(extractAsin("https://www.amazon.in/dp/SHORT/")).toBeNull();
    expect(extractAsin("https://www.amazon.in/dp/1234567890/")).toBeNull();
    expect(extractAsin("https://www.amazon.in/dp/ABCDEFGHIJ/")).toBeNull();
    expect(extractAsin("just some text")).toBeNull();
  });
});

describe("isValidAsin", () => {
  test("requires 10 alphanumerics with at least one letter and one digit", () => {
    expect(isValidAsin("B004TRPV3G")).toBe(true);
    expect(isValidAsin("1234567890")).toBe(false);
    expect(isValidAsin("ABCDEFGHIJ")).toBe(false);
    expect(isValidAsin("B004TRPV3")).toBe(false);
  });
});

describe("normalizeProductUrl", () => {
  test("canonicalizes to a /dp/ASIN/ URL", () => {
    expect(normalizeProductUrl("https://www.amazon.in/Benro/dp/B004TRPV3G/ref=sr_1_1?qid=123")).toBe(
      "https://www.amazon.in/dp/B004TRPV3G/"
    );
  });

  test("returns null without an ASIN", () => {
    expect(normalizeProductUrl("https://www.amazon.in/s?k=benro")).toBeNull();
  });
});

describe("seller normalization", () => {
  test("normalizes display names conservatively", () => {
    expect(normalizeSellerName("  Shutterbug   Retail  ")).toBe("Shutterbug Retail");
    expect(normalizeSellerName("'Clicktech Retail'")).toBe("Clicktech Retail");
  });

  test("builds a conservative identity key", () => {
    expect(sellerIdentityKey("Shutterbug Retail Pvt Ltd")).toBe("shutterbug retail");
    expect(sellerIdentityKey("Shutterbug Retail Private Limited")).toBe("shutterbug retail");
    expect(sellerIdentityKey("ABC Trading Co.")).toBe("abc trading");
  });

  test("extracts the seller id from a profile URL", () => {
    expect(extractSellerIdFromProfileUrl("https://www.amazon.in/sp?seller=A1SELLER001")).toBe("A1SELLER001");
    expect(extractSellerIdFromProfileUrl("/gp/help/seller/at-a-glance.html?ie=UTF8&seller=A1SELLER001&asin=X")).toBe("A1SELLER001");
    expect(extractSellerIdFromProfileUrl(undefined)).toBeNull();
  });
});

describe("contact normalization", () => {
  test("normalizes emails and rejects invalid ones", () => {
    expect(normalizeEmail(" Info@Example.COM ")).toBe("info@example.com");
    expect(normalizeEmail("<info@example.com>")).toBe("info@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
  });

  test("finds unique emails in text", () => {
    expect(findEmails("contact a@b.com and a@b.com and c@d.org")).toEqual(["a@b.com", "c@d.org"]);
  });

  test("normalizes phones without inventing country codes", () => {
    expect(normalizePhone("+91 80 1234 5678")).toBe("+918012345678");
    expect(normalizePhone("(080) 1234-5678")).toBe("08012345678");
    expect(normalizePhone("123")).toBeNull();
  });

  test("finds unique phones in text", () => {
    expect(findPhones("Call +91 80 1234 5678 or +91 80 1234 5678")).toEqual(["+918012345678"]);
  });

  test("normalizes websites", () => {
    expect(normalizeWebsite("HTTPS://Example.com/")).toBe("https://example.com");
    expect(normalizeWebsite("example.com")).toBe("https://example.com");
    expect(normalizeWebsite("not a url")).toBeNull();
  });
});
