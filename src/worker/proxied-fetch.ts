/**
 * The ParentHost-proxied fetch installed by worker.ts at startup (it
 * routes through Obsidian's requestUrl on the main thread, bypassing
 * CORS and working on mobile).
 *
 * Worker code should import this instead of touching the global —
 * plain `fetch` and `globalThis` are lint-restricted, and an explicit
 * import makes the proxying visible at the call site.
 */
export type ProxiedFetch = (
    url: string,
    init?: RequestInit,
) => Promise<Response>;

let current: ProxiedFetch | null = null;

/** Called once by worker.ts when the proxy is installed. */
export function setProxiedFetch(fn: ProxiedFetch): void {
    current = fn;
}

export function proxiedFetch(
    url: string,
    init?: RequestInit,
): Promise<Response> {
    if (!current) {
        return Promise.reject(
            new Error("Proxied fetch is not initialized yet"),
        );
    }
    return current(url, init);
}
