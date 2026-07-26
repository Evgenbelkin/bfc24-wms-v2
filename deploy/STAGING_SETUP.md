# Настройка staging-окружения (bfc24-wms-v2)

Цель: любые новые изменения сначала выкатываются и проверяются на отдельном
staging-инстансе (свой процесс, свой порт, своя база), и только после проверки
попадают в боевую версию на `dev.bfc-24.ru`. Так живые клиенты не видят
недоделанный код и ломающиеся миграции.

Все команды ниже выполняются по SSH на VPS #177237.

---

## 0. Что понадобится перед стартом

Открой текущий боевой `server/.env` на VPS и выпиши реальные значения:

```
cat /var/www/bfc24-wms-v2/server/.env
```

Тебе нужны: `DB_USER`, `DB_PASSWORD`, реальное имя боевой базы (`DB_NAME`).
Дальше по тексту это обозначено как `<DB_USER>`, `<DB_PASSWORD>`, `<PROD_DB_NAME>`.

---

## 1. DNS

В панели управления `bfc-24.ru` добавь A-запись:

```
staging.bfc-24.ru   A   185.230.141.237
```
(тот же IP, что уже стоит у `bfc-24.ru` / `dev.bfc-24.ru`)

Подожди 5-15 минут на распространение, проверить можно:
```
ping staging.bfc-24.ru
```

---

## 2. Копия базы данных под staging

```bash
sudo -u postgres psql -c "CREATE DATABASE bfc24_v2_staging OWNER <DB_USER>;"

PGPASSWORD=<DB_PASSWORD> pg_dump -U <DB_USER> -h 127.0.0.1 <PROD_DB_NAME> \
  | PGPASSWORD=<DB_PASSWORD> psql -U <DB_USER> -h 127.0.0.1 bfc24_v2_staging
```

Это разовая копия на старте (демо-тенант, реальных клиентов там ещё нет).
Дальше staging живёт своей жизнью — новые миграции применяются на неё
отдельно (шаг 6), с боевой базой она больше не синхронизируется.

---

## 3. Второй checkout репозитория

```bash
cd /var/www
git clone https://github.com/Evgenbelkin/bfc24-wms-v2.git bfc24-wms-v2-staging
cd bfc24-wms-v2-staging
git checkout dev
```

Ветка `dev` уже создана в репозитории — весь новый рискованный код идёт туда.

---

## 4. server/.env для staging

```bash
cp /var/www/bfc24-wms-v2/server/.env /var/www/bfc24-wms-v2-staging/server/.env
nano /var/www/bfc24-wms-v2-staging/server/.env
```

Поменять в нём:

```
PORT=3002
DB_NAME=bfc24_v2_staging
CORS_ORIGINS=https://staging.bfc-24.ru
```

`NODE_ENV=production` — оставить как в проде (чтобы staging вёл себя
максимально похоже на боевую версию).

`TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` — лучше **очистить** (оставить
пустыми), чтобы тестовые регистрации на staging не прилетали уведомлением в
тот же боевой Telegram-чат.

JWT-секреты можно оставить те же, что в проде — окружения физически разные
процессы, токены от одного к другому не применимы.

---

## 5. Установка зависимостей и миграции

```bash
cd /var/www/bfc24-wms-v2-staging/server
npm install --omit=dev
npm run migrate
```

---

## 6. Запуск через pm2

```bash
cd /var/www/bfc24-wms-v2-staging/server
pm2 start server.js --name bfc24-wms-v2-staging
pm2 save
```

Проверить: `pm2 list` — должен появиться отдельный процесс
`bfc24-wms-v2-staging`, слушающий порт 3002, рядом с боевым `bfc24-wms-v2`.

---

## 7. Nginx + HTTPS

Создать `/etc/nginx/sites-available/staging.bfc-24.ru`:

```nginx
server {
    listen 80;
    server_name staging.bfc-24.ru;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/staging.bfc-24.ru /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d staging.bfc-24.ru
```

После этого `https://staging.bfc-24.ru` — рабочий тестовый стенд.

---

## 8. Рабочий процесс дальше

1. Новый код — в ветку `dev` (локально уже переключено).
2. `git push origin dev`.
3. На VPS: `cd /var/www/bfc24-wms-v2-staging && git pull && [npm run migrate если менялась схема] && pm2 restart bfc24-wms-v2-staging`.
4. Проверил на `staging.bfc-24.ru` — всё ок →
   `git checkout main && git merge dev && git push origin main`.
5. На VPS: `cd /var/www/bfc24-wms-v2 && git pull && [npm run migrate] && pm2 restart bfc24-wms-v2`.

Боевая `dev.bfc-24.ru` (и её база) отдельным кодом больше напрямую не трогается.
