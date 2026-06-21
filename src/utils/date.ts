/**
 * Best-effort extraction of a 4-digit year from uncertain date strings.
 *
 * Examples handled:
 * - "2024-03-18"
 * - "Spring 1998"
 * - "1999/2000"
 * - "2020-uu"
 */
export function extractYear(value: unknown): string {
    if (typeof value !== "string") return "";

    const raw = value.trim();
    if (!raw) return "";

    // Prefer explicit 4-digit years embedded in free-form date text.
    const match = raw.match(/(?:^|[^\d])((?:1\d{3}|2\d{3}))(?!\d)/);
    if (match?.[1]) return match[1];

    // Fallback for parseable date strings.
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return "";

    return String(parsed.getUTCFullYear());
}
