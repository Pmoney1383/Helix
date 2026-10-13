"""Helix's optional PC voice: a tiny local speech server. No model or voice ships with Helix; see docs/LOCAL-TTS.md to set one up.
Engines: qwen3stream (Qwen3-TTS zero-shot clone with true streaming and compiled kernels; Linux/WSL2 only), qwen3 (the same clone,
one whole sentence at a time, works on Windows), chatterbox (Chatterbox TTS cloning a reference clip) and fake (tests).

It is started ON DEMAND by the gateway and stops itself when idle, so it uses the GPU only while someone is talking.
Run by hand only for debugging:  python helix_tts_server.py --port 7791 --engine chatterbox --reference my_voice.wav

Safety, so it can never linger or hog the machine:
  * it exits when its parent (the gateway) goes away: the gateway keeps this process's stdin open, and end-of-file
    on it means "stop" (a crashed gateway can never leave a model sitting on the GPU);
  * it exits by itself after --idle-exit seconds without a request;
  * POST /shutdown stops it immediately.

HTTP (127.0.0.1 only):
  GET  /health                      {"ok": true, "ready": bool, "engine": "...", "sampleRate": 24000}
  POST /speak {"text","style"}      raw PCM, signed 16-bit little-endian, mono, sampleRate Hz
                                    (style: "normal" = expressive settings, "serious" = calm, no added emotion)
  POST /stream {"text","style"}    experimental: the same PCM, sent while it is generated (no Content-Length, ends when the connection
                                    closes); engines without native streaming send the finished sentence in ~0.33 s pieces
  POST /keepalive                   restart the idle clock without speaking
  POST /shutdown                    stop now

`--engine fake` speaks nothing real (a quiet tone whose length follows the text): used by the gateway's tests so they need
neither a GPU nor the model.
"""
import argparse
import json
import math
import os
import struct
import sys
import threading
import time
import zlib
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SAMPLE_RATE = 24000
MAX_TEXT = 600

# Chatterbox settings: an expressive set for normal speech, and a calm set for serious moments.
STYLES = {
    "normal": {"exaggeration": 0.55, "cfg_weight": 0.40, "temperature": 0.8},
    "serious": {"exaggeration": 0.25, "cfg_weight": 0.50, "temperature": 0.7},
}


def log(message):
    sys.stderr.write(f"[helix-tts] {message}\n")
    sys.stderr.flush()


class FakeEngine:
    """A stand-in with the same interface: roughly 0.07 s of quiet tone per character."""

    name = "fake"

    def speak(self, text, style, seed=None):
        seconds = max(0.2, min(30.0, 0.07 * len(text)))
        n = int(SAMPLE_RATE * seconds)
        return struct.pack(f"<{n}h", *(int(800 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE)) for i in range(n)))


class ChatterboxEngine:
    name = "chatterbox"

    def __init__(self, reference):
        if not os.path.isfile(reference):
            raise FileNotFoundError(f"reference voice clip not found: {reference}")
        import numpy as np  # imported late: the fake engine and --help must not need torch
        import torch
        from chatterbox.tts import ChatterboxTTS

        self.np, self.torch = np, torch
        if not torch.cuda.is_available():
            raise RuntimeError("no CUDA GPU available for Chatterbox")
        t0 = time.time()
        self.model = ChatterboxTTS.from_pretrained(device="cuda")
        self.model.prepare_conditionals(reference, exaggeration=STYLES["normal"]["exaggeration"])
        self.model.generate("Warm up.", **STYLES["normal"])  # the first call pays one-off GPU setup; do it before anyone waits
        log(f"model ready in {time.time() - t0:.0f}s")

    def speak(self, text, style, seed=None):
        if seed is not None:
            self.torch.manual_seed(seed)
        wav = self.model.generate(text, **STYLES[style])
        audio = wav.squeeze().cpu().numpy().astype(self.np.float32)
        pcm = (self.np.clip(audio, -1.0, 1.0) * 32767).astype(self.np.int16)
        return pcm.tobytes()


