import "dotenv/config";

const token = process.env.BOT_TOKEN?.trim();
if (!token) {
  console.error("Помилка: BOT_TOKEN не заповнений у .env");
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
  signal: AbortSignal.timeout(15_000)
});
const data = await response.json() as {
  ok: boolean;
  description?: string;
  result?: Array<{
    message?: { chat?: { id: number; type?: string; username?: string; first_name?: string } };
  }>;
};

if (!response.ok || !data.ok) {
  console.error(`Telegram Bot API: ${data.description ?? response.statusText}`);
  process.exit(1);
}

const chats = new Map<number, NonNullable<NonNullable<(typeof data.result)>[number]["message"]>["chat"]>();
for (const update of data.result ?? []) {
  const chat = update.message?.chat;
  if (chat) chats.set(chat.id, chat);
}

if (chats.size === 0) {
  console.log("Повідомлень ще немає.");
  console.log("1. Відкрийте свого бота в Telegram.");
  console.log("2. Натисніть Start або надішліть /start.");
  console.log("3. Знову виконайте: npm run chat-id");
  process.exit(0);
}

console.log("Знайдені чати:");
for (const chat of chats.values()) {
  console.log(`BOT_CHAT_ID=${chat?.id}  (${chat?.username ? `@${chat.username}` : chat?.first_name ?? chat?.type ?? "чат"})`);
}
console.log("\nСкопіюйте потрібний рядок BOT_CHAT_ID=... у файл .env");
