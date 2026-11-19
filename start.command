#!/bin/bash
# Запуск квиза на Mac: дважды кликните этот файл в Finder.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Встроенный Node.js (переносная сборка) — ничего устанавливать не нужно
case "$(uname -m)" in
  arm64) BUNDLED="runtime/darwin-arm64/node" ;;
  *) BUNDLED="runtime/darwin-x64/node" ;;
esac

if [ -f "$BUNDLED" ] && [ -d node_modules ]; then
  chmod +x "$BUNDLED" 2>/dev/null
  NODE="$BUNDLED"
else
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js не найден. Скачайте переносную сборку квиза или установите Node.js с https://nodejs.org (кнопка «LTS»)."
    open "https://nodejs.org" 2>/dev/null
    read -r -p "Нажмите Enter, чтобы закрыть окно…"
    exit 1
  fi
  NODE="node"
  # node_modules, скопированные с Windows, ставим заново под Mac
  if [ ! -f node_modules/.quiz-platform ] || [ "$(cat node_modules/.quiz-platform)" != "$(uname -s)" ]; then
    echo "Устанавливаю зависимости, это нужно только один раз…"
    rm -rf node_modules
    npm install --omit=dev || { read -r -p "Не получилось установить. Нажмите Enter…"; exit 1; }
    uname -s > node_modules/.quiz-platform
  fi
fi

# код 42 — приложение обновилось, запускаем новую версию
OPEN="--open"
while true; do
  "$NODE" server.js $OPEN
  [ $? -eq 42 ] || break
  OPEN=""
  echo "Обновление установлено, перезапускаю…"
done
read -r -p "Сервер остановлен. Нажмите Enter, чтобы закрыть окно…"
