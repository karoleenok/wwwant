#!/usr/bin/env bash
# Установка wwwant на чистый Ubuntu 22.04/24.04 или Debian 12. Запускать от root, можно повторно (идемпотентно).
# Пример: REPO_URL=https://github.com/ВАШ_НИК/wwwant.git bash install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-}"
APP_DIR=/opt/wwwant
ENV_DIR=/etc/wwwant
ENV_FILE=$ENV_DIR/env
SVC_USER=wwwant

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "запусти от root"
[ -n "$REPO_URL" ] || die "укажи REPO_URL=https://github.com/ник/wwwant.git"
command -v apt-get >/dev/null || die "нужен Debian или Ubuntu"
export DEBIAN_FRONTEND=noninteractive

say "Пакеты"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates xz-utils openssl >/dev/null

say "Node 22"
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) die "архитектура не поддержана: $(uname -m)" ;; esac
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$tmp/SHASUMS256.txt"
  file=$(grep -o "node-v22\.[0-9.]*-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
  [ -n "$file" ] || die "не нашёл сборку Node 22"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || die "контрольная сумма Node не сошлась"
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
fi
[ -x /usr/local/bin/node ] || ln -sf "$(command -v node)" /usr/local/bin/node
node -v

say "Пользователь и папки"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$ENV_DIR" /var/backups/wwwant
chmod 700 "$ENV_DIR"
chown "$SVC_USER:$SVC_USER" /var/backups/wwwant && chmod 700 /var/backups/wwwant

say "Код"
if [ -d "$APP_DIR/.git" ]; then
  runuser -u "$SVC_USER" -- git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  runuser -u "$SVC_USER" -- git -C "$APP_DIR" merge --ff-only "origin/$BRANCH" || true
else
  rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"; chown "$SVC_USER:$SVC_USER" "$APP_DIR"
  runuser -u "$SVC_USER" -- git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
echo "$BRANCH" > "$ENV_DIR/branch"

say "Тесты до запуска"
runuser -u "$SVC_USER" -- env WW_QUIET=1 bash -c "cd '$APP_DIR' && node --test test/" > /tmp/ww-install-test.log 2>&1 \
  || { tail -30 /tmp/ww-install-test.log; die "тесты не прошли, запуск остановлен"; }

say "Настройки"
if [ ! -f "$ENV_FILE" ]; then
  if [ -z "$DOMAIN" ]; then
    ip=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)
    [ -n "$ip" ] || die "не смог узнать IP сервера, передай DOMAIN=... вручную"
    DOMAIN="${ip//./-}.sslip.io"
  fi
  # Код для страницы /claim: можно задать самой в строке запуска (CLAIM_CODE=..., 10-40 латинских букв и цифр),
  # иначе генерируется случайный. Так код не придётся искать на сервере.
  code="${CLAIM_CODE:-}"
  if ! printf '%s' "$code" | grep -qE '^[A-Za-z0-9]{10,40}$'; then
    code=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 12)
  fi
  umask 077
  cat > "$ENV_FILE" <<ENVEOF
PORT=3000
HOST=127.0.0.1
DATA_DIR=/var/lib/wwwant
WEB_DIR=$APP_DIR/web
BACKUP_DIR=/var/backups/wwwant
WEBAPP_URL=https://$DOMAIN
CLAIM_CODE=$code
CLAIM_MINUTES=60
# Заполни перед публичным запуском (политика берёт отсюда):
OPERATOR_NAME=
OPERATOR_INN=
OPERATOR_CONTACT=
HOSTING_NAME=
POLICY_DRAFT=1
ENVEOF
  umask 022
fi
DOMAIN=$(grep '^WEBAPP_URL=' "$ENV_FILE" | sed 's#.*//##')
CLAIM_CODE_VAL=$(grep '^CLAIM_CODE=' "$ENV_FILE" | cut -d= -f2)

say "Службы"
install -m 644 "$APP_DIR/deploy/wwwant.service" /etc/systemd/system/wwwant.service
install -m 644 "$APP_DIR/deploy/wwwant-backup.service" /etc/systemd/system/wwwant-backup.service
install -m 644 "$APP_DIR/deploy/wwwant-backup.timer" /etc/systemd/system/wwwant-backup.timer
install -m 644 "$APP_DIR/deploy/wwwant-update.service" /etc/systemd/system/wwwant-update.service
install -m 644 "$APP_DIR/deploy/wwwant-update.timer" /etc/systemd/system/wwwant-update.timer
# Скрипт обновления кладём вне репозитория, от root: правка репозитория не даёт права root.
install -m 755 -o root -g root "$APP_DIR/deploy/update.sh" /usr/local/sbin/wwwant-update
systemctl daemon-reload
systemctl enable --now wwwant.service wwwant-backup.timer wwwant-update.timer >/dev/null
systemctl restart wwwant.service

say "Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq caddy >/dev/null 2>&1 || {
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  }
fi
CF=/etc/caddy/Caddyfile
[ -f "$CF" ] || touch "$CF"
cp "$CF" "$CF.bak"
sed -i '/^# BEGIN wwwant$/,/^# END wwwant$/d' "$CF"
cat >> "$CF" <<CADDYEOF
# BEGIN wwwant
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
# END wwwant
CADDYEOF
if caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
else
  cp "$CF.bak" "$CF"; die "Caddyfile не прошёл проверку, вернул прежний"
fi

say "Проверка"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi; sleep 1
done
[ "${ok:-0}" = 1 ] || { journalctl -u wwwant -n 30 --no-pager; die "сервис не ответил на /health"; }
curl -fsS http://127.0.0.1:3000/health; echo

cat > /root/wwwant-claim.txt <<TXTEOF
Подключение бота:
  Ссылка: https://$DOMAIN/claim
  Код:    $CLAIM_CODE_VAL
Страница работает 60 минут после запуска сервиса и закроется после подключения токена.
TXTEOF
chmod 600 /root/wwwant-claim.txt

cat <<DONE

================================================================
 ГОТОВО. Осталось подключить бота (токен вводишь сама, в чат его не присылай):

   Ссылка: https://$DOMAIN/claim
   Код:    $CLAIM_CODE_VAL

 Ссылка и код сохранены в /root/wwwant-claim.txt
================================================================
DONE
