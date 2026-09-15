#!/usr/bin/env bash
# notify-on-stop: tur bitince masaüstü bildirimi (agent-stop). Sessiz başarısız olur.

INPUT=$(cat)
ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
[ "$ACTIVE" = "true" ] && exit 0

notify-send "Pi" "Tur tamamlandı, giriş bekleniyor." 2>/dev/null
exit 0
