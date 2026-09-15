#!/usr/bin/env bash
# read-before-edit: okunmamış dosyaya yazmayı engeller (pre-tool-use).
# - Read çağrılarını oturum bazında kaydeder, Edit/Write öncesi kontrol eder.
# - Diskte olmayan (yeni) dosyaya yazmaya izin verir.
# Protokol: exit 2 + stderr = engelle; exit 0 = geçir.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
SID=$(echo "$INPUT" | jq -r '.session_id // "global"' | tr -c 'a-zA-Z0-9_-' '_')
STATE="/tmp/pi-autohooks-read-${SID}.log"

FILE=$(echo "$INPUT" | jq -r '.tool_input.path // .tool_input.file // .tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

case "$TOOL" in
  read|Read)
    echo "$FILE" >> "$STATE"
    exit 0
    ;;
  edit|Edit|write|Write)
    # Yeni dosya: okunacak bir şey yok, geçir.
    [ -e "$FILE" ] || exit 0
    if grep -qxF "$FILE" "$STATE" 2>/dev/null; then
      exit 0
    fi
    echo "Dosya bu oturumda okunmadı, önce Read ile oku: $FILE" >&2
    exit 2
    ;;
esac
exit 0
