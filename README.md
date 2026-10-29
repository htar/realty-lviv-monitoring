# Real Estate Radar — Львів

Telegram-монітор на Node.js + TypeScript + teleproto + SQLite для оренди 1–2-кімнатних квартир у Шевченківському районі Львова до 22 000 грн/міс.

## Документація

- [Встановлення і перший запуск](docs/SETUP.md)
- [Команди бота та керування каналами](docs/COMMANDS.md)
- [Архітектура і база даних](docs/ARCHITECTURE.md)
- [Експлуатація та усунення проблем](docs/OPERATIONS.md)
- [Безпека і секрети](docs/SECURITY.md)
- [Кросплатформне розгортання: Docker, Windows, Linux, macOS](docs/DEPLOYMENT.md)
- [Тестування, coverage і CI](docs/TESTING.md)
- [Дослідження Telegram-джерел](CHANNEL_RESEARCH.md)

## Уже налаштовано

- Початкові джерела: `@orendakvartyr_ua`, `@direct_rent`, `@neruhomist_lviv_ua`, `@lvivrentua`, `@ValionEstateBot`, `@orenda_lvivprozoro`.
- Після дослідження додано джерела з аудиторією від 5K: `@orendakvarturlviv`, `@orendakvarturlviv1`, `@lviv_no_maklers`, `@lvivnerucho`, `@prodagkvarturlviv`.
- Повтори у початковому списку видалені.
- Підтримуються українські й російські формулювання та ціни на кшталт `21 500 грн`, `18 тис грн`.
- Повідомлення без явно вказаного Шевченківського району, кімнатності або гривневої ціни не надсилаються, щоб зменшити хибні збіги.
- Нові та відредаговані повідомлення зберігаються в SQLite й не надсилаються повторно без зміни тексту.

## Налаштування

1. У Telegram відкрийте `@BotFather`, створіть бота та збережіть токен.
2. Напишіть створеному боту `/start`. Числовий `chat_id` можна отримати через `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. На `https://my.telegram.org/apps` створіть Telegram API application і отримайте `api_id` та `api_hash`.
4. У папці проєкту виконайте:

```powershell
Copy-Item .env.example .env
npm install
```

5. Заповніть у `.env` `TG_API_ID`, `TG_API_HASH`, `BOT_TOKEN`, `BOT_CHAT_ID`. Потім створіть користувацьку сесію:

Щоб отримати `BOT_CHAT_ID`, спочатку надішліть своєму боту `/start`, а потім виконайте:

```powershell
npm run chat-id
```

Скопіюйте показаний рядок `BOT_CHAT_ID=...` у `.env`.

```powershell
npm run session
```

Скопіюйте надрукований рядок `TG_SESSION=...` у `.env`. Це секрет із доступом до Telegram-акаунта — не комітьте й не надсилайте його іншим.

Якщо код авторизації не надходить, використайте QR-вхід:

```powershell
npm run session:qr
```

У Telegram на телефоні відкрийте **Налаштування → Пристрої → Підключити пристрій** і відскануйте QR із PowerShell.

## Запуск

```powershell
npm start
```

Кросплатформний production-запуск:

```bash
docker compose up -d --build
```

Контейнер не відкриває портів, зберігає SQLite у `./data` та автоматично перезапускається через `restart: unless-stopped`.

Для автоматичного перезапуску на VPS рекомендовано systemd або Docker Compose. Фільтри й канали редагуються у `config/search.json`.

### Зміна фільтрів через Telegram

Налаштування застосовуються відразу та зберігаються у SQLite:

```text
/filters
/budget 22000
/rooms 1,2
/district Шевченківський
/strict on
/status
/help
```

Кілька районів можна передати через кому: `/district Шевченківський, Франківський`.

Приховані адміністративні команди джерел (не показуються у звичайній `/help` і приймаються лише з `BOT_CHAT_ID`):

```text
/channelhelp
/channels
/channeladd @direct_rent
/channelremove @direct_rent
```

`/channeladd` приймає також посилання виду `https://t.me/channel_name`. Підтримуються публічні username; для приватних invite-посилань потрібна окрема підтримка числових ID.

## Перевірки

```powershell
npm test
npm run typecheck
```

## Ліміти Codex під час розробки

У Codex CLI виконайте `/statusline` і ввімкніть `Rate limits`, `Token counters` та `Context stats`. Для разового перегляду використовуйте `/usage`, `/usage daily`, `/usage weekly`, `/usage cumulative` або `/status`.

## Важливі обмеження MVP

- Моніторяться лише канали, доступні авторизованому Telegram-акаунту. Боти й приватні джерела можуть не надавати історію як звичайні публічні канали.
- `@ValionEstateBot` є ботом, а не публічним каналом: GramJS не отримає з нього стрічку оголошень, якщо бот сам не надсилатиме їх авторизованому акаунту.
- Валюти USD/EUR розпізнаються, але не конвертуються в гривні, тому такі оголошення навмисно не проходять ціновий фільтр.
- Парсер працює за правилами, без AI. Незвичні або неповні оголошення можуть бути пропущені.
