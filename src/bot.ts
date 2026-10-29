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
          const [rawCommand, ...rawArgs] = String(msg.text).trim().split(/\s+/);
          const command = rawCommand?.split("@")[0]?.toLowerCase();
          const args = rawArgs.join(" ").trim();
          if (command === "/start" || command === "/help") text = this.helpText();
          if (command === "/filters") text = this.filtersText(config);
          if (msg.text.startsWith("/status")) {
            const s = store.stats();
            text = `📊 Оброблено: ${s.processed}\nЗбігів: ${s.matched ?? 0}\nНадіслано: ${s.notified ?? 0}`;
          }
          if (command === "/budget") {
            const value = Number(args.replace(/\s/g, ""));
            if (!Number.isInteger(value) || value < 1000 || value > 1_000_000) {
              text = "❌ Вкажіть бюджет цілим числом, наприклад: /budget 22000";
            } else {
              config.filters.maxPriceUah = value;
              store.saveFilters(config.filters);
              text = `✅ Максимальний бюджет: ${value.toLocaleString("uk-UA")} грн`;
            }
          }
          if (command === "/rooms") {
            const rooms = [...new Set(args.split(/[,;\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10))].sort((a, b) => a - b);
            if (rooms.length === 0) {
              text = "❌ Вкажіть кімнати, наприклад: /rooms 1,2";
            } else {
              config.filters.rooms = rooms;
              store.saveFilters(config.filters);
              text = `✅ Кімнатність: ${rooms.join(", ")}`;
            }
          }
          if (command === "/district") {
            const districts = [...new Set(args.split(/[,;]+/).map((x) => x.trim()).filter(Boolean))];
            if (districts.length === 0) {
              text = "❌ Вкажіть район, наприклад: /district Шевченківський";
            } else {
              config.filters.districts = districts;
              store.saveFilters(config.filters);
              text = `✅ Райони: ${districts.join(", ")}`;
            }
          }
          if (command === "/strict") {
            const value = args.toLowerCase();
            if (!["on", "off"].includes(value)) {
              text = "❌ Використання: /strict on або /strict off";
            } else {
              config.filters.requireExplicitDistrict = value === "on";
              store.saveFilters(config.filters);
              text = value === "on"
                ? "✅ Оголошення повинно явно містити район"
                : "✅ Прийматимуться також оголошення без зазначеного району";
            }
          }
          if (command === "/channels") {
            text = config.channels.length
              ? `📡 <b>Активні джерела (${config.channels.length})</b>\n${config.channels.map((item) => `• @${escapeHtml(item)}`).join("\n")}`
              : "⚠️ Немає активних каналів. Додайте: /channeladd @username";
          }
          if (command === "/channeladd") {
            const channel = this.parseChannelUsername(args);
            if (!channel) {
              text = "❌ Вкажіть публічний username, наприклад: /channeladd @direct_rent";
            } else if (config.channels.some((item) => item.toLowerCase() === channel.toLowerCase())) {
              text = `ℹ️ @${escapeHtml(channel)} уже активний`;
            } else {
              config.channels.push(channel);
              store.saveChannels(config.channels);
              text = `✅ Канал @${escapeHtml(channel)} додано до моніторингу`;
            }
          }
          if (command === "/channelremove") {
            const channel = this.parseChannelUsername(args);
            if (!channel) {
              text = "❌ Вкажіть username, наприклад: /channelremove @direct_rent";
            } else {
              const before = config.channels.length;
              config.channels = config.channels.filter((item) => item.toLowerCase() !== channel.toLowerCase());
              if (config.channels.length === before) {
                text = `ℹ️ @${escapeHtml(channel)} не був активним`;
              } else {
                store.saveChannels(config.channels);
                text = `✅ Канал @${escapeHtml(channel)} вимкнено`;
              }
            }
          }
          if (command === "/channelhelp") {
            text = "🔐 <b>Керування джерелами</b>\n/channels — активні канали\n/channeladd @username — додати або увімкнути\n/channelremove @username — вимкнути";
          }
          if (text) await this.call("sendMessage", { chat_id: this.chatId, text, parse_mode: "HTML" });
        }
      } catch (error) {
        if (!this.stopped) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop(): void { this.stopped = true; }

  private filtersText(config: SearchConfig): string {
    const strict = config.filters.requireExplicitDistrict ? "так" : "ні";
    return `🔎 <b>Поточні фільтри</b>\n📍 ${escapeHtml(config.filters.city)}: ${escapeHtml(config.filters.districts.join(", "))}\n🏠 Кімнати: ${config.filters.rooms.join(", ")}\n💰 До ${config.filters.maxPriceUah.toLocaleString("uk-UA")} грн/міс.\n🎯 Район обов'язковий: ${strict}`;
  }

  private helpText(): string {
    return "✅ Real Estate Radar працює.\n\nКоманди:\n/filters — поточні фільтри\n/budget 22000 — максимальна ціна\n/rooms 1,2 — кімнатність\n/district Шевченківський — район; декілька через кому\n/strict on — вимагати район\n/strict off — дозволити оголошення без району\n/status — статистика\n/help — ця довідка";
  }

  private parseChannelUsername(value: string): string | undefined {
    const username = value.trim().replace(/^https?:\/\/(?:t|telegram)\.me\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
    return username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : undefined;
  }
}
