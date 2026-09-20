#!/bin/bash
set -euo pipefail

# =============================================================================
# Ночной бэкап продовой БД bfc24-wms-v2 (cron на VPS: 0 4 * * * /opt/bfc24-backup.sh).
# Версионируем здесь (deploy/bfc24-backup.sh) для истории изменений - реально
# исполняется копия в /opt/bfc24-backup.sh на сервере, эта версия ей не
# перезаписывается автоматически при git pull. После правки скопировать вручную:
#   scp deploy/bfc24-backup.sh root@vps:/opt/bfc24-backup.sh
# или отредактировать /opt/bfc24-backup.sh на сервере напрямую и синхронизировать
# обратно сюда.
#
# 20.09.2026 (владелец: "хочу что бы в тг прилетал бэкап и на сервере тоже
# сохранялся") - добавлено Telegram-уведомление об успехе/ошибке. Сам файл
# дампа В ТЕЛЕГРАМ НЕ ШЛЁМ: на момент этой правки дамп уже 508 МБ и продолжает
# расти, а лимит Telegram Bot API на отправку файла ботом - 50 МБ. Шлём
# только текстовый статус (размер, время, ошибка/успех) - это уведомление,
# что бэкап прошёл, а не второй канал хранения самого файла.
#
# 20.09.2026, тем же вечером - добавлена реальная защита от отказа ВСЕГО VPS:
# копия дампа в Yandex Object Storage (бакет bfc24-backups, класс "Холодное" -
# он же указан у Yandex как рекомендованный именно для бэкапов, и почти вдвое
# дешевле стандартного). rclone настроен как remote "yandex-backup" (root'ом,
# см. /root/.config/rclone/rclone.conf). Неуспех заливки в облако НЕ считаем
# провалом всего бэкапа - локальная копия к этому моменту уже готова, это
# главное; облако просто получает отдельное предупреждение в Telegram, а не
# ту же самую критическую ошибку.
# =============================================================================

APP_DIR="/var/www/bfc24-wms-v2/server"
BACKUP_DIR="/var/backups/bfc24-wms-v2"
RETENTION_DAYS=14
RCLONE_REMOTE="yandex-backup:bfc24-backups"
REMOTE_RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

DB_HOST=$(grep -E '^DB_HOST=' "$APP_DIR/.env" | cut -d= -f2-)
DB_PORT=$(grep -E '^DB_PORT=' "$APP_DIR/.env" | cut -d= -f2-)
DB_NAME=$(grep -E '^DB_NAME=' "$APP_DIR/.env" | cut -d= -f2-)
DB_USER=$(grep -E '^DB_USER=' "$APP_DIR/.env" | cut -d= -f2-)
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)

# Те же переменные и тот же приём с прокси, что и в server/src/utils/telegram.js
# (прямой доступ к api.telegram.org с этого VPS заблокирован на уровне сети,
# см. комментарий там от 29.08.2026) - если TELEGRAM_PROXY_URL не задан в
# .env, пробуем прямой запрос как запасной вариант. `|| true` тут обязателен:
# если этих ключей в .env ещё нет, grep вернёт код ошибки и под set -e скрипт
# остановится ещё ДО самого бэкапа - Telegram для этого скрипта строго
# опционален.
TG_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$APP_DIR/.env" | cut -d= -f2- || true)
TG_CHAT_ID=$(grep -E '^TELEGRAM_ADMIN_CHAT_ID=' "$APP_DIR/.env" | cut -d= -f2- || true)
TG_PROXY_URL=$(grep -E '^TELEGRAM_PROXY_URL=' "$APP_DIR/.env" | cut -d= -f2- || true)

notify_telegram() {
  local text="$1"
  [ -z "$TG_BOT_TOKEN" ] && return 0
  [ -z "$TG_CHAT_ID" ] && return 0
  if [ -n "$TG_PROXY_URL" ]; then
    curl -s -m 10 -X POST "$TG_PROXY_URL" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"token":"%s","chat_id":"%s","text":"%s"}' "$TG_BOT_TOKEN" "$TG_CHAT_ID" "$text")" \
      >/dev/null || true
  else
    curl -s -m 10 -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"chat_id":"%s","text":"%s"}' "$TG_CHAT_ID" "$text")" \
      >/dev/null || true
  fi
}

# Если pg_dump (или что угодно ниже) упадёт - под set -e скрипт прервётся
# сразу на этой строке, а ERR-ловушка успеет отправить аварийное уведомление
# ДО выхода.
trap 'notify_telegram "❌ bfc24-wms-v2: бэкап БД НЕ выполнен ($(date "+%Y-%m-%d %H:%M")). Смотри /var/backups/bfc24-wms-v2/backup.log на сервере."' ERR

DUMP_FILE="$BACKUP_DIR/prod_${TIMESTAMP}.dump"

PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Fc -f "$DUMP_FILE"

# ротация — удаляем дампы старше RETENTION_DAYS дней
find "$BACKUP_DIR" -name "prod_*.dump" -mtime +$RETENTION_DAYS -delete

SIZE_HUMAN=$(du -h "$DUMP_FILE" | cut -f1)
echo "$(date '+%Y-%m-%d %H:%M:%S') backup OK: $DUMP_FILE ($SIZE_HUMAN)" >> "$BACKUP_DIR/backup.log"

# --- Облачная копия (Yandex Object Storage) ---
# set +e/-e вокруг этого блока намеренно: ошибка здесь не должна триггерить
# общую ERR-ловушку выше (локальный дамп уже готов и это не менее важно, чем
# облако) - вместо этого разбираем код возврата сами и шлём отдельное,
# менее тревожное сообщение.
set +e
rclone copy "$DUMP_FILE" "$RCLONE_REMOTE/" >> "$BACKUP_DIR/backup.log" 2>&1
RCLONE_EXIT=$?
set -e

if [ $RCLONE_EXIT -eq 0 ]; then
  # ротация в облаке - отдельный (более долгий, чем локальный) срок хранения,
  # т.к. хранение там на порядок дешевле, чем место на диске VPS.
  rclone delete "$RCLONE_REMOTE/" --min-age "${REMOTE_RETENTION_DAYS}d" >> "$BACKUP_DIR/backup.log" 2>&1 || true
  echo "$(date '+%Y-%m-%d %H:%M:%S') cloud upload OK: $RCLONE_REMOTE/$(basename "$DUMP_FILE")" >> "$BACKUP_DIR/backup.log"
  notify_telegram "✅ bfc24-wms-v2: бэкап БД готов и загружен в облако. ${SIZE_HUMAN}, $(date '+%Y-%m-%d %H:%M')."
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') cloud upload FAILED (rclone exit $RCLONE_EXIT)" >> "$BACKUP_DIR/backup.log"
  notify_telegram "⚠️ bfc24-wms-v2: локальный бэкап БД готов (${SIZE_HUMAN}), но НЕ загрузился в облако (rclone exit $RCLONE_EXIT). Смотри $BACKUP_DIR/backup.log на сервере."
fi
