# Supertonic 3 TTS (GPU) for Coucou

Serves `POST /v1/audio/speech` (OpenAI shape) on 127.0.0.1:8003. Vietnamese + English, voices F1-F5 / M1-M5.
The app sends `lang` ("vi"/"en"), `response_format` "pcm" or "wav", `sample_rate` (24000 for the island).

Setup on the GPU machine (CUDA 13 driver):

    mkdir -p ~/vinh-voice/supertonic && cd ~/vinh-voice/supertonic
    python3 -m venv .venv
    .venv/bin/pip install supertonic scipy onnxruntime-gpu nvidia-cublas nvidia-cuda-runtime nvidia-cudnn-cu13 nvidia-cufft nvidia-curand nvidia-cuda-nvrtc
    cp <repo>/voice-server/supertonic/server.py .
    cp <repo>/voice-server/systemd/vinh-tts-st.service ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now vinh-tts-st
    tailscale serve --bg --https=8445 http://127.0.0.1:8003

Clients reach it on 127.0.0.1:18445 (vrelay-8445 on vinhTP; coucou-voice-tunnel on vinh-ubuntu).
Override in the app with COUCOU_TTS_URL / COUCOU_TTS_MODEL / COUCOU_TTS_VOICE.
Measured on an RTX 3060: ~0.1 s per sentence, ~1.2 GB VRAM, ~100x realtime.
