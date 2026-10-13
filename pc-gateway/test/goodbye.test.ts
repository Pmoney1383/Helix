import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGoodbye } from "../src/calls/goodbye.js";

describe("recognising a goodbye on a call", () => {
  it("hears clear farewells, however the speech recogniser words them", () => {
    for (const t of ["bye", "Bye bye!", "okay goodbye", "good bye Claude", "alright, thanks, bye", "that's all for now", "that is all", "talk to you later",
      "see you later", "see ya", "I gotta go", "okay I'm done", "hang up", "end the call please", "later", "good night", "thanks that's all", "ok take care"]) {
      assert.equal(isGoodbye(t), true, t);
    }
  });

  it("leaves real work, questions and negations alone", () => {
    for (const t of ["", "check why the build failed", "by the way how is training going", "can you say bye to the cat session and then check the logs for me",
      "don't hang up", "wait don't go yet", "is that all?", "what did you do later today", "I'll do that later after the tests finish running and the logs are clean",
      "not yet, I'm not done", "goodbye is not what I meant, keep going", "read the log file before you end the call"]) {
      assert.equal(isGoodbye(t), false, t);
    }
  });
});
