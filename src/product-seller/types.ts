export const WORK_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const CONTACT_TYPES = ["EMAIL", "PHONE", "WEBSITE"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const ENTITY_TYPES = [
  "SELLER",
  "MANUFACTURER",
  "BRAND",
  "WARRANTY",
  "CUSTOMER_SUPPORT",
  "OTHER",
  "UNKNOWN",
] as const;
export type ContactEntityType = (typeof ENTITY_TYPES)[number];

export const CONTACT_SOURCES = [
  "product_page",
  "seller_profile",
  "manufacturer_contact",
  "brand_page",
] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const VERIFICATION_STATUSES = [
  "UNVERIFIED",
  "VALID_FORMAT",
  "VERIFIED_PUBLIC_ASSOCIATION",
  "REJECTED",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface WorkTarget {
  categoryId: number;
  categoryName: string;
  categoryUrl: string;
  brandId: number;
  brandName: string;
  brandNormalizedName: string;
  attempts: number;
  claimOrigin: "pending" | "reclaimed";
}

export interface WorkClaimResult {
  claimed: WorkTarget[];
  reclaimed: number;
  exhaustedMarkedFailed: number;
}

export interface ParsedProductEntry {
  asin: string;
  url: string;
  title: string | null;
  sponsored: boolean;
}

export interface ProductResultPage {
  products: ParsedProductEntry[];
  nextPageUrl: string | null;
}

export interface ParsedProduct {
  asin: string;
  title: string | null;
  brand: string | null;
  price: number | null;
  mrp: number | null;
  discount: number | null;
  rating: number | null;
  reviewCount: number | null;
  availability: string | null;
  description: string | null;
  features: string[];
  images: string[];
  manufacturer: string | null;
  modelNumber: string | null;
}

export interface ParsedSeller {
  name: string;
  normalizedName: string;
  externalId: string | null;
  profileUrl: string | null;
}

export interface ParsedSellerProfile {
  name: string | null;
  legalName: string | null;
  businessName: string | null;
  businessAddress: string | null;
  website: string | null;
}

export interface ParsedContact {
  type: ContactType;
  value: string;
  normalizedValue: string;
  source: ContactSource;
  sourceUrl: string;
  context: string;
  entityType: ContactEntityType;
  entityId: number | null;
  verificationStatus: VerificationStatus;
}

export interface ProductDiscoveryResult {
  entries: ParsedProductEntry[];
  pagesFetched: number;
  nextPageUrl: string | null;
}

export interface SellerWithSources {
  seller: ParsedSeller;
  contacts: ParsedContact[];
}

export interface PersistWorkInput {
  categoryId: number;
  brandId: number;
  workerId: string;
  products: Array<{ product: ParsedProduct; seller: ParsedSeller | null; sellerContacts: ParsedContact[] }>;
}

export interface PersistWorkResult {
  productsSeen: number;
  uniqueProducts: number;
  productsInserted: number;
  categoryProductLinks: number;
  brandProductLinks: number;
  sellersSeen: number;
  uniqueSellers: number;
  sellerProductLinks: number;
  contactsSeen: number;
  contactsAccepted: number;
  contactsRejected: number;
  contactsUnattributed: number;
}

export interface WorkStateCounts {
  pendingWork: number;
  processingWork: number;
  completedWork: number;
  failedWork: number;
  totalWork: number;
}

export interface ProductSellerBatchSummary {
  processedCategoryBrandCount: number;
  failedCount: number;
  reclaimedCount: number;
  productsDiscovered: number;
  uniqueProducts: number;
  sellersDiscovered: number;
  uniqueSellers: number;
  sellerProductRelationships: number;
  contactsDiscovered: number;
  contactsAccepted: number;
  contactsRejected: number;
  remainingPendingWork: number;
  pendingWork: number;
  processingWork: number;
  completedWork: number;
  failedWork: number;
  totalProducts: number;
  totalSellers: number;
  totalContacts: number;
}
