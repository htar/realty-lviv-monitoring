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
  };
}

export interface Listing {
  dealType: DealType;
  propertyType: PropertyType;
  city?: string;
  district?: string;
  rooms?: number;
  priceUah?: number;
  currency?: "UAH" | "USD" | "EUR";
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
