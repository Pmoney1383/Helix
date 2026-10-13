# Persona: how Helix sounds

When Helix speaks (on a call, or a reply sent with `voice: true`), the gateway adds a short style instruction to that
one turn. The persona changes the **wording only**. It never changes what is decided, which tools run, or whether the
information is accurate. Typed chat is never touched.

## Modes

The default is **professional**. Pick another mode with `PUT /v1/persona {"mode": "..."}`. (The app has a personality screen, but it does not sync to the gateway yet.)

| Mode | Teasing | Flirtiness | Sarcasm | Verbosity | Feel |
|---|---|---|---|---|---|
| `professional` (default) | 0 | 0 | 0 | 0.2 | Neutral and concise, no jokes |
| `casual` | 0.2 | 0 | 0.1 | 0.35 | Relaxed and friendly, like a capable colleague |
| `playful` | 0.6 | 0.1 | 0.5 | 0.4 | Witty and warm, light teasing |
| `flirty` | 0.6 | 0.85 | 0.2 | 0.4 | Confident and charming; uses an occasional pet name |
| `unhinged` | 0.8 | 0.5 | 0.7 | 0.5 | Deliberately goofy, still exact about the facts |

Switching mode applies that mode's slider preset. You can then move the sliders yourself (`teasing`, `flirtiness`,
`sarcasm`, `verbosity`, each 0 to 1), or set `enabled: false` for spoken-style replies with no personality at all.

`petNames` (1 to 12 short names) is the list the flirty mode may pick from now and then. It is validated strictly because
it goes into the model's instructions.

## The safety clamp

The more serious the moment, the less character. This is enforced by the gateway (`pc-gateway/src/persona/clamp.ts`),
whatever the settings:

| Severity | Character kept | Flirting | Highest mode allowed |
|---|---|---|---|
| `info`, `normal` | all | all | any |
| `warning` (an event that needs attention) | ×0.35 | ×0.4 | playful / flirty |
| `high` | ×0.1 | none | casual |
| `critical`, `approval` | none, terse | none | professional |

Critical alerts and approvals have fixed, model-free wording, so their tone is guaranteed. A call that starts critical
stays clamped for its whole length.

## Who gets the personality

- **Helix itself** (the front doors "General Claude" and "Astra", and calls to them) speaks in your chosen persona.
- **A work session** you chat with directly never gets the flirty character. If you chose `flirty`, sessions fall back
  to `casual`. Other modes apply as chosen.
- **On a live call**, every reply is held to two or three short sentences. The gateway enforces this: only the first
  sentences are spoken, and the chat keeps the full reply.

## API

| | |
|---|---|
| `GET /v1/persona` | Settings, the presets, and `effective`: how each severity is clamped |
| `PUT /v1/persona` | Change mode, sliders, `petNames`, `speech {rate, pitch, voiceId}` (stored for the app) |
| `POST /v1/persona/preview` | The exact instruction and a sample greeting for a setting, without saving |
| `GET /v1/voice/filler?severity=` | The line to say while the agent thinks, in the current persona |

The greetings, fillers and openers Helix says itself are plain text in `pc-gateway/src/persona/lines.ts`, so you can
edit them freely. If you use a local voice with pre-recorded clips, re-record them after editing ([LOCAL-TTS.md](LOCAL-TTS.md)).

## Limits

For model-written replies the clamp shapes the *instruction*. Models follow it very reliably, but it is not an output
filter. The phone still strips stray markdown and emoji before speaking.
