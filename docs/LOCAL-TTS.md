# Local PC voice (optional, bring your own model)

By default the phone speaks replies with Apple's built-in voice, which needs no setup. Helix can also speak with a
**local text-to-speech model on your PC's GPU**. That gives a far more natural voice on calls, can be your own cloned
voice, and no audio leaves your machine.

**No model, weights or voice ships with Helix.** The repo contains only the glue: a small speech server
(`pc-gateway/tts/helix_tts_server.py`) and the gateway code that starts and stops it. You install a TTS model yourself,
under its own license, and point Helix at it.

## How it works

- **Off unless enabled** (`HELIX_TTS_ENABLED=true`). Even then nothing loads at boot.
- **Starts on demand:** when a call rings or you start one, when a spoken turn asks for the PC voice
  (`"engine": "pc"`), or on `POST /v1/voice/tts/warm`.
- **Never competes with your GPU work.** Before starting, it checks free VRAM (`HELIX_TTS_MIN_FREE_VRAM_MB`, default 6000)
  and free RAM (`HELIX_TTS_MIN_FREE_RAM_MB`, default 4000). If either is short, it refuses, and the phone falls back to Apple's voice.
- **Stops itself** after `HELIX_TTS_IDLE_SEC` (default 180) unused. It also stops when the gateway exits or crashes (it
  watches its stdin pipe) and on `POST /shutdown`. It listens on `127.0.0.1` only.
- **Optional warm-while-away** (`HELIX_TTS_WARM_WHEN_AWAY`, default true): while you are away from the PC and the GPU is
  free, it keeps the voice loaded so a call starts instantly. It unloads if something else needs the GPU.
- Each sentence of a spoken reply becomes `agent.audio` events (16-bit mono PCM) for the phone. If the PC voice can't
  speak, the phone gets one `agent.audio.unavailable` and uses Apple's voice. See [CALLS.md](CALLS.md) for the events.

## Built-in engines

`HELIX_TTS_ENGINE` selects one. Each needs a Python environment with the model's own package and a CUDA build of PyTorch
that matches your GPU.

### `chatterbox`: simplest, Windows

