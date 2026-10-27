#!/bin/sh
# Registers the native host for Chrome/Chromium/Brave. Then load this folder at chrome://extensions (Developer mode, Load unpacked).
d=$(cd "$(dirname "$0")" && pwd); id=$(cat "$d/ID.txt")
for b in google-chrome chromium BraveSoftware/Brave-Browser; do
  m="$HOME/.config/$b/NativeMessagingHosts"; mkdir -p "$m"
  printf '{"name":"coucou_tabs","description":"Coucou tabs","path":"%s/host.py","type":"stdio","allowed_origins":["chrome-extension://%s/"]}\n' "$d" "$id" > "$m/coucou_tabs.json"
done
echo "ok: extension id $id"
