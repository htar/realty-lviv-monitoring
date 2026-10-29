# Встановлення і перший запуск

## Що потрібно

- Windows PowerShell і Node.js 22+;
- бот, створений через `@BotFather`;
- Telegram API application з `api_id` і `api_hash`;
- Telegram-акаунт, який має доступ до каналів моніторингу.

Проєкт використовує дві різні авторизації:

1. **Bot API** — `BOT_TOKEN` і `BOT_CHAT_ID`; надсилає сповіщення та приймає команди.
2. **MTProto** — `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`; читає канали від імені Telegram-акаунта.

Бот від `@BotFather` сам по собі не може читати довільні канали.

## Створення бота

1. Відкрийте офіційного `@BotFather`.
2. Надішліть `/newbot`.
3. Вкажіть назву, наприклад `Real Estate Radar Lviv`.
4. Вкажіть унікальний username, який закінчується на `bot`.
5. Збережіть отриманий токен як `BOT_TOKEN`.
6. Відкрийте створеного бота та надішліть `/start`.

## Telegram API application

1. Відкрийте `https://my.telegram.org`.
2. Увійдіть номером активного Telegram-акаунта.
3. Виберіть **API development tools**.
4. Створіть application, наприклад `Realty Monitoring`, short name `realtymonitoring`, platform `Desktop`.
5. Збережіть `api_id` і `api_hash`.

## Встановлення

```powershell
cd C:\Users\kasa\Desktop\realty-monitoring
npm install
Copy-Item .env.example .env
notepad .env
```

Приклад `.env`:

```dotenv
TG_API_ID=12345678
TG_API_HASH=ваш_api_hash
TG_SESSION=

BOT_TOKEN=1234567890:ваш_bot_token
BOT_CHAT_ID=

DATABASE_PATH=./data/realty.sqlite
LOG_LEVEL=info
```

## Отримання BOT_CHAT_ID

Після `/start` у чаті з ботом виконайте:

```powershell
npm run chat-id
```

Скопіюйте показаний рядок `BOT_CHAT_ID=...` у `.env`. Якщо повідомлень ще немає, повторно надішліть боту `/start` і запустіть команду знову.

## Створення TG_SESSION

Рекомендований QR-вхід:

```powershell
npm run session:qr
```

На телефоні відкрийте **Telegram → Налаштування → Пристрої → Підключити пристрій** і відскануйте QR. Якщо ввімкнено 2FA, введіть пароль у PowerShell. Скопіюйте весь отриманий рядок `TG_SESSION="..."` у `.env`.

Альтернативний вхід через код:

```powershell
npm run session
```

Код може прийти у службовий чат Telegram `777000`, на email або іншим способом, який обере Telegram. Не пересилайте код у чатах.

## Доступ до джерел

Акаунт із `TG_SESSION` повинен бачити канали з `config/search.json`. Поточний MVP працює з публічними username; приватні invite-посилання не підтримуються як джерело.

## Запуск і перевірка

```powershell
npm start
```

Ознака успішного запуску: `Real Estate Radar started`. У Telegram перевірте `/status`, `/filters`, `/channels`.

```powershell
npm run typecheck
npm test
```
