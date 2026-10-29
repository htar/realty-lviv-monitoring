import { createHash } from "node:crypto";
import type { Store } from "./database.js";
import type { TelegramBot } from "./bot.js";
import type { IncomingMessage, Listing } from "./types.js";

/**
 * Identifies the same flat reposted in several channels.
 * Phone + rooms + price is used when a phone is known (one realtor posts many flats);
 * otherwise the post text with punctuation, emoji and spacing removed.
 */
export function listingFingerprint(listing: Listing): string {
  const basis = listing.phones?.length
    ? `phone:${[...listing.phones].sort().join(",")}|${listing.rooms ?? ""}|${listing.priceUah ?? ""}`
    : `text:${listing.text.toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 400)}`;
  return createHash("sha256").update(basis).digest("hex");
}

export type DeliveryResult = "sent" | "duplicate";

/** Sends a matched listing unless the same flat was sent recently; reports price changes on edits. */
export async function deliverListing(options: {
  store: Store; bot: Pick<TelegramBot, "sendListing">; message: IncomingMessage; listing: Listing; key: string;
}): Promise<DeliveryResult> {
  const { store, bot, message, listing, key } = options;
  const previous = store.previousPrice(message.channelId, message.messageId, key);
  const previousPrice = previous && listing.priceUah && previous !== listing.priceUah ? previous : undefined;
  const fingerprint = listingFingerprint(listing);
  if (!previousPrice && store.wasSentRecently(fingerprint)) {
    store.markNotified(key);
    return "duplicate";
  }
  await bot.sendListing(message, listing, { previousPrice });
  store.markNotified(key);
  store.rememberSent(fingerprint);
  return "sent";
}
