/** Phased boot helpers + URL query flags (?lite=1, ?debugLoad=1, …). */

export function bootQueryFlag(name) {
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

/**
 * Run an async boot phase with optional timeout.
 * @returns {{ ok: boolean, value?: any, error?: any, ms: number }}
 */
export async function runPhase(name, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const onProgress = opts.onProgress;
  const t0 = performance.now();
  onProgress?.(name, "start", 0, null);
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => fn()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const ms = Math.round(performance.now() - t0);
    onProgress?.(name, "ok", ms, null);
    return { ok: true, value, ms };
  } catch (error) {
    const ms = Math.round(performance.now() - t0);
    onProgress?.(name, "fail", ms, error);
    return { ok: false, error, ms };
  }
}
