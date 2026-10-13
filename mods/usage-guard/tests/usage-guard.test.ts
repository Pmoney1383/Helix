import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-guard',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 90, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

function stubs(on: any, usage: any, toasts: string[]) {
  mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: usage }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }))
}

const measure = (context: any, rateLimits: any[]) => ({ context, rateLimits, changed: ['context'] })

test('small context and plenty of 5h left: no warning, numbers shown', async ($, on) => {
  const toasts: string[] = []
  stubs(on, { context: { window: 1_000_000 }, rateLimits: [] }, toasts)
  on('session.measure', () => ({ changed: ['context'] }))
  await $.session.measure(
    measure({ tokens: 40_000, window: 1_000_000, percent: 4 }, [{ kind: 'five_hour', percentUsed: 30, resetsAt: '1970-01-01T02:00:00Z' }]),
  )
  expect(toasts).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /context 40k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h left 70% - resets in 2h00m/ })).toBeDefined()
})

test('crossing 150k warns once, 300k warns again', async ($, on) => {
  const toasts: string[] = []
  stubs(on, { context: { window: 1_000_000 }, rateLimits: [] }, toasts)
  on('session.measure', () => ({ changed: ['context'] }))
  await $.session.measure(measure({ tokens: 160_000, window: 1_000_000, percent: 16 }, []))
  await $.session.measure(measure({ tokens: 170_000, window: 1_000_000, percent: 17 }, []))
  expect(toasts.length).toBe(1)
  await $.session.measure(measure({ tokens: 320_000, window: 1_000_000, percent: 32 }, []))
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toMatch(/compact/)
})

test('low 5h usage warns at 25% and 10% left', async ($, on) => {
  const toasts: string[] = []
  stubs(on, { context: { window: 1_000_000 }, rateLimits: [] }, toasts)
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  const ctx = { tokens: 10_000, window: 1_000_000, percent: 1 }
  await $.session.measure(measure(ctx, [{ kind: 'five_hour', percentUsed: 80 }]))
  expect(toasts).toEqual(['5-hour usage: only 20% left.'])
  await $.session.measure(measure(ctx, [{ kind: 'five_hour', percentUsed: 92 }]))
  expect(toasts.length).toBe(2)
})
