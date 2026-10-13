// usage-guard: one line above the prompt with the context size and the 5-hour usage left,
// plus a warning when a session gets big enough to be expensive to keep talking to.
//
// Why: every turn re-reads the whole context. At 500k+ tokens that is what drains the 5-hour window.

const WARN_TOKENS = 150_000 // time to /compact or start fresh
const BIG_TOKENS = 300_000 // every message now costs a lot
const LIMIT_WARN = [25, 10] // percent of the 5-hour window left
const REFRESH_MS = 30_000

let ctx = { tokens: undefined, window: 0, percent: undefined }
let limits = []
// Warn once per level; reset when the context drops (after /compact or /clear)
let ctxLevel = 0
const limitWarned = new Set()

function fmtTokens(n) {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function fmtLeft(ms) {
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60_000)
  return m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm' : m + 'm'
}

function levelOf(tokens) {
  return tokens >= BIG_TOKENS ? 2 : tokens >= WARN_TOKENS ? 1 : 0
}

// Take in a fresh reading and say something the first time a threshold is crossed
function absorb($, context, rateLimits) {
  ctx = context
  limits = rateLimits ?? []

  const tokens = ctx.tokens ?? 0
  const level = levelOf(tokens)
  if (level > ctxLevel) {
    const text =
      level === 2
        ? 'Context is ' + fmtTokens(tokens) + ': every message re-reads all of it. /compact now, or start a fresh session.'
        : 'Context passed ' + fmtTokens(WARN_TOKENS) + '. Consider /compact before it gets expensive.'
    $.ui.toast(text)
    $.ui.log(text)
  }
  ctxLevel = level

  const five = limits.find((l) => l.kind === 'five_hour')
  if (five) {
    const left = 100 - five.percentUsed
    for (const t of LIMIT_WARN) {
      if (left <= t && !limitWarned.has(t)) {
        limitWarned.add(t)
        const text = '5-hour usage: only ' + Math.max(0, Math.round(left)) + '% left.'
        $.ui.toast(text)
        $.ui.log(text)
      }
    }
    // A new window started: warn again next time
    if (left > LIMIT_WARN[0]) limitWarned.clear()
  }
  $.ui.invalidate('ui.render')
}

async function refresh($) {
  const u = await $.session.usage()
  absorb($, u.context, u.rateLimits)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // Keep the countdown and numbers current between turns
    $.clock.every(REFRESH_MS, () => refresh($))
    refresh($)
    return next(e)
  })

  // After each turn, and whenever a plan limit moves a whole point
  on('session.measure', async ($, e, next) => {
    absorb($, e.context, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const parts = []

    const tokens = ctx.tokens
    if (tokens === undefined) {
      parts.push(Text({ dimColor: true, children: ['context: fresh'] }))
    } else {
      const level = levelOf(tokens)
      const pct = ctx.percent !== undefined ? ' (' + Math.round(ctx.percent) + '%)' : ''
      const tail = level === 2 ? ' - /compact or start fresh' : level === 1 ? ' - consider /compact' : ''
      parts.push(
        Text({
          bold: level > 0,
          color: level === 2 ? 'red' : level === 1 ? 'yellow' : undefined,
          dimColor: level === 0,
          children: ['context ' + fmtTokens(tokens) + pct + tail],
        }),
      )
    }

    const five = limits.find((l) => l.kind === 'five_hour')
    if (five) {
      const left = Math.max(0, 100 - five.percentUsed)
      const reset = five.resetsAt ? ' - resets in ' + fmtLeft(Date.parse(five.resetsAt) - now) : ''
      parts.push(
        Text({
          bold: left <= LIMIT_WARN[0],
          color: left <= LIMIT_WARN[1] ? 'red' : left <= LIMIT_WARN[0] ? 'yellow' : undefined,
          dimColor: left > LIMIT_WARN[0],
          children: ['5h left ' + Math.round(left) + '%' + reset],
        }),
      )
    }
    const week = limits.find((l) => l.kind === 'seven_day')
    if (week) parts.push(Text({ dimColor: true, children: ['week left ' + Math.round(Math.max(0, 100 - week.percentUsed)) + '%'] }))

    const mine = Box({ flexDirection: 'row', columnGap: 3, children: parts })
    // Keep whatever other mods draw in the band
    const theirs = await next(e)
    return Box({ flexDirection: 'column', children: [mine, theirs] })
  })
}
