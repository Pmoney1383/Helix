# usage-guard (Claude Code mod)

One line above the prompt, updated live:

```
context 84k (8%)      5h left 62% - resets in 2h10m      week left 81%
```

- Context turns **yellow at 150k** and **red at 300k** tokens, with a toast and a transcript line the first time each is crossed. Every message re-reads the whole context, so this is what drains the 5-hour window. Reset it with `/compact`, or start a fresh session.
- The 5-hour figure comes from `$.session.usage().rateLimits` (`five_hour`). It warns at 25% and 10% left.
- Refreshes after every turn, whenever a limit moves a point, and every 30 s (so the reset countdown ticks).

Needs Claude Code 2.1.287+. It works on its own, without the Helix gateway. Load it for one session with:

```
claude --plugin-dir "<path to your Helix clone>\mods\usage-guard"
```

Thresholds are constants at the top of `hooks/register.js`. Tests: `claude plugin test` in this folder.
