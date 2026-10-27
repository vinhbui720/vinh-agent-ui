"""Voice agent: STT/TTS on station1tuf (relay on 127.0.0.1:18444/18445), LLM via 9router.
Tokens are spent only when a turn ends (VAD); speaking over the agent cancels its reply at once.
Long jobs (coding agent, Hermes) run in the background so the talk never blocks."""
import asyncio, json, os, urllib.request
import numpy as np
from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli, function_tool, RunContext, stt, utils
from livekit.plugins import openai, silero

E = os.environ.get
STT_URL, TTS_URL = E("STT_URL", "http://127.0.0.1:18444/v1"), E("TTS_URL", "http://127.0.0.1:18445/v1")
OC_MODEL = E("OC_MODEL", "9router/SimpleWork")  # fast model for voice jobs (Thinking took ~6 s for a file)
LLM_URL, LLM_MODEL = E("LLM_URL", "http://127.0.0.1:20128/v1"), E("LLM_MODEL", "claude-api/claude-haiku-4-5-20251001")
VOICE = E("TTS_VOICE", "F1")
WORKDIR = E("AGENT_WORKDIR", os.path.expanduser("~"))
GUARD_DIR = os.path.expanduser("~/voice-work")  # project dir whose opencode.json holds DENY; tested: OPENCODE_CONFIG(_CONTENT) do not enforce deny, project file does
HERMES_RPC = E("HERMES_RPC", "")  # Coucou gateway on vinh-ubuntu, e.g. http://127.0.0.1:18766/api/rpc (tunnel)

SHERPA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09/")
# Voice jobs run unattended: --auto approves everything not explicitly denied here.
DENY = {"permission": {"bash": {"sudo *": "deny", "su *": "deny", "rm -rf *": "deny", "git push *": "deny", "git reset --hard*": "deny", "git clean *": "deny", "shutdown*": "deny", "reboot*": "deny", "systemctl *": "deny", "kill *": "deny", "pkill *": "deny", "dd *": "deny", "mkfs*": "deny"}, "question": "deny"}}

_SHERPA = None
def _sherpa_model():
    """Loaded once per worker process (prewarm); loading takes ~1.6 s and must not block a live session."""
    global _SHERPA
    if _SHERPA is None and os.path.isdir(SHERPA):
        import sherpa_onnx
        _SHERPA = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=SHERPA + "encoder.int8.onnx", decoder=SHERPA + "decoder.onnx",
            joiner=SHERPA + "joiner.int8.onnx", tokens=SHERPA + "tokens.txt", num_threads=2, sample_rate=16000)
    return _SHERPA

def prewarm(proc):
    _sherpa_model()

LOCAL = E("VOICE_LOCAL") == "1"  # the agent runs on the caller's machine: OpenCode, memory and folders are right here
VAULT = E("VOICE_VAULT", "")     # Obsidian vault; the day's talk goes to <vault>/Voice/mem
SPK_URL = E("SPK_URL", "")  # speaker-embedding service on the GPU box (station1tuf); empty = every voice is the caller


