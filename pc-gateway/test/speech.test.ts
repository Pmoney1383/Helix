import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SentenceStream, toSpeech } from "../src/voice/speech.js";

describe("toSpeech: written reply to speakable text", () => {
  const cases: [string, string, string][] = [
    ["bold and emphasis", "**Done!** Training is *finished* and __safe__.", "Done! Training is finished and safe."],
    ["inline code keeps its content", "Run `npm test` again.", "Run npm test again."],
    ["links keep the label, bare urls become 'a link'", "See [the docs](https://example.com/x?y=1) or https://example.com/very/long/url now.", "See the docs or a link now."],
    ["images keep alt text", "![loss curve](https://x.test/a.png) looks flat.", "loss curve looks flat."],
    ["windows paths shrink to the file name", "The log is at C:\\Users\\me\\proj\\runs\\train.log, check it.", "The log is at train.log, check it."],
    ["unix paths too", "Open /home/me/proj/src/app.py now.", "Open app.py now."],
    ["emoji are dropped", "All good 🎉🔥 see you ✅", "All good see you."],
    ["headings and bullets become sentences", "## Status\n- GPU at 97 percent\n- Loss is 0.184\n1. Next step is eval", "Status. GPU at 97 percent. Loss is 0.184. Next step is eval."],
    ["tables become plain phrases", "| name | value |\n|---|---|\n| loss | 0.184 |", "name, value. loss, 0.184."],
    ["numbers and decimals survive", "Step 84,231, loss 0.184, lr 1e-4.", "Step 84,231, loss 0.184, lr 1e-4."],
    ["quotes and task boxes", "> Note this\n- [x] shipped", "Note this. shipped."],
    ["html tags", "Hello <b>there</b> friend.", "Hello there friend."],
  ];
  for (const [name, input, want] of cases) it(name, () => assert.equal(toSpeech(input), want));

  it("never reads code aloud, and says so", () => {
    assert.equal(toSpeech("Here is the fix:\n```ts\nconst x = 1;\nrm -rf /\n```\nThat should do it."), "Here is the fix: There is some code in the chat. That should do it.");
  });
  it("a reply cut off inside a code block drops the unfinished code", () => {
    assert.equal(toSpeech("Try this:\n```python\nprint('hi'"), "Try this: There is some code in the chat.");
  });
  it("is idempotent", () => {
    for (const [, input] of cases) { const once = toSpeech(input); assert.equal(toSpeech(once), once); }
  });
  it("empty and symbol-only input give empty speech", () => {
    assert.equal(toSpeech(""), "");
    assert.equal(toSpeech("🎉🎉\n\n---"), "");
  });
});

describe("SentenceStream: sentences as they complete", () => {
  const feed = (chunks: string[], min?: number): string[] => {
    const s = new SentenceStream(min);
    const out: string[] = [];
    for (const c of chunks) out.push(...s.push(c));
    out.push(...s.flush());
    return out;
  };
  const chars = (t: string) => t.split("");

  it("emits each sentence as soon as the next character proves it ended, even one character at a time", () => {
    const s = new SentenceStream();
    const timeline: string[][] = [];
    for (const c of chars("Hello there. How are you? I am fine.")) timeline.push(s.push(c));
    assert.deepEqual(timeline.flat(), ["Hello there.", "How are you?"]);
    assert.deepEqual(s.flush(), ["I am fine."]);
    const firstAt = timeline.findIndex((t) => t.length);
    assert.ok(firstAt < 14, "the first sentence is out long before the reply is complete");
  });

  it("does not split decimals, file names, abbreviations or initials", () => {
    assert.deepEqual(feed(["Loss is 0.184 now and app.py is fine, e.g. the main one. J. Smith agrees."]), ["Loss is 0.184 now and app.py is fine, e.g. the main one.", "J. Smith agrees."]);
  });

  it("waits for a code block to close, then says one line about it", () => {
    const out = feed(["Here you go.\n```", "ts\nconst a = 1;\n", "```\n", "Done now, thanks."]);
    assert.deepEqual(out, ["Here you go.", "There is some code in the chat.", "Done now, thanks."]);
  });

  it("list items are sentences of their own, and markdown never reaches the speech", () => {
    const out = feed(["Status:\n- **GPU** at 97 percent\n- Loss is 0.184\n"]);
    assert.deepEqual(out, ["Status: GPU at 97 percent.", "Loss is 0.184."]);
  });

  it("joins a very short fragment to the next so the voice does not stutter", () => {
    assert.deepEqual(feed(["OK. Training is done now."]), ["OK. Training is done now."]);
  });

  it("flush speaks what is left, and a pause (tool call) flushes the sentence in progress", () => {
    const s = new SentenceStream();
    assert.deepEqual(s.push("Let me check the logs"), []);
    assert.deepEqual(s.flush(), ["Let me check the logs."]);
    assert.deepEqual(s.push("Found it. The run is healthy. "), ["Found it. The run is healthy."]);
  });

  it("skips pure markup and emoji", () => {
    assert.deepEqual(feed(["🎉\n\n---\n\nAll done here."]), ["All done here."]);
  });

  it("the sentences together equal the one-shot conversion of the whole reply", () => {
    const reply = "## Result\nThe run finished. Loss is 0.184 at step 84,231.\n- GPU is idle\n- Disk is fine\nSee [the log](https://x.test/l).";
    const streamed = feed(chars(reply)).join(" ");
    assert.equal(streamed.replace(/\.\s/g, ". "), toSpeech(reply).replace(/\.\s/g, ". "));
  });
});
