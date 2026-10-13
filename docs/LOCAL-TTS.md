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
that matches your GPU. Upgrade pip in a new venv first (`python -m pip install --upgrade pip`): an old pip can fail to
install PyTorch from its own index (it tries to build `typing-extensions` from source and cannot find `flit_core`).

### `chatterbox`: simplest, Windows

[Chatterbox TTS](https://github.com/resemble-ai/chatterbox) clones a voice from a ~10 second reference clip.

```powershell
py -3.11 -m venv C:\helix-tts\venv
C:\helix-tts\venv\Scripts\python -m pip install --upgrade pip
C:\helix-tts\venv\Scripts\pip install chatterbox-tts
# chatterbox-tts pins PyTorch 2.6 (CUDA 12.4), which does not run on RTX 50-series GPUs. If yours is one, or
# torch.cuda.is_available() is False, put a newer CUDA build on top (pip then warns about the pin; it still works):
C:\helix-tts\venv\Scripts\pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

```
HELIX_TTS_ENABLED=true
HELIX_TTS_ENGINE=chatterbox
HELIX_TTS_PYTHON=C:\helix-tts\venv\Scripts\python.exe
HELIX_TTS_REFERENCE=C:\helix-tts\my_voice.wav      # ~10 s of clean speech, a voice you have the right to use
HELIX_TTS_HF_HOME=C:\helix-tts\hf                  # optional: where model downloads are cached
```

The style "normal" uses expressive settings and "serious" (critical alerts, approvals) a calm set. Both are in
`STYLES` at the top of the server script.

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

Install `qwen-tts` from PyPI (it provides `qwen_tts.Qwen3TTSModel`) into a Python environment with CUDA PyTorch (it can
share the Chatterbox venv), and download the model from Hugging Face:

```powershell
C:\helix-tts\venv\Scripts\pip install qwen-tts
C:\helix-tts\venv\Scripts\hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base --local-dir C:\helix-tts\qwen\models\Qwen3-TTS-12Hz-1.7B-Base
```

Then:

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

1. In your WSL2 distro, install the build tools Triton needs to compile at start-up (without them the start fails with
   `Python.h: No such file or directory`), then a venv with CUDA PyTorch and a streaming-capable fork of Qwen3-TTS as
   `qwen_tts` (one that provides `stream_generate_voice_clone`). Triton comes with PyTorch on Linux.

   ```bash
   sudo apt install python3-venv python3-dev build-essential
   python3 -m venv ~/helix-tts/venv && ~/helix-tts/venv/bin/python -m pip install --upgrade pip
   ~/helix-tts/venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
   ~/helix-tts/venv/bin/pip install git+https://github.com/dffdeeq/Qwen3-TTS-streaming
   ```
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
npm run voice -- clips --out data\voice-clips       # a few minutes on a free GPU; resumes where it stopped
```

It needs the GPU memory for its own copy of the voice, so stop the gateway's voice first if it is running
(`POST /v1/voice/tts/stop`, same headers as above); otherwise it refuses with "only N MB of GPU memory is free".

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
