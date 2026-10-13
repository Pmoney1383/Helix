/**
 * Phones connected right now over the WebSocket, by platform. An Android phone has no Apple push: while its app keeps the
 * live connection open (a foreground service), notifications and incoming calls reach it as events on that connection.
 */
export class LiveDevices {
  private readonly open = new Map<string, { platform: string; sockets: number }>();

  /** Records one open socket for a device. Returns the function to call when that socket closes. */
  connect(deviceId: string, platform: string | undefined): () => void {
    const entry = this.open.get(deviceId) ?? { platform: platform ?? "unknown", sockets: 0 };
    entry.sockets++;
    this.open.set(deviceId, entry);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const current = this.open.get(deviceId);
      if (!current) return;
      if (--current.sockets <= 0) this.open.delete(deviceId);
    };
  }

  /** How many devices of this platform have at least one socket open. */
  count(platform: string): number {
    let n = 0;
    for (const entry of this.open.values()) if (entry.platform === platform) n++;
    return n;
  }
}
