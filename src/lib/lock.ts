import { mkdirSync, rmSync, statSync } from "node:fs";

// One writer at a time for the state file: the 15-minute tick and the agent's
// job tools both read, change and save it. A directory is created atomically,
// so it works as a lock without extra dependencies. A lock older than
// `staleMs` is from a crashed run and is taken over.

export async function withLock<T>(path: string, fn: () => Promise<T>, waitMs = 120_000, staleMs = 15 * 60_000): Promise<T> {
  const dir = `${path}.lock`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(dir).mtimeMs > staleMs) rmSync(dir, { recursive: true, force: true });
      } catch {
        // gone between the check and the remove: try again
      }
      if (Date.now() > until) throw new Error("the state file is busy (another run holds the lock); try again in a minute");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