class SwitchSTT(stt.STT):
    """fast = sherpa-onnx Vietnamese on CPU (~0.1 s, Vietnamese only); accurate = Whisper on GPU box (~1 s, vi+en).
    Both are batch per VAD segment; AgentSession adds the streaming via VAD."""
    def __init__(self):
        super().__init__(capabilities=stt.STTCapabilities(streaming=False, interim_results=False))
        self.mode = E("STT_MODE", "fast")
        self.whisper = openai.STT(base_url=STT_URL, api_key="x", model=E("STT_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2"), detect_language=True)
        self.sherpa = _sherpa_model()
        self.voices: list[np.ndarray] = []  # voice 0 = the one who called; later ones are other people in the room
        self.on_other = None  # (label, text) for speech that is not the caller's: kept, not answered

    @property
    def model(self): return self.mode
    @property
    def provider(self): return "switch"

    def _sherpa(self, pcm: np.ndarray, sr: int) -> str:
        s = self.sherpa.create_stream(); s.accept_waveform(sr, pcm); self.sherpa.decode_stream(s)
        return s.result.text.strip().capitalize()

    def _who(self, pcm: np.ndarray, sr: int) -> int:
        """Index of the speaker of this segment (0 = caller). New voices are added; too short to tell = caller."""
        if not SPK_URL or len(pcm) < 0.7 * sr:
            return 0
        if sr != 16000:
            pcm = np.interp(np.arange(0, len(pcm), sr / 16000), np.arange(len(pcm)), pcm)
        try:
            r = urllib.request.Request(SPK_URL + "/embed", (pcm * 32767).astype(np.int16).tobytes())
            e = np.array(json.loads(urllib.request.urlopen(r, timeout=3).read())["emb"], dtype=np.float32)
        except Exception:  # noqa: BLE001  service down: treat as the caller, never block the call
            return 0
        e = e / (np.linalg.norm(e) + 1e-9)
        if not self.voices:
            self.voices.append(e); return 0
        sims = [float(e @ v) for v in self.voices]
        i = int(np.argmax(sims))
        if sims[i] >= float(E("SPK_THR", "0.5")):
            if sims[i] > 0.7:  # drift with the caller's voice over the call
                v = 0.9 * self.voices[i] + 0.1 * e; self.voices[i] = v / np.linalg.norm(v)
            return i
        self.voices.append(e); return len(self.voices) - 1

    async def _recognize_impl(self, buffer, *, language=None, conn_options):
        if not SPK_URL:
            return await self._transcribe(buffer, language=language, conn_options=conn_options)
        f = utils.merge_frames(buffer)
        ev, n = await asyncio.gather(self._transcribe(buffer, language=language, conn_options=conn_options),
                                     asyncio.to_thread(self._who, np.frombuffer(f.data, np.int16).astype(np.float32) / 32768, f.sample_rate))
        if ev.alternatives and ev.alternatives[0].text.strip():
            if n:
                print("other voice", n, flush=True)
                if self.on_other: self.on_other(f"Giọng {n + 1}", ev.alternatives[0].text)
                ev.alternatives[0].text = ""  # kept in memory above; the agent does not take orders from it
        return ev

    async def _transcribe(self, buffer, *, language=None, conn_options):
        if self.mode == "fast" and self.sherpa:
            f = utils.merge_frames(buffer)
            text = await asyncio.to_thread(self._sherpa, np.frombuffer(f.data, np.int16).astype(np.float32) / 32768, f.sample_rate)
            print("stt fast", len(text), flush=True)
            return stt.SpeechEvent(type=stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives=[stt.SpeechData(language="vi", text=text)])
        return await self.whisper.recognize(buffer, conn_options=conn_options)

PROMPT = """Bạn là trợ lý giọng nói của Vinh. Nói tự nhiên, ngắn gọn (1-2 câu), không markdown, không liệt kê.
Trước khi gọi công cụ, nói một câu rất ngắn ("để mình xem") rồi mới gọi.
Chuyện cũ (hôm trước, sở thích, việc đã làm) thì dùng công cụ recall, đừng đoán.
Lời nói được nhận dạng tự động nên hay sai từ kỹ thuật và tên riêng. Hãy tự sửa theo ngữ cảnh rồi làm luôn, chỉ hỏi lại khi thật sự không đoán được. Hay gặp: grid grab/great grab=GridCraft, deck craft/đề craft=DeckCraft, photo grab/photograph=PhotoCraft, word craft=WordCraft, vector/film/cad craft, chấm t xt/chấm ts=.txt, hôm=home, viết status=git status, sodo/xu đô=sudo, ô A một=A1, bảy=7. Tên file/thư mục người dùng nói thì giữ đúng như nghe, bỏ dấu cách thành gạch dưới, không có đường dẫn thì tạo trong home.
Trả lời bằng ngôn ngữ người dùng đang nói (Việt hoặc Anh). Việc nhỏ (một file ngắn, đọc, sửa một đoạn, một lệnh ngắn) thì dùng thẳng write_file, read_file, edit_file, run_command. Điều khiển app Grid/Deck/Photo/Word/Vector/Film/CAD thì artcraft_search rồi artcraft. Làm ứng dụng, dự án, nhiều file, nhiều bước, cần viết hoặc sửa code thật thì BẮT BUỘC giao coding_agent, không tự ghi file,
báo 'đang làm' một lần rồi im, chờ. Đừng hỏi lại, đừng nói tiến độ, đừng gọi công cụ để kiểm tra: kết quả sẽ tự báo lại khi xong.
Chỉ nói tiếp khi người dùng nói điều khác (thì trả lời điều đó, không nhắc việc đang chạy) hoặc khi họ hỏi việc xong chưa (thì nói còn đang chạy). Đọc kết quả thật ngắn. Nếu việc bị chặn vì quyền (sudo, xóa nhiều, đẩy git...), nói lệnh bị chặn và hỏi người dùng có cho phép không, đừng tự làm lại."""