[Chatterbox TTS](https://github.com/resemble-ai/chatterbox) clones a voice from a ~10 second reference clip.

```powershell
py -3.11 -m venv C:\helix-tts\venv
C:\helix-tts\venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu128   # pick the CUDA build for your GPU
C:\helix-tts\venv\Scripts\pip install chatterbox-tts
```

```
HELIX_TTS_ENABLED=true
HELIX_TTS_ENGINE=chatterbox
HELIX_TTS_PYTHON=C:\helix-tts\venv\Scripts\python.exe
HELIX_TTS_REFERENCE=C:\helix-tts\my_voice.wav      # ~10 s of clean speech, a voice you have the right to use
HELIX_TTS_HF_HOME=C:\helix-tts\hf                  # optional: where model downloads are cached
```

The style "normal" uses expressive settings and "serious" (critical alerts, approvals) a calm set. Both are in
`STYLES` at the top of the server script. If `chatterbox-tts` pins a PyTorch that does not support your GPU, install it
with `--no-deps` on top of a newer PyTorch and add its other dependencies by hand.

### `qwen3`: Qwen3-TTS zero-shot clone, Windows

[Qwen3-TTS](https://huggingface.co/Qwen) clones from a reference clip plus its transcript. It generates one whole
sentence at a time.

Make a workspace folder with this layout:

```
C:\helix-tts\qwen\
  models\Qwen3-TTS-12Hz-1.7B-Base\     the downloaded base model
  ref\ref.json                         {"audio": "C:\\helix-tts\\qwen\\ref\\ref.wav", "text": "exact transcript of ref.wav"}
  ref\ref.wav
```

Install the `qwen-tts` package (providing `qwen_tts.Qwen3TTSModel`) into a Python environment with CUDA PyTorch, then:

```
HELIX_TTS_ENABLED=true
HELIX_TTS_ENGINE=qwen3
HELIX_TTS_PYTHON=C:\helix-tts\venv\Scripts\python.exe
HELIX_TTS_QWEN_ROOT=C:\helix-tts\qwen
```

The same text always uses the same seed, so a line sounds the same each time, and a take that comes out as noise is
retried once. Generation is slower than real time on most GPUs, so the gateway holds the first audio until the rest can
play without gaps (`HELIX_TTS_SMOOTH_HOLD_SEC`, default 12, 0 = no holding).

### `qwen3stream`: true streaming, WSL2

The same model with incremental streaming and compiled kernels, which need Triton and so run on Linux. The gateway starts
it inside WSL2 through `wsl.exe`. Expect first audio in about 0.1 s and generation several times faster than real time.

1. In your WSL2 distro, create a Python venv with CUDA PyTorch and install a streaming-capable fork of Qwen3-TTS as
   `qwen_tts` (one that provides `stream_generate_voice_clone`, for example `dffdeeq/Qwen3-TTS-streaming`) plus Triton.
2. Copy the workspace layout above to a Linux path (for example `~/helix-tts/qwen`), with `ref.json` pointing at the Linux copy of `ref.wav`.
3. Configure:

```
HELIX_TTS_ENABLED=true
HELIX_TTS_ENGINE=qwen3stream
HELIX_TTS_WSL_DISTRO=Ubuntu
HELIX_TTS_WSL_PYTHON=/home/<you>/helix-tts/venv/bin/python
HELIX_TTS_WSL_QWEN_ROOT=/home/<you>/helix-tts/qwen
```

The first start ever compiles for one to two minutes. Later starts reuse the compile cache in `<qwen root>/inductor-cache`.
WSL2 holds file cache as RAM. If Windows' free RAM drops under the start guard, run
`wsl -d Ubuntu -u root -- sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"`.

## Try it

After changing `.env`, restart the gateway (`service\update.ps1`), then:

```powershell
# with a device token (see PUSH-SETUP.md, "Test with the phone", for getting one)
Invoke-RestMethod http://127.0.0.1:7777/v1/voice/tts/status -Headers @{ Authorization = "Bearer $t" }
Invoke-RestMethod http://127.0.0.1:7777/v1/voice/tts/warm -Method Post -Headers @{ Authorization = "Bearer $t" }
```

`state` goes `off` → `starting` → `running`. If it fails to start, `lastError` carries the last lines the server printed
(`[helix-tts] ...`). A refusal
names its reason: `disabled`, `not_configured`, `gpu_busy`, `gpu_unknown`, `ram_low`, `start_failed` or `speech_failed`.

## Pre-recorded lines (optional)

Greetings, fillers and digest lines can be recorded once so they play instantly, with no GPU at call time:

```powershell
npm run voice -- clips --out data\voice-clips       # several minutes on a free GPU; resumes where it stopped
```

Then set `HELIX_TTS_CLIPS_DIR=<that folder>` and restart. Re-run it after editing `src/persona/lines.ts`.

## Adding another engine

The server's contract is small. An engine is a Python class with:

- `name` (string) and `sample_rate` (int, Hz);
- `speak(text, style, seed=None) -> bytes`: one sentence as signed 16-bit little-endian mono PCM. `style` is `"normal"` or `"serious"`;
- optionally `stream(text, style, seed=None)`, yielding PCM chunks as they are generated (used by `POST /stream`).

To wire one in:

1. Add the class to `pc-gateway/tts/helix_tts_server.py`, its name to the `--engine` choices, and its construction to `main()`.
2. Add the name to `HELIX_TTS_ENGINE` in `pc-gateway/src/config.ts` and to the engine type in `src/voice/tts-manager.ts`
   (also its "configured" rule there, if it needs settings).
3. Test it by hand with `python helix_tts_server.py --engine <name> --no-parent-watch`, then `curl -X POST
   http://127.0.0.1:7791/speak -d "{\"text\":\"Hello there.\",\"style\":\"normal\"}" -o out.pcm`.

The gateway's tests use the server's `fake` engine (a quiet tone, no model), so `npm test` never needs a GPU.

## Be responsible with voices

Only clone a voice you have the right to use, such as your own or one with clear permission. Some models also watermark
their output; keep that on.
