import "dotenv/config";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH ?? "";
if (!apiId || !apiHash) throw new Error("Заповніть TG_API_ID і TG_API_HASH у .env");

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
const rl = createInterface({ input, output });
await client.start({
  phoneNumber: async () => rl.question("Номер телефону (+380...): "),
  password: async () => rl.question("Пароль 2FA (якщо є): "),
  phoneCode: async () => rl.question("Код із Telegram: "),
  onError: (error) => console.error(error.message)
});
console.log("\nTG_SESSION=\"" + client.session.save() + "\"");
console.log("Скопіюйте цей рядок у .env і не публікуйте його.");
await client.disconnect();
rl.close();
