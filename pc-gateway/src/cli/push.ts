// Check the Apple push setup before a phone exists (and again whenever something stops ringing).
//
//   npm run push -- check
//
// Reads HELIX_APNS_* from pc-gateway/.env. Tells you in plain language whether the key is usable, whether Apple is
// reachable from this PC, and whether Apple's servers accept your key, team and bundle id. Needs no phone and sends
// nothing to a real device. Exit code 0 means nothing failed.
import { loadConfig, loadDotEnv } from "../config.js";
import { preflight, type Step } from "../notifications/apns-check.js";

loadDotEnv();
const [cmd] = process.argv.slice(2);

if (cmd !== "check") {
  console.log("usage: npm run push -- check");
  process.exit(cmd ? 1 : 0);
}

const config = loadConfig();
const env = process.env;
const result = await preflight({
  keyPath: config.apns?.keyPath ?? env.HELIX_APNS_KEY_PATH,
  keyId: config.apns?.keyId ?? env.HELIX_APNS_KEY_ID,
  teamId: config.apns?.teamId ?? env.HELIX_APNS_TEAM_ID,
  bundleId: config.apns?.bundleId ?? env.HELIX_APNS_BUNDLE_ID,
});

const mark: Record<Step["status"], string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "skip" };
console.log("\nApple push preflight\n");
for (const s of result.steps) {
  console.log(`  [${mark[s.status]}] ${s.name}: ${s.detail}`);
  if (s.advice && s.status !== "pass") console.log(`         -> ${s.advice}`);
}
const failed = result.steps.filter((s) => s.status === "fail").length;
const skipped = result.steps.filter((s) => s.status === "skip").length;
console.log(
  result.ok
    ? skipped ? `\nNothing failed, but ${skipped} check(s) were skipped. Fill in the settings and run it again.\n` : "\nAll good: Apple will accept pushes and calls from this PC.\n"
    : `\n${failed} check(s) failed. Fix those and run it again.\n`
);
process.exit(result.ok ? 0 : 1);
