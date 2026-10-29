export type DealType = "rent" | "sale" | "unknown";
export type PropertyType = "apartment" | "house" | "room" | "unknown";

export interface SearchConfig {
  channels: string[];
  filters: {
    dealType: "rent";
    propertyTypes: PropertyType[];
    city: string;
    districts: string[];
    rooms: number[];
    maxPriceUah: number;
    requireExplicitDistrict: boolean;
    /** Listings containing any of these words are rejected. */
    excludeKeywords?: string[];
    /** Reject likely broker/commission listings instead of only flagging them. */
    hideBrokers?: boolean;
    /** Extra words (microdistricts, streets) that identify a district, keyed by district name. */
    districtAliases?: Record<string, string[]>;
  };
}

export interface Listing {
  dealType: DealType;
  propertyType: PropertyType;
  city?: string;
  district?: string;
  /** Street or locality the district was inferred from, e.g. "вулиця Замарстинівська". */
  location?: string;
  rooms?: number;
  priceUah?: number;
  currency?: "UAH" | "USD" | "EUR";
  /** Price as written when it was not in UAH, e.g. 450 (USD). */
  originalPrice?: number;
  phones?: string[];
  isLikelyBroker: boolean;
  isDemandPost: boolean;
  text: string;
}

export interface IncomingMessage {
  channel: string;
  channelId: string;
  messageId: number;
  text: string;
  date: Date;
  link: string;
  edited: boolean;
}
