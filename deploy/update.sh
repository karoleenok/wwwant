#!/usr/bin/env bash
# Тихое автообновление: забираем main, гоняем тесты, перезапускаем, при сбое откатываем.
# Ставится в /usr/local/sbin/wwwant-update установщиком и запускается таймером от root.
set -euo pipefail
APP=/opt/wwwant
BRANCH=$(cat /etc/wwwant/branch 2>/dev/null || echo main)
as() { runuser -u wwwant -- "$@"; }
cd "$APP"
as git fetch --quiet origin "$BRANCH" || { echo "git fetch не удался, пропускаю"; exit 0; }
NEW=$(as git rev-parse "origin/$BRANCH")
OLD=$(as git rev-parse HEAD)
[ "$NEW" = "$OLD" ] && exit 0
echo "обновление $OLD -> $NEW"
# только ff: если историю переписали принудительно, сами ничего не трогаем
as git merge --ff-only "origin/$BRANCH" || { echo "не fast-forward, оставляю как есть"; exit 1; }
if ! as env WW_QUIET=1 bash -c "cd '$APP' && node --test test/" >/tmp/ww-update-test.log 2>&1; then
  echo "тесты не прошли, откатываю"; tail -20 /tmp/ww-update-test.log
  as git reset --hard "$OLD"; exit 1
fi
systemctl restart wwwant
for _ in $(seq 1 20); do
  sleep 1
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then echo "обновлено: $NEW"; exit 0; fi
done
echo "сервис не поднялся, откатываю"
as git reset --hard "$OLD"
systemctl restart wwwant
exit 1
