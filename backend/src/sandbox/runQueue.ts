export class RunQueueFullError extends Error {
  constructor() {
    super("The server is busy running other programs. Try again in a moment.");
    this.name = "RunQueueFullError";
  }
}

export class RunQueueTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for a free runner. Try again in a moment.");
    this.name = "RunQueueTimeoutError";
  }
}

export type RunQueue = {
  /**
   * Wait for a free slot. `onQueued` is called once, with the 1-based queue
   * position, only when the caller actually has to wait. The returned function
   * frees the slot and must be called exactly once.
   */
  acquire: (onQueued?: (position: number) => void) => Promise<() => void>;
  readonly active: number;
  readonly waiting: number;
};

/** Caps how many programs run at once across all rooms, first come first served. */
export function createRunQueue(options: {
  maxConcurrent: number;
  queueMax: number;
  queueTimeoutMs: number;
}): RunQueue {
  let active = 0;
  const waiters: Array<{
    start: (release: () => void) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  function createRelease(): () => void {
    let released = false;

    return () => {
      if (released) return;

      released = true;

      const next = waiters.shift();

      if (next) {
        // The slot passes straight to the next waiter; `active` is unchanged.
        clearTimeout(next.timer);
        next.start(createRelease());
        return;
      }

      active -= 1;
    };
  }

  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
    acquire(onQueued) {
      if (active < options.maxConcurrent) {
        active += 1;
        return Promise.resolve(createRelease());
      }

      if (waiters.length >= options.queueMax) {
        return Promise.reject(new RunQueueFullError());
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          start: resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);

            if (index >= 0) {
              waiters.splice(index, 1);
              reject(new RunQueueTimeoutError());
            }
          }, options.queueTimeoutMs),
        };

        waiters.push(waiter);
        onQueued?.(waiters.length);
      });
    },
  };
}
