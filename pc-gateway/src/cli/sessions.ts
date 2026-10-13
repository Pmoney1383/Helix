// Diagnostic: index this machine's Claude/Codex sessions into a throwaway database and print them.
//   npm run sessions            list the 25 most recent
//   npm run sessions -- --live  only sessions that are open right now
//   npm run sessions -- --q helix
import { SessionIndexer, defaultHomes } from "../discovery/indexer.js";
import { EventBus } from "../sessions/manager.js";
import { openDb } from "../storage/sqlite.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i === -1 ? undefined : (args[i + 1]?.startsWith("--") || args[i + 1] === undefined ? "true" : args[i + 1]); };

const indexer = new SessionIndexer(openDb(":memory:"), new EventBus(), { homes: defaultHomes() });
const t0 = Date.now();
const r = await indexer.scan();
console.log(`indexed ${r.files} transcript files in ${Date.now() - t0} ms\n`);

const rows = indexer.list({
  live: flag("live") ? true : undefined,
  provider: flag("provider") as "claude" | "codex" | undefined,
  q: flag("q") && flag("q") !== "true" ? flag("q") : undefined,
  limit: Number(flag("limit") ?? 25),
});
for (const s of rows) {
  const live = s.live ? `LIVE ${s.liveStatus}${s.liveInferred ? "?" : ""}` : "";
  console.log(`${s.provider.padEnd(6)} ${s.id.slice(0, 8)}  ${(s.lastActivityAt ?? "").slice(0, 16)}  ${String(s.messageCount).padStart(4)} msgs  ${live.padEnd(11)} ${s.title.slice(0, 48).padEnd(48)} ${s.projectName ?? ""}`);
}
console.log(`\n${rows.length} shown`);
