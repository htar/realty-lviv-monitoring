import type { Listing, SearchConfig, IncomingMessage } from "./types.js";
import type { Store } from "./database.js";
import type { HistoryScanSummary } from "./history.js";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class TelegramBot {
  private offset = 0;
  private stopped = false;
  private activeRescan?: Promise<void>;
  constructor(private readonly token: string, private readonly chatId: string,
    private readonly rescan?: (days: number) => Promise<HistoryScanSummary>,
    private readonly retryDelayMs = 3000) {}

  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000)
    });
    const data = await response.json() as any;
    if (!response.ok || !data.ok) throw new Error(`Bot API ${method}: ${data.description ?? response.statusText}`);
    return data.result;
  }

  async sendListing(message: IncomingMessage, listing: Listing, options: { previousPrice?: number } = {}): Promise<void> {
    const price = listing.priceUah?.toLocaleString("uk-UA") ?? "—";
    const excerpt = escapeHtml(message.text.slice(0, 750));
    const original = listing.originalPrice && listing.currency && listing.currency !== "UAH"
      ? ` (${listing.originalPrice} ${listing.currency})` : "";
    const header = options.previousPrice
      ? `💸 <b>Змінилась ціна: ${options.previousPrice.toLocaleString("uk-UA")} → ${price} грн</b>`
      : "🏠 <b>Нова відповідна квартира</b>";
    const lines = [
      header, "",
      `<b>${listing.rooms}-кімнатна · ${escapeHtml(listing.district ?? "Львів")}</b>`,
      ...(listing.location ? [`📍 ${escapeHtml(listing.location)} (район визначено за адресою)`] : []),
      `💰 <b>${price} грн/міс.</b>${original}`,
      message.channelId.startsWith("site:") ? `🌐 ${escapeHtml(message.channel)}` : `📣 @${escapeHtml(message.channel)}`,
      ...(listing.phones?.length ? [`📞 ${listing.phones.join(", ")}`] : []),
      ...(listing.isLikelyBroker ? ["⚠️ Ймовірно посередник/комісія"] : []),
      "", excerpt, "", `<a href="${message.link}">Відкрити оригінал</a>`
    ];
    await this.call("sendMessage", {
      chat_id: this.chatId, parse_mode: "HTML", disable_web_page_preview: false,
      text: lines.join("\n"),
      reply_markup: { inline_keyboard: [[
        { text: "⭐ Зберегти", callback_data: `fav:${message.channelId}:${message.messageId}`.slice(0, 64) },
        { text: "🙈 Сховати", callback_data: "hide" }
      ]] }
    });
  }

  /** Handles taps on the inline buttons under a listing. */
  private async handleCallback(query: any, store: Store): Promise<void> {
    if (String(query.message?.chat?.id) !== this.chatId) return;
    const data = String(query.data ?? "");
    let answer = "";
    if (data === "hide") {
      await this.call("deleteMessage", { chat_id: this.chatId, message_id: query.message.message_id });
    } else if (data.startsWith("fav:")) {
      const [, channelId, messageId] = data.split(":");
      answer = store.addFavorite(channelId!, Number(messageId)) ? "⭐ Збережено. Список: /saved" : "Уже в збережених";
    }
    await this.call("answerCallbackQuery", { callback_query_id: query.id, text: answer });
  }

  async runCommands(store: Store, config: SearchConfig): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.call("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.callback_query) {
            await this.handleCallback(update.callback_query, store).catch((error) =>
              console.error("Callback failed:", error instanceof Error ? error.message : error));
            continue;
          }
          const msg = update.message;
          if (!msg?.text || String(msg.chat.id) !== this.chatId) continue;
          const [rawCommand, ...rawArgs] = String(msg.text).trim().split(/\s+/);
          const command = rawCommand?.split("@")[0]?.toLowerCase() ?? "";
          const handler = this.commands[command];
          if (!handler) continue;
          const text = handler.call(this, rawArgs.join(" ").trim(), store, config);
          if (text) await this.send(text);
        }
      } catch (error) {
        console.error("Bot API polling failed:", error instanceof Error ? error.message : error);
        if (!this.stopped) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    await this.activeRescan;
  }

  /** Sends a plain HTML message to the configured chat (used by the scheduler). */
  async sendText(text: string): Promise<void> { await this.send(text); }

  private send(text: string): Promise<unknown> {
    return this.call("sendMessage", { chat_id: this.chatId, text, parse_mode: "HTML" });
  }

  private updateFilters(store: Store, config: SearchConfig, patch: Partial<SearchConfig["filters"]>): void {
    Object.assign(config.filters, patch);
    store.saveFilters(config.filters);
  }

  private readonly commands: Record<string, (this: TelegramBot, args: string, store: Store, config: SearchConfig) => string | undefined> = {
    "/start": () => this.helpText(),
    "/help": () => this.helpText(),
    "/filters": (_args, _store, config) => this.filtersText(config),
    "/status": (_args, store) => {
      const s = store.stats();
      return `📊 Оброблено: ${s.processed}\nЗбігів: ${s.matched ?? 0}\nНадіслано: ${s.notified ?? 0}`;
    },
    "/budget": (args, store, config) => {
      const value = Number(args.replace(/\s/g, ""));
      if (!Number.isInteger(value) || value < 1000 || value > 1_000_000) return "❌ Вкажіть бюджет цілим числом, наприклад: /budget 22000";
      this.updateFilters(store, config, { maxPriceUah: value });
      return `✅ Максимальний бюджет: ${value.toLocaleString("uk-UA")} грн`;
    },
    "/rooms": (args, store, config) => {
      const rooms = [...new Set(args.split(/[,;\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10))].sort((a, b) => a - b);
      if (rooms.length === 0) return "❌ Вкажіть кімнати, наприклад: /rooms 1,2";
      this.updateFilters(store, config, { rooms });
      return `✅ Кімнатність: ${rooms.join(", ")}`;
    },
    "/district": (args, store, config) => {
      const districts = [...new Set(args.split(/[,;]+/).map((x) => x.trim()).filter(Boolean))];
      if (districts.length === 0) return "❌ Вкажіть район, наприклад: /district Шевченківський";
      this.updateFilters(store, config, { districts });
      return `✅ Райони: ${districts.join(", ")}`;
    },
    "/strict": (args, store, config) => {
      const value = args.toLowerCase();
      if (!["on", "off"].includes(value)) return "❌ Використання: /strict on або /strict off";
      this.updateFilters(store, config, { requireExplicitDistrict: value === "on" });
      return value === "on"
        ? "✅ Оголошення повинно явно містити район"
        : "✅ Прийматимуться також оголошення без зазначеного району";
    },
    "/channels": (_args, _store, config) => config.channels.length
      ? `📡 <b>Активні джерела (${config.channels.length})</b>\n${config.channels.map((item) => `• @${escapeHtml(item)}`).join("\n")}`
      : "⚠️ Немає активних каналів. Додайте: /channeladd @username",
    "/channeladd": (args, store, config) => {
      const channel = this.parseChannelUsername(args);
      if (!channel) return "❌ Вкажіть публічний username, наприклад: /channeladd @direct_rent";
      if (config.channels.some((item) => item.toLowerCase() === channel.toLowerCase())) return `ℹ️ @${escapeHtml(channel)} уже активний`;
      config.channels.push(channel);
      store.saveChannels(config.channels);
      return `✅ Канал @${escapeHtml(channel)} додано до моніторингу`;
    },
    "/channelremove": (args, store, config) => {
      const channel = this.parseChannelUsername(args);
      if (!channel) return "❌ Вкажіть username, наприклад: /channelremove @direct_rent";
      const before = config.channels.length;
      config.channels = config.channels.filter((item) => item.toLowerCase() !== channel.toLowerCase());
      if (config.channels.length === before) return `ℹ️ @${escapeHtml(channel)} не був активним`;
      store.saveChannels(config.channels);
      return `✅ Канал @${escapeHtml(channel)} вимкнено`;
    },
    "/exclude": (args, store, config) => {
      if (!args) {
        const words = config.filters.excludeKeywords ?? [];
        return words.length
          ? `🚫 Слова-виключення: ${escapeHtml(words.join(", "))}\nОчистити: /exclude off`
          : "🚫 Слів-виключень немає. Додати: /exclude подобово, хостел";
      }
      if (args.toLowerCase() === "off") {
        this.updateFilters(store, config, { excludeKeywords: [] });
        return "✅ Слова-виключення очищено";
      }
      const added = args.split(/[,;]+/).map((x) => x.trim().toLocaleLowerCase("uk-UA")).filter(Boolean);
      const words = [...new Set([...(config.filters.excludeKeywords ?? []), ...added])];
      this.updateFilters(store, config, { excludeKeywords: words });
      return `✅ Слова-виключення: ${escapeHtml(words.join(", "))}`;
    },
    "/nobroker": (args, store, config) => {
      const value = args.toLowerCase();
      if (!["on", "off"].includes(value)) return "❌ Використання: /nobroker on або /nobroker off";
      this.updateFilters(store, config, { hideBrokers: value === "on" });
      return value === "on" ? "✅ Оголошення посередників приховуються" : "✅ Оголошення посередників показуються з позначкою";
    },
    "/saved": (_args, store) => {
      const items = store.favorites();
      if (items.length === 0) return "⭐ Збережених оголошень немає. Натисніть «⭐ Зберегти» під оголошенням.";
      return `⭐ <b>Збережені (${items.length})</b>\n${items.map((item, index) =>
        `${index + 1}. ${item.listing.rooms ?? "?"}-кімн. · ${item.listing.priceUah?.toLocaleString("uk-UA") ?? "—"} грн · <a href="${item.link}">відкрити</a>`).join("\n")}\n\nВидалити: /unsave номер`;
    },
    "/unsave": (args, store) => {
      const item = store.favorites()[Number(args) - 1];
      if (!item) return "❌ Вкажіть номер зі списку /saved, наприклад: /unsave 1";
      store.removeFavorite(item.channelId, item.messageId);
      return `✅ Видалено з збережених: ${item.link}`;
    },
    "/why": (args, store) => {
      const days = Number(args || "7");
      if (!Number.isInteger(days) || days < 1 || days > 90) return "❌ Вкажіть від 1 до 90 днів, наприклад: /why 7";
      const reasons = store.topReasons(new Date(Date.now() - days * 86_400_000));
      if (reasons.length === 0) return "ℹ️ Немає даних про відхилені оголошення за цей період";
      return `🔍 <b>Чому відхилялись оголошення (${days} дн.)</b>\n${reasons.map((r) => `${r.count} — ${escapeHtml(r.reason)}`).join("\n")}`;
    },
    "/channelhelp": () => "🔐 <b>Керування джерелами</b>\n/channels — активні канали\n/channeladd @username — додати або увімкнути\n/channelremove @username — вимкнути",
    "/rescan": (args) => {
      const days = Number(args || "2");
      if (!Number.isInteger(days) || days < 1 || days > 30) return "❌ Вкажіть від 1 до 30 днів, наприклад: /rescan 2";
      if (!this.rescan) return "❌ Історичне сканування недоступне в цьому режимі";
      if (this.activeRescan) return "⏳ Історичне сканування вже виконується";
      this.activeRescan = this.runRescan(days).finally(() => { this.activeRescan = undefined; });
      return undefined;
    }
  };

  // Runs in the background so other commands keep working during a long scan.
  private async runRescan(days: number): Promise<void> {
    let text: string;
    try {
      await this.send(`🔄 Перевіряю активні канали за ${days} дн.`);
      const summary = await this.rescan!(days);
      text = `✅ <b>Повторна перевірка завершена</b>\nПеріод: ${summary.firstDay} — ${summary.lastDay}\nПереглянуто: ${summary.scanned}\nНових версій: ${summary.newVersions}\nЗбігів: ${summary.matched}\nДоставлено/повторено: ${summary.notified}\nПомилок каналів: ${summary.failedChannels}${summary.failedNotifications ? `
Не надіслано: ${summary.failedNotifications}` : ""}`;
    } catch (error) {
      text = `❌ Сканування не завершено: ${error instanceof Error ? escapeHtml(error.message) : "невідома помилка"}`;
    }
    await this.send(text).catch((error) => console.error("Failed to send rescan result:", error));
  }

  stop(): void { this.stopped = true; }

  private filtersText(config: SearchConfig): string {
    const strict = config.filters.requireExplicitDistrict ? "так" : "ні";
    return `🔎 <b>Поточні фільтри</b>\n📍 ${escapeHtml(config.filters.city)}: ${escapeHtml(config.filters.districts.join(", "))}\n🏠 Кімнати: ${config.filters.rooms.join(", ")}\n💰 До ${config.filters.maxPriceUah.toLocaleString("uk-UA")} грн/міс.\n🎯 Район обов'язковий: ${strict}\n🧑‍💼 Посередники: ${config.filters.hideBrokers ? "приховані" : "з позначкою"}\n🚫 Виключення: ${escapeHtml((config.filters.excludeKeywords ?? []).join(", ") || "немає")}`;
  }

  private helpText(): string {
    return "✅ Real Estate Radar працює.\n\nКоманди:\n/filters — поточні фільтри\n/budget 22000 — максимальна ціна\n/rooms 1,2 — кімнатність\n/district Шевченківський — район; декілька через кому\n/strict on — вимагати район\n/strict off — дозволити оголошення без району\n/nobroker on — приховувати посередників\n/exclude подобово, хостел — слова-виключення\n/saved — збережені оголошення\n/why 7 — чому відхилялись оголошення\n/rescan 2 — знайти пропущені оголошення\n/status — статистика\n/help — ця довідка";
  }

  private parseChannelUsername(value: string): string | undefined {
    const username = value.trim().replace(/^https?:\/\/(?:t|telegram)\.me\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
    return username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : undefined;
  }
}