class Qwen3Engine:
    """Zero-shot voice clone with Qwen3-TTS (base model, no LoRA). The clone's reference clip and transcript are read from
    <root>/ref/ref.json (never logged). `style` is ignored: a zero-shot clone has no emotion dial, the words carry the tone."""

    name = "qwen3"
    sample_rate = 24000
    MAX_NEW_TOKENS = 700  # 12 tokens per second of speech: about a minute, far more than one sentence needs

    def __init__(self, root):
        root = Path(root)
        base = root / "models" / "Qwen3-TTS-12Hz-1.7B-Base"
        ref_file = root / "ref" / "ref.json"
        if not base.is_dir() or not ref_file.is_file():
            raise FileNotFoundError(f"Qwen3-TTS workspace is incomplete under {root} (needs models/Qwen3-TTS-12Hz-1.7B-Base and ref/ref.json)")
        import numpy as np  # imported late: the fake engine and --help must not need torch
        import torch
        from qwen_tts import Qwen3TTSModel

        self.np, self.torch = np, torch
        if not torch.cuda.is_available():
            raise RuntimeError("no CUDA GPU available for Qwen3-TTS")
        t0 = time.time()
        ref = json.loads(ref_file.read_text(encoding="utf-8"))
        self.model = Qwen3TTSModel.from_pretrained(str(base), device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
        self.prompt = self.model.create_voice_clone_prompt(ref_audio=ref["audio"], ref_text=ref["text"], x_vector_only_mode=False)
        self._generate("Warm up.", 1)  # the first call pays one-off GPU setup; do it before anyone waits
        log(f"qwen3 model ready in {time.time() - t0:.0f}s")

    def _generate(self, text, seed):
        self.torch.manual_seed(seed)
        self.torch.cuda.manual_seed_all(seed)
        wavs, sr = self.model.generate_voice_clone(text=text, language="English", voice_clone_prompt=self.prompt, max_new_tokens=self.MAX_NEW_TOKENS)
        self.sample_rate = int(sr)
        return self.np.asarray(wavs[0], dtype=self.np.float32), int(sr)

    def _looks_like_noise(self, x, sr):
        # Speech has loudness that moves; the failure seen with this model is stationary hiss.
        np = self.np
        n = int(0.025 * sr)
        k = len(x) // n
        if k < 8:
            return False
        r = np.sqrt((x[: k * n].reshape(k, n) ** 2).mean(axis=1)) + 1e-9
        return bool(r.std() / r.mean() < 0.15 or 20 * np.log10(np.percentile(r, 90) / np.percentile(r, 10)) < 3.0)

    def speak(self, text, style, seed=None):
        # The same text always starts from the same seed (repeatable lines); a bad take retries once with another.
        base_seed = int(seed) if seed is not None else (zlib.crc32(text.encode("utf-8")) & 0x7FFFFFFF)
        audio, sr = self._generate(text, base_seed)
        if self._looks_like_noise(audio, sr):
            log("noise-like output; retrying once")
            self.torch.cuda.empty_cache()
            audio, sr = self._generate(text, base_seed + 7919)
        pcm = (self.np.clip(audio, -1.0, 1.0) * 32767).astype(self.np.int16)
        return pcm.tobytes()


class Qwen3StreamEngine:
    """Qwen3-TTS zero-shot clone with true incremental streaming and compiled kernels. Needs the dffdeeq/Qwen3-TTS-streaming fork
    (installed as `qwen_tts`) and Triton, so it runs on Linux (WSL2): measured 0.1 s to the first audio and about 0.27x real time
    (see docs/LOCAL-TTS.md). The first start compiles for about 90 s; later starts reuse torch's on-disk cache."""

    name = "qwen3stream"
    sample_rate = 24000
    EMIT_FRAMES = 4  # 4 codec frames = about 0.33 s of audio per chunk
    WINDOW = 80
    MAX_FRAMES = 700  # about a minute of speech: far more than one sentence needs
    # One warm-up run is enough (measured: the first costs ~18 s, loading the compiled kernels; later ones add nothing and real
    # sentences of any length then start in ~0.1 s). A medium sentence goes first. HELIX_TTS_WARM_RUNS raises the count for debugging.
    WARM = ["Okay, this is the warm up, a little bit longer than a short line.", "Warm up number two, just a short line.",
            "And a third one to make sure every shape gets compiled before anyone waits.", "Short."]

    def __init__(self, root):
        root = Path(root)
        base = root / "models" / "Qwen3-TTS-12Hz-1.7B-Base"
        ref_file = root / "ref" / "ref.json"
        if not base.is_dir() or not ref_file.is_file():
            raise FileNotFoundError(f"Qwen3-TTS workspace is incomplete under {root} (needs models/Qwen3-TTS-12Hz-1.7B-Base and ref/ref.json)")
        t_start = time.time()
        import numpy as np
        import torch
        from qwen_tts import Qwen3TTSModel

        log(f"qwen3 stream: imports {time.time() - t_start:.1f}s")
        self.np, self.torch = np, torch
        if not torch.cuda.is_available():
            raise RuntimeError("no CUDA GPU available for Qwen3-TTS")
        if not hasattr(Qwen3TTSModel, "stream_generate_voice_clone"):
            raise RuntimeError("the installed qwen_tts has no streaming support (needs the Qwen3-TTS-streaming fork)")
        torch.set_float32_matmul_precision("high")
        t0 = time.time()
        ref = json.loads(ref_file.read_text(encoding="utf-8"))
        self.model = Qwen3TTSModel.from_pretrained(str(base), device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
        self.prompt = self.model.create_voice_clone_prompt(ref_audio=ref["audio"], ref_text=ref["text"], x_vector_only_mode=False)
        log(f"qwen3 stream: weights and voice prompt {time.time() - t0:.1f}s")
        self.model.enable_streaming_optimizations(
            decode_window_frames=self.WINDOW, use_compile=True, use_cuda_graphs=False, compile_mode="reduce-overhead",
            use_fast_codebook=True, compile_codebook_predictor=True, compile_talker=True)
        log(f"qwen3 stream: compile setup {time.time() - t0:.1f}s")
        for w in self.WARM[: int(os.environ.get("HELIX_TTS_WARM_RUNS", "1"))]:  # compiling happens on the first runs; do it before anyone waits
            t1 = time.time()
            for _ in self.stream(w, "normal"):
                pass
            log(f"qwen3 stream: warm-up run {time.time() - t1:.1f}s")
        log(f"qwen3 stream model ready in {time.time() - t0:.0f}s (plus imports)")

    def stream(self, text, style="normal", seed=None):
        """Yield int16 PCM chunks as they are generated. A repeated line starts from the same seed. `style` is ignored (no emotion dial)."""
        torch, np = self.torch, self.np
        s = int(seed) if seed is not None else (zlib.crc32(text.encode("utf-8")) & 0x7FFFFFFF)
        torch.manual_seed(s)
        torch.cuda.manual_seed_all(s)
        for chunk, sr in self.model.stream_generate_voice_clone(
                text=text, language="English", voice_clone_prompt=self.prompt, emit_every_frames=self.EMIT_FRAMES,
                decode_window_frames=self.WINDOW, overlap_samples=0, max_frames=self.MAX_FRAMES):
            self.sample_rate = int(sr)
            yield (np.clip(np.asarray(chunk, dtype=np.float32), -1.0, 1.0) * 32767).astype(np.int16).tobytes()

    def speak(self, text, style, seed=None):
        return b"".join(self.stream(text, style, seed))


def iter_stream(engine, text, style, seed=None):
    """PCM chunks for any engine: native streaming when it has it, otherwise the finished sentence cut into ~0.33 s pieces."""
    if hasattr(engine, "stream"):
        yield from engine.stream(text, style, seed)
        return
    pcm = engine.speak(text, style, seed)
    step = int(0.33 * getattr(engine, "sample_rate", SAMPLE_RATE)) * 2
    for i in range(0, len(pcm), step):
        yield pcm[i:i + step]


class State:
    engine = None
    last_activity = time.time()
    lock = threading.Lock()  # one sentence on the GPU at a time
    server = None
    stop = threading.Event()  # set once the server has stopped serving: main() then exits


def request_stop():
    """Stop serving (from any thread, including a request handler) and let main() finish."""
    def run():
        State.server.shutdown()
        State.stop.set()
    threading.Thread(target=run, daemon=True).start()


def touch():
    State.last_activity = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = "HelixTTS"

    def log_message(self, fmt, *args):  # quiet: the gateway logs what matters
        pass

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode())

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "ready": State.engine is not None, "engine": getattr(State.engine, "name", None), "sampleRate": getattr(State.engine, "sample_rate", SAMPLE_RATE)})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/shutdown":
            self._json(200, {"stopping": True})
            request_stop()
            return
        if self.path == "/keepalive":  # the gateway wants it kept loaded (the user is away): restart the idle clock, speak nothing
            touch()
            return self._json(200, {"ok": True})
        if self.path not in ("/speak", "/stream"):
            return self._json(404, {"error": "not found"})
        if State.engine is None:
            return self._json(503, {"error": "model is still loading"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "invalid JSON"})
        text = str(body.get("text", "")).strip()
        style = body.get("style", "normal")
        if not text:
            return self._json(400, {"error": "text is empty"})
        if len(text) > MAX_TEXT:
            return self._json(400, {"error": f"text is longer than {MAX_TEXT} characters"})
        if style not in STYLES:
            return self._json(400, {"error": "style must be normal or serious"})
        touch()
        if self.path == "/stream":
            return self._stream(text, style, body.get("seed"))
        try:
            with State.lock:
                t0 = time.time()
                pcm = State.engine.speak(text, style, body.get("seed"))
                took = time.time() - t0
        except Exception as e:  # never let one bad sentence take the service down
            log(f"speak failed: {e!r}")
            return self._json(500, {"error": f"speech failed: {e}"})
        touch()
        rate = getattr(State.engine, "sample_rate", SAMPLE_RATE)
        seconds = len(pcm) / 2 / rate
        log(f"spoke {seconds:.1f}s in {took:.1f}s ({style}): {text[:50]}")
        self._send(200, pcm, "audio/L16", {"x-sample-rate": str(rate), "x-audio-seconds": f"{seconds:.2f}", "x-generate-seconds": f"{took:.2f}"})

    def _stream(self, text, style, seed):
        """Experimental: send the PCM as it is generated. No Content-Length; the body ends when the connection closes.
        A failure after the first byte can only cut the stream short (the gateway sees the cut and the error is logged)."""
        self.close_connection = True
        started = False
        try:
            with State.lock:
                t0 = time.time()
                first = None
                total = 0
                for chunk in iter_stream(State.engine, text, style, seed):
                    if not started:
                        first = time.time() - t0
                        self.send_response(200)
                        self.send_header("Content-Type", "audio/L16")
                        self.send_header("x-sample-rate", str(getattr(State.engine, "sample_rate", SAMPLE_RATE)))
                        self.send_header("Connection", "close")
                        self.end_headers()
                        started = True
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    total += len(chunk)
                    touch()
                took = time.time() - t0
            rate = getattr(State.engine, "sample_rate", SAMPLE_RATE)
            log(f"streamed {total / 2 / rate:.1f}s in {took:.1f}s (first audio {first or 0:.2f}s, {style}): {text[:50]}")
            if not started:
                self._json(500, {"error": "speech failed: no audio was produced"})
        except Exception as e:
            log(f"stream failed: {e!r}")
            if not started:
                try:
                    self._json(500, {"error": f"speech failed: {e}"})
                except Exception:
                    pass


