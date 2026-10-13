// Pre-generated audio for Helix's canned lines (greetings, fillers, digest lines, openers), made once with the PC voice
// (docs/LOCAL-TTS.md, `npm run voice -- clips`). They need no GPU and no running voice service, so a filler can play the instant the
// user stops talking. The library is a folder of wav files plus a manifest.json describing them.
import fs from "node:fs";
import path from "node:path";

export interface Clip {
  id: string;
  kind: string;
  text: string;
  /** "flirty" (the gentle voice) or "plain" (the calm one, for serious moments). */
  voice: string;
  seconds: number;
  file: string;
}

/** Ids are plain slugs: nothing a caller sends can ever name a path. */
const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export class ClipLibrary {
  private byId = new Map<string, Clip>();
  private byText = new Map<string, Clip>();

  constructor(private readonly dir?: string) {
    this.load();
  }

  /** Read the manifest again (clips can be regenerated while the gateway runs). */
  load(): void {
    this.byId.clear();
    this.byText.clear();
    if (!this.dir) return;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, "manifest.json"), "utf8")) as Partial<Clip>[];
      for (const c of raw) {
        if (!c.id || !ID.test(c.id) || !c.file || !c.text) continue;
        // The file must sit directly in the clips folder, whatever the manifest says.
        if (path.basename(c.file) !== c.file || !fs.existsSync(path.join(this.dir, c.file))) continue;
        const clip: Clip = { id: c.id, kind: c.kind ?? "", text: c.text, voice: c.voice ?? "", seconds: c.seconds ?? 0, file: c.file };
        this.byId.set(clip.id, clip);
        this.byText.set(norm(clip.text), clip);
      }
    } catch { /* no clips yet: everything falls back to text */ }
  }

  list(): Clip[] {
    return [...this.byId.values()];
  }

  /** The clip that says exactly this text, if one was recorded. */
  findByText(text: string): Clip | undefined {
    return this.byText.get(norm(text));
  }

  get(id: string): Clip | undefined {
    return ID.test(id) ? this.byId.get(id) : undefined;
  }

  /** Absolute path of a clip's wav file, or undefined for anything that is not in the manifest. */
  pathOf(id: string): string | undefined {
    const c = this.get(id);
    return c && this.dir ? path.join(this.dir, c.file) : undefined;
  }
}