class Voice(Agent):
    def __init__(self):
        super().__init__(instructions=PROMPT, tools=[function_tool(self.hermes)] if HERMES_RPC else [])
        self.jobs: dict[str, asyncio.Task] = {}
        self.room = None

    async def _run_bg(self, name: str, coro, ctx: RunContext):
        started = asyncio.get_running_loop().time()
        try:
            out = (await coro).strip()[-1500:] or "(không có kết quả)"
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            out = f"lỗi: {e}"
            print("job_error", type(e).__name__, str(e)[:120], flush=True)  # error text only, never content
        self.jobs.pop(name, None)
        print("job_done", name.split(":", 1)[0], round(asyncio.get_running_loop().time() - started, 2), flush=True)
        ctx.session.generate_reply(instructions=f"Việc '{name}' đã xong. Kết quả thô: {out}\nNói ngay là đã xong (một câu), kèm kết quả chính; nếu lỗi hoặc bị chặn thì nói rõ. Không gọi công cụ nào nữa.")

    def caller(self):
        return next((p for p in self.room.remote_participants.values() if not p.identity.startswith("agent")), None) if self.room else None

    def on_caller(self) -> bool:
        """True when the caller's own machine does the work (Coucou answers the RPCs); False when the server does it."""
        c = self.caller()
        return not LOCAL and bool(c) and c.attributes.get("machine") != "server"

    async def _client(self, method: str, payload: str = "", timeout: float = 900) -> str:
        """Ask the machine that called (Coucou) to do something: its OpenCode, its folders."""
        room = self.room
        c = self.caller()
        who = c.identity if c else None
        if not who:
            raise RuntimeError("máy gọi không còn kết nối")
        return await room.local_participant.perform_rpc(destination_identity=who, method=method, payload=payload, response_timeout=timeout)

    async def _sh(self, *args: str, cwd: str = WORKDIR) -> str:
        p = await asyncio.create_subprocess_exec(*args, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        try:
            out, _ = await asyncio.wait_for(p.communicate(), timeout=900)
            return out.decode(errors="replace")
        finally:
            if p.returncode is None:
                try: os.killpg(p.pid, 9)  # opencode and what it started: nothing keeps spending tokens
                except ProcessLookupError: pass
                await p.communicate()

    async def _oc(self, task: str, cwd: str) -> str:
        # one rolling session; the first run on a machine has none yet, so retry without it
        out = await self._sh("opencode", "run", "--auto", "-m", OC_MODEL, "--title", "voice", "--session", "ses_voice", task, cwd=cwd)
        return await self._sh("opencode", "run", "--auto", "-m", OC_MODEL, "--title", "voice", task, cwd=cwd) if "Session not found" in out else out

    @function_tool
    async def coding_agent(self, ctx: RunContext, task: str, allow_blocked: bool = False):
        """Giao một việc code/máy tính cho OpenCode (viết, sửa, chạy, đọc code). Chạy nền, tự duyệt quyền thường.
        Lệnh nguy hiểm (sudo, rm -rf, git push, systemctl, kill...) bị chặn: khi kết quả báo bị chặn, nói rõ lệnh nào và HỎI người dùng.
        Chỉ đặt allow_blocked=true khi người dùng vừa đồng ý rõ ràng cho đúng việc đó."""
        name = f"code:{task[:30]}"
        cwd = WORKDIR
        if self.on_caller():
            print("job_start code on-caller", "unblocked" if allow_blocked else "guarded", flush=True)
            self.jobs[name] = asyncio.create_task(self._run_bg(name, self._client("run_task", json.dumps({"task": task, "allowBlocked": allow_blocked})), ctx))
            return "Đã giao, đang chạy nền. Đừng kiểm tra lại, sẽ tự báo khi xong."
        if not allow_blocked:
            os.makedirs(GUARD_DIR, exist_ok=True)
            with open(os.path.join(GUARD_DIR, "opencode.json"), "w") as f:
                json.dump(DENY, f)
            cwd = GUARD_DIR
        print("job_start code", "unblocked" if allow_blocked else "guarded", flush=True)
        self.jobs[name] = asyncio.create_task(self._run_bg(name, self._oc(task, cwd), ctx))
        return "Đã giao, đang chạy nền. Đừng kiểm tra lại, sẽ tự báo khi xong."


    # ── Quick tools: run right here, on the machine the agent runs on. No OpenCode start-up (~1-3 s saved each). ──
    def _path(self, p: str) -> str:
        p = os.path.abspath(os.path.expanduser(p if os.path.isabs(os.path.expanduser(p)) else os.path.join(WORKDIR, p)))
        if not p.startswith(os.path.expanduser("~") + os.sep):
            raise ValueError("chỉ làm việc trong thư mục home")
        return p

    @function_tool
    async def write_file(self, ctx: RunContext, path: str, content: str):
        """Tạo hoặc ghi đè một file văn bản (trong home). CHỈ cho file rất ngắn (dưới 15 dòng: ghi chú, file test, cấu hình nhỏ). Ứng dụng, trang web, chương trình, code dài thì KHÔNG dùng, giao coding_agent. Path tương đối tính từ home."""
        try:
            p = self._path(path); os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w").write(content); return f"Đã ghi {p} ({len(content)} ký tự)."
        except Exception as e:  # noqa: BLE001
            return f"Lỗi: {e}"

    @function_tool
    async def read_file(self, ctx: RunContext, path: str):
        """Đọc một file văn bản (tối đa ~3000 ký tự đầu)."""
        try:
            return open(self._path(path), errors="replace").read(3000) or "(file rỗng)"
        except Exception as e:  # noqa: BLE001
            return f"Lỗi: {e}"

    @function_tool
    async def edit_file(self, ctx: RunContext, path: str, old: str, new: str):
        """Sửa file: thay đúng một đoạn `old` bằng `new`. `old` phải xuất hiện đúng một lần."""
        try:
            p = self._path(path); t = open(p).read()
            if t.count(old) != 1:
                return f"Không sửa: `old` xuất hiện {t.count(old)} lần (cần đúng 1)."
            open(p, "w").write(t.replace(old, new)); return "Đã sửa."
        except Exception as e:  # noqa: BLE001
            return f"Lỗi: {e}"

    @function_tool
    async def run_command(self, ctx: RunContext, command: str):
        """Chạy một lệnh shell ngắn (dưới 60 giây) trong home và trả kết quả. Lệnh nguy hiểm (sudo, rm -rf, git push, systemctl, kill...) bị chặn: nói lệnh nào bị chặn và hỏi người dùng. Việc dài hoặc phức tạp thì dùng coding_agent."""
        import re
        if re.search(r"(^|[;&|]\s*)(sudo|su|shutdown|reboot|systemctl|kill|pkill|dd|mkfs)\b|rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|git\s+(push|reset\s+--hard|clean)", command):
            return "BỊ CHẶN: lệnh nguy hiểm. Hãy nói lệnh nào bị chặn và hỏi người dùng."
        p = await asyncio.create_subprocess_shell(command, cwd=WORKDIR, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        try:
            out, _ = await asyncio.wait_for(p.communicate(), timeout=60)
        except asyncio.TimeoutError:
            os.killpg(p.pid, 9); return "Quá 60 giây, đã dừng. Việc dài thì giao coding_agent."
        return out.decode(errors="replace").strip()[-1500:] or f"(xong, mã {p.returncode})"

    # ── ArtCraft (GridCraft, DeckCraft, PhotoCraft... on this machine) through its MCP gateway; tools are searched, not listed. ──
    async def _art(self):
        if getattr(self, "_artc", None):
            return self._artc
        import shutil, glob
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        gw = os.path.expanduser(E("ARTCRAFT_GATEWAY", "~/.local/share/artcraft/gateway.mjs"))
        vers = sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node")), key=lambda p: [int(x) for x in p.split("/node/v")[1].split("/")[0].split(".")])
        node = E("ARTCRAFT_NODE") or (vers[-1] if vers else shutil.which("node") or "node")  # the service PATH has an old system node; the gateway needs a recent one
        self._artx = stdio_client(StdioServerParameters(command=node, args=[gw]))
        r, w = await self._artx.__aenter__()
        c = ClientSession(r, w); await c.__aenter__(); await c.initialize()
        self._artc = c; self._arttools = (await c.list_tools()).tools
        return c

    @function_tool
    async def artcraft_search(self, ctx: RunContext, query: str):
        """Tìm công cụ ArtCraft (bảng tính GridCraft, slide DeckCraft, ảnh PhotoCraft, văn bản WordCraft, vector, video, CAD) theo từ khóa tiếng Anh, vd 'write cells', 'insert chart'. Trả về tên và tham số."""
        try:
            await self._art(); w = query.lower().split()
            hit = [t for t in self._arttools if all(x in (t.name + " " + (t.description or "")).lower() for x in w)][:8] or \
                  [t for t in self._arttools if any(x in (t.name + " " + (t.description or "")).lower() for x in w)][:8]
            return "\n".join(f"{t.name}: {(t.description or '')[:90]} | {json.dumps(((getattr(t, 'inputSchema', None) or getattr(t, 'input_schema', None)) or {}).get('properties', {}))[:200]}" for t in hit) or "Không có công cụ nào khớp."
        except Exception as e:  # noqa: BLE001
            return f"ArtCraft không dùng được: {type(e).__name__}"

    @function_tool
    async def artcraft(self, ctx: RunContext, tool: str, arguments_json: str = "{}"):
        """Gọi một công cụ ArtCraft theo tên (tìm tên bằng artcraft_search trước). arguments_json là JSON các tham số."""
        try:
            c = await self._art()
            r = await asyncio.wait_for(c.call_tool(tool, json.loads(arguments_json or "{}")), timeout=60)
            return "".join(getattr(x, "text", "") for x in r.content)[:1500] or "Xong."
        except Exception as e:  # noqa: BLE001
            return f"Lỗi ArtCraft: {type(e).__name__}: {str(e)[:150]}"

    async def hermes(self, ctx: RunContext, question: str):
        """Hỏi hoặc nhờ Hermes (trợ lý chính của Vinh: ghi chú Obsidian, lịch, việc cần làm). Chạy nền."""
        if not HERMES_RPC:
            return "Chưa nối được Hermes."
        def call():
            r = urllib.request.Request(HERMES_RPC, json.dumps({"cmd": "hermes_ask", "args": {"text": question}}).encode(), {"Content-Type": "application/json"})
            return urllib.request.urlopen(r, timeout=300).read().decode()
        name = f"hermes:{question[:30]}"
        self.jobs[name] = asyncio.create_task(self._run_bg(name, asyncio.to_thread(call), ctx))
        return "Đã nhờ, đang chạy nền. Đừng kiểm tra lại, sẽ tự báo khi xong."

    @function_tool
    async def recall(self, ctx: RunContext, query: str):
        """Tìm trong trí nhớ về các cuộc nói chuyện trước (các từ khóa ngắn). Trả về vài dòng ghi chú, hoặc rỗng."""
        if LOCAL:
            d = self._mem_dir(); words = query.lower().split(); out = []
            for f in sorted(os.listdir(d), reverse=True) if d else []:
                if f.endswith(".md") and f != "README.md":
                    out += [f"{f[:10]}: {l.strip()}" for l in open(os.path.join(d, f), errors="replace") if words and all(w in l.lower() for w in words)]
            return "\n".join(out)[:1500] or "Không có ghi chú nào khớp."
        if not self.on_caller():
            return "Máy này không có trí nhớ."
        try:
            return (await self._client("recall", query, timeout=10)) or "Không có ghi chú nào khớp."
        except Exception:  # noqa: BLE001
            return "Không truy cập được trí nhớ."

    def _mem_dir(self):
        d = os.path.join(VAULT, "Voice", "mem") if VAULT else ""
        if d: os.makedirs(d, exist_ok=True)
        return d

    async def remember(self, who: str, text: str):
        """One line into the day's raw memory on the caller's machine. Best effort, never blocks the voice."""
        if LOCAL:
            d = self._mem_dir()
            if d:
                import datetime
                n = datetime.datetime.now()
                with open(os.path.join(d, f"{n:%Y-%m-%d}.raw.md"), "a") as f:
                    f.write(f"- {n:%H:%M} {who}: {text.replace(chr(10), ' ')}\n")
            return
        if not self.on_caller():
            return
        try:
            await self._client("mem_add", json.dumps({"who": who, "text": text}), timeout=5)
        except Exception:  # noqa: BLE001
            pass

    @function_tool
    async def stop_jobs(self, ctx: RunContext):
        """Hủy mọi việc nền đang chạy khi người dùng bảo dừng/hủy."""
        try:
            if self.on_caller(): await self._client("cancel", timeout=5)
        except Exception:  # noqa: BLE001
            pass
        n = len(self.jobs)
        for t in self.jobs.values():
            t.cancel()
        self.jobs.clear()
        return f"Đã hủy {n} việc."


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    vad = silero.VAD.load(min_silence_duration=float(E("VAD_SILENCE", "0.3")))
    sw = SwitchSTT()
    agent_ref: list = []
    session = AgentSession(
        vad=vad,
        stt=stt.StreamAdapter(stt=sw, vad=vad),
        llm=openai.LLM(base_url=LLM_URL, api_key=E("LLM_KEY", "x"), model=LLM_MODEL),
        tts=openai.TTS(base_url=TTS_URL, api_key="x", model="supertonic-3", voice=VOICE, response_format="wav"),
        turn_handling={"endpointing": {"mode": "dynamic", "min_delay": 0.25, "max_delay": 2.0}, "interruption": {"enabled": True, "mode": "vad"},
                       "preemptive_generation": {"enabled": True, "preemptive_tts": True, "max_speech_duration": 8.0}},
    )
    @session.on("user_input_transcribed")
    def _(ev):  # length only, never content
        print("heard", ev.is_final, len(ev.transcript), flush=True)

    @session.on("function_tools_executed")
    def _(ev):  # tool names only, never arguments
        print("tools", [c.name for c in ev.function_calls], flush=True)

    @session.on("user_state_changed")
    def _(ev):
        print("user", ev.new_state, flush=True)

    @session.on("agent_state_changed")
    def _(ev):
        print("agent", ev.new_state, flush=True)

    @session.on("conversation_item_added")
    def _(ev):  # timings only in the log; the words go to the caller's own vault memory
        role = getattr(ev.item, "role", "")
        text = getattr(ev.item, "text_content", None)
        if text and role in ("user", "assistant") and agent_ref:
            asyncio.create_task(agent_ref[0].remember("Vinh" if role == "user" else "Coucou", text))
        m = getattr(ev.item, "metrics", None)
        if role == "assistant" and m:
            print("latency", {k: round(m[k], 2) for k in ("e2e_latency", "llm_node_ttft", "tts_node_ttfb") if m.get(k) is not None}, flush=True)
    async def set_io(data: rtc.RpcInvocationData) -> str:
        """Client toggles both ends: {"stt": "off|fast|accurate", "tts": "on|off"}. Text input (chat) always works."""
        c = json.loads(data.payload or "{}")
        if (v := c.get("stt")) is not None:
            session.input.set_audio_enabled(v != "off")
            if v in ("fast", "accurate"):
                sw.mode = v
        if (v := c.get("tts")) is not None:
            session.output.set_audio_enabled(v == "on")
            if v != "on":
                session.interrupt()
        return json.dumps({"stt": "on" if session.input.audio_enabled else "off", "mode": sw.mode, "tts": "on" if session.output.audio_enabled else "off"})
    ctx.room.local_participant.register_rpc_method("set_io", set_io)
    agent = Voice()
    agent.room = ctx.room
    agent_ref.append(agent)
    async def _bye():  # the call ended: stop jobs and the ArtCraft gateway child, nothing keeps running
        for t in agent.jobs.values(): t.cancel()
        if getattr(agent, "_artc", None):
            try: await agent._artc.__aexit__(None, None, None); await agent._artx.__aexit__(None, None, None)
            except Exception: pass  # noqa: BLE001
    ctx.add_shutdown_callback(_bye)
    sw.on_other = lambda who, text: asyncio.create_task(agent.remember(who, text))
    await session.start(agent=agent, room=ctx.room, record=False)
    # What the machine doing the work is (host, home, Desktop, vault, time), added to the instructions once, best effort.
    try:
        if agent.on_caller():
            for i in range(4):
                try:
                    info = await agent._client("context", timeout=5)
                    break
                except Exception:  # noqa: BLE001
                    if i == 3: raise
                    await asyncio.sleep(1.5)
            where = "máy đang gọi"
        else:
            import socket, datetime
            h = os.path.expanduser("~")
            info = f"Máy chạy việc: {socket.gethostname()}, home {h}, Desktop {h}/Desktop" + (f", vault Obsidian {VAULT}" if VAULT else "") + f". Bây giờ: {datetime.datetime.now():%Y-%m-%d %H:%M}."
            where = "máy này" if LOCAL else "máy chủ này"
        await agent.update_instructions(PROMPT + "\n" + info + f"\nViệc tạo file/thư mục, chạy lệnh đều làm trên {where} (file nhỏ và lệnh ngắn dùng công cụ trực tiếp, việc lớn dùng coding_agent).")
    except Exception as e:  # noqa: BLE001
        print("context unavailable", type(e).__name__, flush=True)
    asyncio.create_task(agent._art())  # warm the ArtCraft gateway now so the first app command is instant
    # ponytail: no automatic greeting; saves a paid turn and avoids talking over the user.


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
