# Кросплатформне розгортання

Код застосунку не залежить від Windows. Він працює на Node.js 22+ у Windows, Linux і macOS. Відрізняється лише механізм автозапуску операційної системи.

## Рекомендований спільний варіант: Docker Compose

Docker Compose використовує однакові файли на всіх трьох платформах. Контейнер автоматично перезапускається після помилки та після запуску Docker завдяки `restart: unless-stopped`.

### Підготовка

У корені проєкту повинен існувати локальний `.env` з усіма п’ятьма секретами:

```dotenv
TG_API_ID=...
TG_API_HASH=...
TG_SESSION=...
BOT_TOKEN=...
BOT_CHAT_ID=...
DATABASE_PATH=./data/realty.sqlite
LOG_LEVEL=info
```

`.env` не потрапляє у Docker image і не комітиться в Git.

### Запуск

```bash
docker compose up -d --build
```

### Стан і логи

```bash
docker compose ps
docker compose logs -f --tail=100
```

### Перезапуск і зупинка

```bash
docker compose restart
docker compose down
```

SQLite зберігається у локальному каталозі `./data`, змонтованому в `/app/data`. Видалення контейнера не видаляє базу.

### Backfill у контейнері

```bash
docker compose exec realty-monitoring npm run backfill -- --days 2
```

Не запускайте окремий другий контейнер через `docker compose run`: він може конкурувати з основним процесом і працювати з тією самою SQLite-базою.

## Windows без Docker

Використовуйте Task Scheduler із trigger **At log on** або **At startup**. Action має запускати `npm start` із working directory проєкту. Не прив’язуйте шлях до глобального Node у коді — шлях потрібен лише конфігурації конкретного комп’ютера.

Приклад реєстрації завдання в PowerShell (шляхи підставте свої; у `$arg` — той самий запуск, що й `npm start`, з виводом у `logs\bot.log`):

```powershell
$dir  = 'C:\шлях\до\realty-monitoring'
$node = (Get-Command node).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

New-Item -ItemType Directory -Force "$dir\logs" | Out-Null
$arg       = '/c ""' + $node + '" node_modules\tsx\dist\cli.mjs src\index.ts >> logs\bot.log 2>&1"'
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S'
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'realty-monitoring' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
```

Завдання стартує через 30 секунд після входу (щоб піднялася мережа), працює в прихованому вікні без обмеження за часом і перезапускається щохвилини після збою. Керування:

```powershell
Start-ScheduledTask   -TaskName realty-monitoring   # запустити зараз
Stop-ScheduledTask    -TaskName realty-monitoring   # зупинити
Disable-ScheduledTask -TaskName realty-monitoring   # вимкнути автозапуск
Unregister-ScheduledTask -TaskName realty-monitoring -Confirm:$false   # видалити
```

Логи дописуються у `logs\bot.log` (ротації немає; переконайтеся, що `logs/` або `*.log` є в `.gitignore`):

```powershell
Get-Content logs\bot.log -Tail 50 -Wait   # стежити в реальному часі
```

Перевірити, що бот працює:

```powershell
(Get-ScheduledTask realty-monitoring).State    # Running = працює, Ready = зупинено
Get-ScheduledTaskInfo realty-monitoring        # LastRunTime, LastTaskResult
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object CommandLine -match 'realty-monitoring'
```

Якщо стан `Ready`, а процесу немає, завдання зупинилося: у логу не буде помилки, а `LastTaskResult` дорівнюватиме `3221225786` (`0xC000013A`, процес закрили ззовні). Завдання працює в межах вашого сеансу Windows (`LogonType Interactive`): при виході із сеансу (log off) воно завершується, а при наступному вході стартує знову (тригер At log on). Щоб воно працювало й без входу, потрібне завдання з тригером At startup і запуском від облікового запису з паролем (потребує прав адміністратора).

Не запускайте `npm start` вручну, поки завдання працює: два процеси з однією SQLite-базою та одним токеном конфліктують. Спершу `Stop-ScheduledTask`.

## Linux без Docker

Рекомендовано systemd. Приклад `/etc/systemd/system/realty-monitoring.service`:

```ini
[Unit]
Description=Realty Monitoring Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=realty-monitoring
WorkingDirectory=/opt/realty-monitoring
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Активація:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now realty-monitoring
sudo systemctl status realty-monitoring
journalctl -u realty-monitoring -f
```

Файл `.env` залишається у `/opt/realty-monitoring`; права повинні дозволяти читання тільки користувачу сервісу.

## macOS без Docker

Рекомендовано `launchd`. Створіть `~/Library/LaunchAgents/com.realty-monitoring.bot.plist` із реальними шляхами до Node/npm і проєкту:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.realty-monitoring.bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npm</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/USERNAME/realty-monitoring</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/USERNAME/realty-monitoring/monitor.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/realty-monitoring/monitor.stderr.log</string>
</dict>
</plist>
```

Активація:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.realty-monitoring.bot.plist
launchctl kickstart -k gui/$(id -u)/com.realty-monitoring.bot
```

На Apple Silicon npm часто розташований у `/opt/homebrew/bin/npm`; перевірте командою `which npm`.

## Важливе правило

Незалежно від ОС повинен працювати тільки один real-time listener. Перед переходом між нативним запуском і Docker зупиніть попередній процес.