def _wait_stdin_closed_windows():
    """Return when the gateway's end of our stdin pipe is closed, WITHOUT a blocking read.

    On Windows a thread blocked in a synchronous read on a pipe handle stalls every other operation on that handle. Loading the
    model runs a subprocess (qwen_tts looks for SoX), which touches stdin, so a blocking read here deadlocked the whole load
    (the server listened but never answered). Peeking the pipe does not block: it fails with "broken pipe" once the writer is gone.
    Returns False if stdin is not a pipe, so the caller can fall back to a plain read.
    """
    import ctypes
    import msvcrt
    from ctypes import wintypes

    k32 = ctypes.windll.kernel32
    k32.GetFileType.restype = wintypes.DWORD
    handle = wintypes.HANDLE(msvcrt.get_osfhandle(sys.stdin.fileno()))
    if k32.GetFileType(handle) != 3:  # FILE_TYPE_PIPE
        return False
    available = wintypes.DWORD(0)
    while k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
        time.sleep(0.5)
    return True


def watch_parent():
    """The gateway keeps our stdin open. End-of-file means it is gone (or asked us to stop): leave, freeing the GPU."""
    try:
        done = _wait_stdin_closed_windows() if os.name == "nt" else False
        if not done:
            while sys.stdin.buffer.read(1024):
                pass
    except Exception:
        pass
    log("parent went away; stopping")
    os._exit(0)


