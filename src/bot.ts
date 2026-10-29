import type { Listing, SearchConfig, IncomingMessage } from "./types.js";
import type { Store } from "./database.js";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class TelegramBot {
  private offset = 0;
  private stopped = false;
  constructor(private readonly token: string, private readonly chatId: string) {}

  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000)
    });
    const data = await response.json() as any;
    if (!response.ok || !data.ok) throw new Error(`Bot API ${method}: ${data.description ?? response.statusText}`);
    return data.result;
  }

  async sendListing(message: IncomingMessage, listing: Listing): Promise<void> {
    const price = listing.priceUah?.toLocaleString("uk-UA") ?? "—";
    const excerpt = escapeHtml(message.text.slice(0, 750));
    await this.call("sendMessage", {
      chat_id: this.chatId, parse_mode: "HTML", disable_web_page_preview: false,
      text: `🏠 <b>Нова відповідна квартира</b>\n\n<b>${listing.rooms}-кімнатна · ${escapeHtml(listing.district ?? "Львів")}</b>\n💰 <b>${price} грн/міс.</b>\n📣 @${escapeHtml(message.channel)}${listing.isLikelyBroker ? "\n⚠️ Ймовірно посередник/комісія" : ""}\n\n${excerpt}\n\n<a href="${message.link}">Відкрити оригінал</a>`
    });
  }

  async runCommands(store: Store, config: SearchConfig): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.call("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text || String(msg.chat.id) !== this.chatId) continue;
          let text: string | undefined;
          if (msg.text.startsWith("/start")) text = "✅ Real Estate Radar працює. Команди: /filters, /status";
          if (msg.text.startsWith("/filters")) text = `🔎 Львів, Шевченківський район\n🏠 1–2 кімнати, оренда\n💰 до ${config.filters.maxPriceUah.toLocaleString("uk-UA")} грн`;
          if (msg.text.startsWith("/status")) {
            const s = store.stats();
            text = `📊 Оброблено: ${s.processed}\nЗбігів: ${s.matched ?? 0}\nНадіслано: ${s.notified ?? 0}`;
          }
          if (text) await this.call("sendMessage", { chat_id: this.chatId, text });
        }
      } catch (error) {
        if (!this.stopped) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop(): void { this.stopped = true; }
}
