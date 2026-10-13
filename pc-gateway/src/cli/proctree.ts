// Diagnostic: print the process tree under every running Claude/Codex process, i.e. what the
// "Agent processes" watch can see. Useful when a job you expected to be tracked was not.
//   npm run proctree
import { processSnapshot } from "../mcp/pc-tools.js";

const snap = await processSnapshot();
const byParent = new Map<number, typeof snap>();
for (const p of snap) {
  const l = byParent.get(p.ppid) ?? [];
  l.push(p);
  byParent.set(p.ppid, l);
}
const now = Date.now();
const age = (p: (typeof snap)[number]) => {
  const s = Math.round((now - p.createdMs) / 1000);
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const show = (p: (typeof snap)[number], depth: number) => {
  console.log(`${"  ".repeat(depth)}${p.pid} ${p.name} [${age(p)}]  ${p.cmd.slice(0, 100)}`);
  for (const c of byParent.get(p.pid) ?? []) if (c.pid !== p.pid && depth < 8) show(c, depth + 1);
};
const roots = snap.filter((p) => /^(claude|codex)(\.exe)?$/i.test(p.name));
console.log(`${roots.length} agent process(es)\n`);
for (const r of roots) { show(r, 0); console.log(""); }
