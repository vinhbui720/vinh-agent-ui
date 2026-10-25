#!/usr/bin/env bash
# Usage: STT=http://127.0.0.1:8000 TTS=http://127.0.0.1:8001 ./test.sh   (use https://<host>.ts.net:844x for tailnet)
# Exit 0 only if TTS makes real audio for vi+en and STT round-trips both languages.
set -u
STT=${STT:-http://127.0.0.1:8000}; TTS=${TTS:-http://127.0.0.1:8001}
STT_MODEL=${STT_MODEL:-Systran/faster-whisper-large-v3}   # large-v3-turbo repo id: check `speaches-cli model ls --task automatic-speech-recognition`
TTS_MODEL=${TTS_MODEL:-vieneu}; TTS_VOICE=${TTS_VOICE:-default}
d=$(mktemp -d); fail=0
ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; fail=1; }
say(){ # lang text out
  curl -sf -m 120 "$TTS/v1/audio/speech" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$TTS_MODEL\",\"voice\":\"$TTS_VOICE\",\"input\":\"$2\",\"response_format\":\"wav\"}" -o "$3" || return 1
  [ "$(head -c4 "$3")" = RIFF ] && [ "$(stat -c%s "$3")" -gt 20000 ]; }
hear(){ curl -sf -m 120 "$STT/v1/audio/transcriptions" -F "file=@$1" -F "model=$STT_MODEL" -F "language=$2" | tr 'A-Z' 'a-z'; }
norm(){ python3 -c 'import sys,unicodedata as u;print(u.normalize("NFD",sys.stdin.read().lower()).encode("ascii","ignore").decode())'; }
say vi "Xin chào, hôm nay trời đẹp lắm." $d/vi.wav && ok "tts vi" || bad "tts vi"
say en "Hello, the weather is nice today." $d/en.wav && ok "tts en" || bad "tts en"
say vi "Mình đang thử giọng nói bằng tiếng Việt và English." $d/mix.wav && ok "tts vi/en mix" || bad "tts mix"
t=$(hear $d/vi.wav vi | norm); echo "$t" | grep -q "troi dep" && ok "stt vi: $t" || bad "stt vi: '$t'"
t=$(hear $d/en.wav en); echo "$t" | grep -q "weather" && ok "stt en: $t" || bad "stt en: '$t'"
curl -sf -m 5 "$STT/health" >/dev/null && ok "stt health" || bad "stt health"
rm -rf "$d"; [ $fail = 0 ] && echo ALL OK || { echo SOME FAILED; exit 1; }
