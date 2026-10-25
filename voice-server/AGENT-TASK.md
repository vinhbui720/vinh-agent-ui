# Task: set up local voice server (STT + TTS, Vietnamese + English)

You run on a DIFFERENT machine from the dev box: the tailnet machine with a 12 GB NVIDIA GPU.
Do everything here. This file is self-contained: create the files below, then follow the steps.
Do not touch any other project. Do not run `docker system prune`. No secrets in files.

## Goal
One docker compose project `coucou-voice`, two services, both bound to 127.0.0.1, exposed to the tailnet
with `tailscale serve` (tailnet has one user, no auth).
Contract, which `test.sh` verifies:
- STT: `POST /v1/audio/transcriptions` (multipart: file, model, language) -> JSON with `text`
- TTS: `POST /v1/audio/speech` (JSON: model, voice, input, response_format=wav) -> RIFF wav

## 1. Prerequisites
`docker run --rm --gpus all ubuntu nvidia-smi` must print the GPU. If not: install nvidia-container-toolkit,
`sudo nvidia-ctk runtime configure --runtime=docker`, `sudo systemctl restart docker`. Also need `curl`, `python3`.
Check `tailscale status` is up.

## 2. Create `~/voice-server/compose.yaml`
```yaml
# One project, one command: docker compose up -d / docker compose down -v --rmi all
# stt: Speaches (faster-whisper) -> POST /v1/audio/transcriptions   (host 127.0.0.1:8000)
# tts: VieNeu-TTS (Vietnamese + en/vi mix) -> POST /v1/audio/speech (host 127.0.0.1:8001)
# Bound to localhost only; expose with `tailscale serve` (see README.md). No auth on purpose.
name: coucou-voice
services:
  stt:
    image: ghcr.io/speaches-ai/speaches:latest-cuda   # TODO agent: pin an exact tag
    ports: ["127.0.0.1:8000:8000"]
    volumes: ["hf:/home/ubuntu/.cache/huggingface/hub"]
    environment:
      WHISPER__TTL: "-1"            # keep model loaded
    deploy: &gpu
      resources:
        reservations:
          devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]
    restart: unless-stopped
  tts:
    image: pnnbao/vieneu-tts:latest   # TODO agent: verify (see README step 3), pin tag
    ports: ["127.0.0.1:8001:23333"]   # TODO agent: confirm container port + /v1/audio/speech path
    volumes: ["hf2:/root/.cache/huggingface"]
    deploy: *gpu
    restart: unless-stopped
volumes: { hf: {}, hf2: {} }
```

## 3. Create `~/voice-server/test.sh` (then `chmod +x`)
```bash
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
```

## 4. Fix the UNVERIFIED parts (marked TODO in compose.yaml)
- TTS = VieNeu-TTS v3 Turbo (https://github.com/pnnbao97/VieNeu-TTS, Apache-2.0, Vietnamese + en/vi mix).
  Read its "API Server & Docker" section (compose profile `api-gpu`, OpenAI-compatible, module `apps.openai_speech`).
  The `pnnbao/vieneu-tts` image on port 23333 is an LMDeploy server and may NOT expose `/v1/audio/speech`.
  Use whatever really serves `/v1/audio/speech` (build from the repo if needed). Set the right internal port,
  model id and voice id; update `TTS_MODEL`/`TTS_VOICE` defaults in test.sh if they differ.
- STT = Speaches (https://speaches.ai). Pick the exact image tag, pin it. Prefer model `large-v3-turbo`
  (find its repo id with `docker compose exec stt uvx speaches-cli model ls --task automatic-speech-recognition`),
  else `Systran/faster-whisper-large-v3`. Download it: `docker compose exec stt uvx speaches-cli model download <id>`.
  Optional if Vietnamese STT is weak: `quocphu/PhoWhisper-ct2-FasterWhisper`.
- Pin every image to a tag or digest (no `latest`) once it works.
- Fallback only if VieNeu cannot work: Speaches Piper `vi_VN` voice for TTS, drop the `tts:` service. Say so in the report.

## 5. Run and test
`cd ~/voice-server && docker compose up -d && ./test.sh` -- repeat until `ALL OK`.
Fix compose and model ids, not the test logic. Check `docker compose logs` on failure.

## 6. Expose and test from the tailnet
```
tailscale serve --bg --https=8444 http://127.0.0.1:8000
tailscale serve --bg --https=8445 http://127.0.0.1:8001
HOST=$(tailscale status --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
STT=https://$HOST:8444 TTS=https://$HOST:8445 ./test.sh
```
Also run that last line from one OTHER tailnet device if available (ask the user which).
If ports 8444/8445 are taken (`tailscale serve status`), pick free ones and report them.

## 7. Report back (exactly this)
- STT URL, TTS URL (tailnet), model ids, voice id, pinned image tags
- `nvidia-smi` VRAM use with both models loaded
- full `./test.sh` output (local + tailnet)
- anything you changed from this file, and anything that did not work

## Uninstall (everything this task created)
```
tailscale serve --https=8444 off; tailscale serve --https=8445 off
cd ~/voice-server && docker compose down -v --rmi all && cd .. && rm -rf voice-server
```
