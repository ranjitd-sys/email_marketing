import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseSellerFromProductPage, parseSellerProfile } from "../../src/product-seller/seller-parser";
import { extractPublicContacts } from "../../src/product-seller/contact-parser";

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

describe("parseSellerFromProductPage", () => {
  test("extracts seller name, external id and profile url", async () => {
    const seller = parseSellerFromProductPage(await fixture("product.html"));
    expect(seller).not.toBeNull();
    expect(seller?.name).toBe("Shutterbug Retail Pvt Ltd");
    expect(seller?.externalId).toBe("A1SELLER001");
    expect(seller?.normalizedName).toBe("shutterbug retail");
    expect(seller?.profileUrl).toBe("https://www.amazon.in/sp?seller=A1SELLER001");
  });

  test("returns null when no seller is exposed", () => {
    expect(parseSellerFromProductPage("<html><body>No seller here</body></html>")).toBeNull();
  });
});

describe("parseSellerProfile", () => {
  test("extracts public business information", async () => {
    const profile = parseSellerProfile(await fixture("seller-profile.html"));
    expect(profile?.name).toBe("Shutterbug Retail Pvt Ltd");
    expect(profile?.businessName).toBe("Shutterbug Retail Private Limited");
    expect(profile?.businessAddress).toBe("123 Camera Street, Bengaluru, Karnataka 560001, India");
    expect(profile?.website).toContain("shutterbug.example");
  });

  test("returns null when nothing is exposed", () => {
    expect(parseSellerProfile("<html><body>Nothing</body></html>")).toBeNull();
  });
});

describe("extractPublicContacts", () => {
  test("attributes manufacturer contacts to MANUFACTURER, never SELLER", async () => {
    const contacts = extractPublicContacts(
      await fixture("product-with-contacts.html"),
      "https://www.amazon.in/dp/B004TRPV3G/"
    );

    const manufacturer = contacts.find((c) => c.normalizedValue === "support@benro-manufacturer.example");
    expect(manufacturer?.entityType).toBe("MANUFACTURER");
    expect(manufacturer?.context).toBe("manufacturer_contact");
    expect(manufacturer?.source).toBe("product_page");
    expect(manufacturer?.verificationStatus).toBe("VALID_FORMAT");
    expect(contacts.some((c) => c.entityType === "SELLER")).toBe(false);
  });

  test("classifies customer support and generic contacts distinctly", async () => {
    const contacts = extractPublicContacts(
      await fixture("product-with-contacts.html"),
      "https://www.amazon.in/dp/B004TRPV3G/"
    );

    expect(contacts.find((c) => c.normalizedValue === "helpdesk@benro-support.example")?.entityType).toBe(
      "CUSTOMER_SUPPORT"
    );
    expect(contacts.find((c) => c.normalizedValue === "reachus@example.com")?.entityType).toBe("UNKNOWN");
  });

  test("extracts seller contacts from a seller profile and attributes them to SELLER", async () => {
    const contacts = extractPublicContacts(
      await fixture("seller-profile.html"),
      "https://www.amazon.in/sp?seller=A1SELLER001"
    );

    const email = contacts.find((c) => c.normalizedValue === "seller-support@shutterbug.example");
    expect(email?.entityType).toBe("SELLER");
    expect(email?.context).toBe("seller_business_contact");
    expect(email?.source).toBe("seller_profile");

    const website = contacts.find((c) => c.type === "WEBSITE");
    expect(website?.entityType).toBe("SELLER");
  });

  test("does not dedupe the same value across different contexts", async () => {
    const contacts = extractPublicContacts(
      await fixture("product-with-contacts.html"),
      "https://www.amazon.in/dp/B004TRPV3G/"
    );
    const emails = contacts.filter((c) => c.type === "EMAIL");
    expect(new Set(emails.map((c) => c.normalizedValue)).size).toBe(emails.length);
  });

  test("returns nothing when no contact regions exist", async () => {
    const contacts = extractPublicContacts(await fixture("product.html"), "https://www.amazon.in/dp/B004TRPV3G/");
    expect(contacts).toEqual([]);
  });

  test("returns nothing for empty input", () => {
    expect(extractPublicContacts("", "https://www.amazon.in/")).toEqual([]);
  });
});
