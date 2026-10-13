// Record Helix's canned lines (greetings, fillers, digest lines) in the PC voice so they play instantly, with no GPU at call time.
//
//   npm run voice -- clips [--out <dir>] [--force]
//
// Needs the PC voice configured in pc-gateway/.env (docs/LOCAL-TTS.md) and a free GPU: it will not start while another job,
// including the gateway's own loaded voice (POST /v1/voice/tts/stop), is using it. Writes <dir>/*.wav and <dir>/manifest.json; point HELIX_TTS_CLIPS_DIR at <dir>.
// Clips that already exist are kept (so an interrupted run carries on); --force records everything again.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv } from "../config.js";
import { clipPlan, pcmToWav } from "../voice/clip-maker.js";
import { TtsManager } from "../voice/tts-manager.js";

loadDotEnv();
const args = process.argv.slice(2);
if (args[0] !== "clips") {
  console.log("usage: npm run voice -- clips [--out <dir>] [--force]");
  process.exit(args.length ? 1 : 0);
}
const force = args.includes("--force");
const outIdx = args.indexOf("--out");
const config = loadConfig();
const out = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : path.join(config.dataDir, "voice-clips"));
fs.mkdirSync(out, { recursive: true });

const tts = new TtsManager({ ...config.tts, enabled: true, idleSec: 300 }, { log: { info: () => undefined, warn: (_o, m) => console.log(`  (${m})`) } });
const plan = clipPlan();
const manifestPath = path.join(out, "manifest.json");
const manifest: { id: string; kind: string; text: string; voice: string; file: string; seconds: number }[] = [];
let made = 0, kept = 0;
try {
  console.log(`Recording ${plan.length} lines into ${out} with the ${config.tts.engine} voice. The model loads first (up to a minute).\n`);
  const previous = (() => { try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest; } catch { return []; } })();
  for (const [i, item] of plan.entries()) {
    const file = `${item.id}.wav`;
    const old = previous.find((c) => c.id === item.id && c.text === item.text);
    if (!force && old && fs.existsSync(path.join(out, file))) { manifest.push(old); kept++; continue; }
    const started = Date.now();
    const { pcm, sampleRate } = await tts.speak(item.text, item.voice === "plain" ? "serious" : "normal");
    fs.writeFileSync(path.join(out, file), pcmToWav(pcm, sampleRate));
    manifest.push({ id: item.id, kind: item.kind, text: item.text, voice: item.voice, file, seconds: Math.round((pcm.length / 2 / sampleRate) * 100) / 100 });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); // after every clip: an interrupted run loses nothing
    made++;
    console.log(`  ${i + 1}/${plan.length} ${item.id} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nDone: ${made} recorded, ${kept} kept. Set HELIX_TTS_CLIPS_DIR=${out} and restart the gateway to use them.\n`);
} catch (err) {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await tts.stop("clips done");
}
