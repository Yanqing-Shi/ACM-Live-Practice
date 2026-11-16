export type RateLimiter = {
  /** Record one attempt for `key`. Returns false when the key is over its limit. */
  take: (key: string) => boolean;
  dispose: () => void;
};

/** Fixed-window counter per key, held in memory. */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now || Date.now;
  const windows = new Map<string, { startedAt: number; count: number }>();

  const sweeper = setInterval(() => {
    const cutoff = now() - options.windowMs;

    for (const [key, window] of windows) {
      if (window.startedAt <= cutoff) {
        windows.delete(key);
      }
    }
  }, Math.max(1000, options.windowMs));

  sweeper.unref();

  return {
    take(key: string): boolean {
      const current = now();
      const window = windows.get(key);

      if (!window || current - window.startedAt >= options.windowMs) {
        windows.set(key, { startedAt: current, count: 1 });
        return true;
      }

      window.count += 1;
      return window.count <= options.max;
    },
    dispose(): void {
      clearInterval(sweeper);
      windows.clear();
    },
  };
}

/**
 * Client address for rate limiting. Behind a reverse proxy the socket address
 * is the proxy, so when `trustProxy` is on the last X-Forwarded-For entry (the
 * one the proxy appended) is used.
 */
export function clientAddress(
  request: {
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
  },
  trustProxy: boolean
): string {
  if (trustProxy) {
    const header = request.headers["x-forwarded-for"];
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    const last = value?.split(",").pop()?.trim();

    if (last) {
      return last;
    }
  }

  return request.socket.remoteAddress || "unknown";
}
