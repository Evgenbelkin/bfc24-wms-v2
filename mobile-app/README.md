# BFC24 WMS — Android-обёртка (Capacitor)

Нативная Android-оболочка вокруг веб-приложения BFC24 WMS. Контекст и
причины выбора именно такого подхода — в `../deploy/MOBILE_APP_BRIEF.md`.
Кратко, что решено и почему:

- **Режим "remote URL"** — приложение не содержит копию `public/`, а просто
  открывает WebView на реальный домен (`dev.bfc-24.ru` / `staging.bfc-24.ru`).
  `API_BASE = '/api/v2'` в `public/shared/api.js` остаётся относительным,
  CORS на сервере трогать не нужно — всё same-origin, как в браузере.
- **App ID**: `ru.bfc24.wms`, имя приложения: `BFC24 WMS`.
- **Переключатель окружений** — есть (dev/staging), реализован локальной
  bootstrap-страницей, см. ниже.
- **Распространение** — обычный APK-файл, без Play Store (внутренний
  корпоративный инструмент).
- Терминала Honeywell ScanPal EDA50K (Android 4.4) это НЕ касается — там
  остаётся веб-версия через старый Firefox, см. бриф.

## Как работает переключатель окружений

`www/index.html` — единственная локальная (не с сервера) страница
приложения. При запуске:

1. Если окружение уже выбрано и сохранено (`localStorage['bfc24_env']` в
   локальном origin'е приложения) — сразу переходит на
   `https://<host>/app/login.html` выбранного сервера.
2. Если нет — показывает выбор: "Рабочий сервер" (`dev.bfc-24.ru`) или
   "Тестовый сервер (staging)" (`staging.bfc-24.ru`), запоминает выбор и
   переходит.

Дальше вся навигация (и токены авторизации в `localStorage`, см.
`getToken()`/`saveAuth()` в `api.js`) живёт внутри origin'а выбранного
сервера — ровно как сейчас в обычном браузере, без каких-либо изменений
веб-кода.

**Сменить окружение позже**: на экране логина (`login.html`), когда в
истории WebView больше некуда возвращаться, аппаратная кнопка "Назад"
вместо выхода из приложения возвращает на экран выбора сервера (см.
`android/app/src/main/java/ru/bfc24/wms/MainActivity.java`). Альтернатива —
Android Settings → Apps → BFC24 WMS → Storage → Clear data (сбрасывает
выбор, но и разлогинивает).

## Камера / сканирование

`public/shared/scanner.js` использует `getUserMedia` — работает в обычном
Android WebView, разрешение `android.permission.CAMERA` уже добавлено в
`AndroidManifest.xml`. Capacitor сам прокидывает системный запрос
разрешения при первом обращении к камере (см.
`BridgeWebChromeClient.onPermissionRequest` в `@capacitor/android`).
**Обязательно проверить сканирование на реальном устройстве** — эмулятор
для этого не подходит.

## Иконка / splash screen

Пока используются заглушки по умолчанию из шаблона Capacitor
(`android/app/src/main/res/mipmap-*`, `drawable/splash.png`). Нужно
подготовить реальные ассеты и прогнать через `@capacitor/assets` (или
вручную разложить по `mipmap-mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi`) — отдельная
задача, дизайн ещё не готов.

## Структура

```
mobile-app/
  package.json            — зависимости Capacitor (core, cli, android)
  capacitor.config.json    — appId/appName/webDir + allowNavigation на оба домена
  www/index.html           — единственная локальная страница (bootstrap/switcher)
  android/                 — нативный Android-проект (Gradle), сгенерирован `cap add android`
```

## Сборка

### Вариант A — GitHub Actions (по умолчанию, не требует Android Studio)

Workflow: `../.github/workflows/build-android.yml`. Запускается:
- автоматически при пуше в `dev`/`main`, если менялось что-то в `mobile-app/`;
- вручную — вкладка **Actions** → *Build Android APK (BFC24 WMS)* →
  **Run workflow**.

Результат — APK во вкладке **Artifacts** запущенного workflow-рана:
- `bfc24-wms-debug-apk` — собирается всегда, подписан debug-ключом
  (годится для тестов на своём телефоне; при переустановке между разными
  CI-ранами Android может попросить сначала удалить старую версию, т.к.
  debug-ключ у раннера каждый раз новый — это ограничение debug-подписи, а
  не баг).
- `bfc24-wms-release-apk` — собирается, только если в secrets репозитория
  заданы ключи подписи (см. ниже). Стабильно обновляется поверх старой
  версии — этот вариант стоит раздавать сотрудникам.

**Настройка release-подписи** (сделать один раз):

```bash
keytool -genkeypair -v -keystore bfc24-wms-release.keystore \
  -alias bfc24wms -keyalg RSA -keysize 2048 -validity 10000
# сохранить .keystore и пароли в надёжном месте — потеря = невозможность
# обновлять уже установленное на телефонах приложение тем же ключом

base64 -w0 bfc24-wms-release.keystore > keystore.b64
```

В GitHub: Settings → Secrets and variables → Actions → New repository
secret, добавить четыре секрета:
- `ANDROID_KEYSTORE_BASE64` — содержимое `keystore.b64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS` (`bfc24wms` в примере выше)
- `ANDROID_KEY_PASSWORD`

### Вариант B — локально через Android Studio (Windows)

Нужен установленный Android Studio с Android SDK (в песочнице, где
готовился этот проект, SDK нет).

```bash
cd mobile-app
npm install
npx cap sync android
npx cap open android      # откроет проект в Android Studio
```

Дальше в Android Studio: Build → Build Bundle(s)/APK(s) → Build APK(s),
либо через встроенный терминал `cd android && ./gradlew assembleDebug`
(на Windows — `gradlew.bat`). Для подписанного release — Build → Generate
Signed Bundle / APK — Android Studio проведёт через создание/выбор
keystore пошагово.

## Распространение

Play Store не используется. APK раздаётся сотрудникам напрямую (например,
через корпоративный чат/облако), сотрудник один раз разрешает установку
"из неизвестных источников" для источника, из которого качает файл —
такая же модель, как уже используется сейчас с браузером на главном
экране.

## Что ещё не сделано

- Иконка и splash screen (ждут дизайн).
- Тест сканирования камерой на реальном Android-устройстве.
- Тест обоих окружений (dev/staging) и переключения между ними на
  реальном телефоне.
- Решить, нужен ли versionCode/versionName bump процесс при каждом релизе
  (сейчас в `android/app/build.gradle`: `versionCode 1`, `versionName "1.0"`
  — захардкожено).
