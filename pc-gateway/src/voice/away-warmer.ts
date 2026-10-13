// Keeps the PC voice loaded while the user is away from the PC (and the GPU has room), so "hey Siri, call Claude" does not wait for the
// model. Loading still goes through the manager's guards (free VRAM and RAM), so it never starts while the image trainer has the GPU.
// If the GPU gets squeezed later while the voice sits unused, it unloads itself again.
import type { TtsStatus } from "./tts-manager.js";

export interface WarmTarget {
  status(): TtsStatus;
  warm(): Promise<TtsStatus>;
  /** Push the idle stop back without counting as a use. */
  keepLoaded(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export interface WarmerDeps {
  isAway: () => boolean;
  gpuFreeMb: () => Promise<number | undefined>;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  intervalMs?: number;
  /** Unload an unused voice when free GPU memory drops below this (something else is taking the GPU). */
  squeezeMb?: number;
  /** ...but only if it has been unused for this long. */
  unusedSec?: number;
  now?: () => number;
}

export type WarmTick = "warmed" | "kept" | "yielded" | "skipped";

export class AwayWarmer {
  constructor(private readonly tts: WarmTarget, private readonly deps: WarmerDeps) {}

  /** Start checking. Returns the function that stops it. The timer never keeps the process alive. */
  start(): () => void {
    const timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 120_000);
    timer.unref();
    void this.tick();
    return () => clearInterval(timer);
  }

  async tick(): Promise<WarmTick> {
    try {
      const st = this.tts.status();
      if (!st.enabled || !st.configured) return "skipped";
      if (st.state === "running") {
        const now = this.deps.now?.() ?? Date.now();
        const unusedSec = st.lastUsedAt ? (now - Date.parse(st.lastUsedAt)) / 1000 : Infinity;
        const free = await this.deps.gpuFreeMb();
        if (free !== undefined && free < (this.deps.squeezeMb ?? 1500) && unusedSec >= (this.deps.unusedSec ?? 90)) {
          this.deps.log?.info({ freeMb: free }, "tts: unloading the idle voice, the GPU is needed");
          await this.tts.stop("the GPU is needed by something else");
          return "yielded";
        }
        if (!this.deps.isAway()) return "skipped"; // at the PC: the normal idle timer decides
        await this.tts.keepLoaded();
        return "kept";
      }
      if (st.state !== "off" || !this.deps.isAway()) return "skipped";
      await this.tts.warm(); // throws (and we stay off) when a guard says no
      this.deps.log?.info({}, "tts: warming the voice, you are away and the GPU is free");
      return "warmed";
    } catch {
      return "skipped"; // a guard said no, or the start failed: nothing to do until the next check
    }
  }
}