def watch_idle(seconds):
    while True:
        time.sleep(1)
        if time.time() - State.last_activity > seconds:
            log(f"idle for {seconds}s; stopping to free the GPU")
            request_stop()
            return


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=7791)
    ap.add_argument("--engine", choices=["qwen3", "qwen3stream", "chatterbox", "fake"], default="qwen3")
    ap.add_argument("--reference", help="reference voice clip (a ~10 s wav) for Chatterbox to copy")
    ap.add_argument("--qwen-root", help="the Qwen3-TTS workspace (models/ and ref/ref.json) for the qwen3 engine")
    ap.add_argument("--idle-exit", type=int, default=180, help="stop after this many seconds without a request")
    ap.add_argument("--no-parent-watch", action="store_true", help="debugging by hand: do not exit when stdin closes")
    args = ap.parse_args()

    if not args.no_parent_watch:
        threading.Thread(target=watch_parent, daemon=True).start()

    State.server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)  # listening before the model loads, so /health answers "loading"
    threading.Thread(target=State.server.serve_forever, daemon=True).start()
    log(f"listening on 127.0.0.1:{args.port} (engine {args.engine}); loading...")

    try:
        State.engine = (FakeEngine() if args.engine == "fake" else Qwen3Engine(args.qwen_root or "") if args.engine == "qwen3"
                        else Qwen3StreamEngine(args.qwen_root or "") if args.engine == "qwen3stream" else ChatterboxEngine(args.reference or ""))
    except Exception as e:
        log(f"cannot start: {e!r}")
        State.server.shutdown()
        # os._exit, not sys.exit: a normal interpreter shutdown crashes (access violation on Windows, Python 3.14) while the
        # background thread that watches stdin is still blocked reading it. We have nothing left to clean up.
        sys.stderr.flush()
        os._exit(2)
    touch()
    threading.Thread(target=watch_idle, args=(args.idle_exit,), daemon=True).start()

    State.stop.wait()  # until /shutdown or the idle watchdog stops the server
    State.server.server_close()
    log("stopped")
    sys.stderr.flush()
    os._exit(0)  # see above: skip interpreter shutdown, which crashes while the stdin watcher thread is blocked


if __name__ == "__main__":
    main()
