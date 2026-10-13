// Is this message an instruction to the ROUTER ("connect me to the agent working on Helix"), rather than work for the agent
// being connected to? If the router passes such a sentence along as `message`, the target agent receives a question that was
// never meant for it, answers it literally ("there are two agents running, which one?"), and the user thinks they are still
// talking to the front door. A connection request should connect silently; the target waits for the user's own next message.
//
// Deliberately conservative: only a message that is NOTHING BUT a connect/switch/talk-to request is dropped. Anything that
// also asks for something to be done ("connect me to helix and run the tests") is real work and is delivered.

const START = /^(?:(?:hey|ok(?:ay)?|so|well|um+|uh+)[,\s]+)*(?:(?:please|pls)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:i\s+(?:want|need|d like|would like|wanna)\s+(?:you\s+)?to\s+|let\s+me\s+|let'?s\s+)?/i;

// "connect me to X", "put me through to X", "switch me over to X", "take me to X", "hand me to X", "get me X", "patch me into X", "transfer me to X"
const CONNECT = /(?:connect|put|switch|take|transfer|hand|patch|bring|route|pass|send|get|move|bounce|forward)\s+(?:me|us|this\s+(?:call|chat|conversation))\s+(?:(?:through|over|back|across)\s+)?(?:to|into|with|onto|over\s+to)?\s*\S/i;
// "talk to X", "speak with X", "go to X", "jump to X", "open X", "call X", "switch to X", "I want to talk to X"
const TALK = /(?:talk(?:ing)?|speak(?:ing)?|chat(?:ting)?|go|jump|switch|change|swap|move)\s+(?:over\s+)?(?:to|with)\s+\S/i;
const CALL = /^call\s+\S/i;

/** Words that mean the sentence also asks for something to be done. */
const ALSO_ASKS = /\b(?:and|then|also|tell|ask|have|make|so\s+(?:that|it|they)|to\s+(?:run|check|fix|build|write|add|update|deploy|test|look|find|show|summari[sz]e|explain|continue|finish|start|stop|restart|delete|remove|create|implement|review|read|open)|run|fix|check|build|write|deploy)\b|[;?]/i;

export function isRoutingOnly(message: string | undefined): boolean {
  if (!message) return false;
  const text = message.trim().replace(/[.!\s]+$/, "");
  if (!text || text.length > 160) return false;
  const body = text.replace(START, "");
  if (!(CONNECT.test(body) || TALK.test(body) || CALL.test(body))) return false;
  // "connect me to the agent working on helix": the word "working" is about the TARGET, not a request, so only the words
  // that follow the connect phrase are checked for a second request.
  const after = body.replace(/^.*?(?:connect|put|switch|take|transfer|hand|patch|bring|route|pass|send|get|move|bounce|forward|talk(?:ing)?|speak(?:ing)?|chat(?:ting)?|go|jump|change|swap|call)\b/i, "");
  const target = after.replace(/^\s*(?:me|us|this\s+(?:call|chat|conversation))?\s*(?:(?:through|over|back|across)\s+)?(?:to|into|with|onto)?\s*/i, "");
  return !ALSO_ASKS.test(target);
}
