import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import qrcode from "qrcode-terminal";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH?.trim() ?? "";
if (!apiId || !apiHash) {
  console.error("Заповніть TG_API_ID і TG_API_HASH у .env");
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5
});

console.log("Відкрийте Telegram на телефоні:");
console.log("Налаштування → Пристрої → Підключити пристрій");
console.log("Потім відскануйте QR-код нижче.\n");

try {
  await client.connect();
  await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async ({ token, expires }) => {
        const url = `tg://login?token=${token.toString("base64url")}`;
        console.log(`\nQR дійсний до ${new Date(expires * 1000).toLocaleTimeString("uk-UA")}:`);
        qrcode.generate(url, { small: true });
      },
      password: async (hint) => {
        const label = hint ? `Пароль 2FA (підказка: ${hint}): ` : "Пароль 2FA: ";
        return rl.question(label);
      },
      onError: async (error) => {
        console.error(`Помилка авторизації: ${error.message}`);
        return false;
      }
    }
  );

  console.log("\nАвторизація успішна.");
  console.log(`TG_SESSION="${client.session.save()}"`);
  console.log("Скопіюйте весь рядок TG_SESSION=... у .env. Не публікуйте його.");
} finally {
  rl.close();
  await client.disconnect();
}
