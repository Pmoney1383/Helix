/**
 * Source of a function that runs in a browser page, as an expression to paste into a <script>.
 * Run from TypeScript source (tsx: `npm test`, `npm run dev`), esbuild inserts calls to its own `__name()` helper
 * into named functions, and the page does not have it. The wrapper supplies a no-op one, scoped to this function.
 * The compiled build (tsc) never emits the helper, so there the wrapper does nothing.
 */
export function browserSource(fn: (...args: never[]) => unknown): string {
  return `((__name)=>(${fn.toString()}))((f)=>f)`;
}
