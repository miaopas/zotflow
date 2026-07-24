/**
 * Persist regions — local-only, template-declared blocks in source notes
 * that survive every note update.
 *
 *   <!-- ZF_PERSIST_BEG_<id> -->
 *   ...user content...
 *   <!-- ZF_PERSIST_END_<id> -->
 *
 * Update flow: `extractPersistRegions(oldContent)` before rendering, then
 * `reinsertPersistRegions(newContent, extracted)` before writing. Regions
 * whose id still exists in the new render get their content spliced back
 * in place. Regions whose id vanished (orphans) are demoted to bare
 * labelled text inside a single sentinel-bounded section at EOF:
 *
 *   <!-- ZF_PERSIST_ORPHAN_BEG -->
 *   ## Orphaned persist regions
 *
 *   **`some-id`**
 *   ...content...
 *   <!-- ZF_PERSIST_ORPHAN_END -->
 *
 * The orphan section is an opaque black box: captured verbatim, excluded
 * from marker parsing, re-emitted verbatim with new orphans appended.
 *
 * Parsing is strict: malformed markers, duplicate ids, unmatched or
 * nested pairs all throw (PARSE_ERROR with a line number) rather than
 * risk silently losing user content.
 */

import { ZotFlowError, ZotFlowErrorCode } from "./error";

export const PERSIST_BEG_PREFIX = "ZF_PERSIST_BEG_";
export const PERSIST_END_PREFIX = "ZF_PERSIST_END_";
export const ORPHAN_BEG_MARKER = "<!-- ZF_PERSIST_ORPHAN_BEG -->";
export const ORPHAN_END_MARKER = "<!-- ZF_PERSIST_ORPHAN_END -->";
export const ORPHAN_HEADING = "## Orphaned persist regions";

export interface PersistRegion {
    id: string;
    /** Verbatim text between the BEG and END marker lines (no trailing newline). */
    content: string;
}

export interface PersistExtract {
    regions: PersistRegion[];
    /**
     * Verbatim inner text of the orphan section (between the sentinel
     * lines, including the heading emitted on first creation), or null
     * when the file has no orphan section.
     */
    orphanSectionInner: string | null;
}

export interface PersistReinsert {
    content: string;
    /** Regions that became orphans during THIS splice (drives warn/Notice). */
    newOrphans: PersistRegion[];
}

/* ================================================================ */
/*  Line scanning                                                   */
/* ================================================================ */

/** Lines that mention the persist token at all — sparse candidate scan. */
const CANDIDATE_LINE = /^.*ZF_PERSIST.*$/gm;

const STRICT_BEG = /^<!-- ZF_PERSIST_BEG_([A-Za-z0-9_-]{1,64}) -->$/;
const STRICT_END = /^<!-- ZF_PERSIST_END_([A-Za-z0-9_-]{1,64}) -->$/;

type Hit =
    | { kind: "beg" | "end"; id: string; lineFrom: number; lineTo: number }
    | { kind: "orphan-beg" | "orphan-end"; lineFrom: number; lineTo: number }
    /** Mentions ZF_PERSIST with comment syntax but is not a valid marker. */
    | { kind: "malformed"; lineFrom: number; lineTo: number };

function lineNumberAt(text: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset; i++) {
        if (text.charCodeAt(i) === 10) line++;
    }
    return line;
}

function parseError(text: string, offset: number, message: string): never {
    const line = lineNumberAt(text, offset);
    throw new ZotFlowError(
        ZotFlowErrorCode.PARSE_ERROR,
        "PersistRegions",
        `${message} (line ${line})`,
        { line },
    );
}

/** End offset of the YAML frontmatter block, or 0 when absent. */
function frontmatterEnd(text: string): number {
    if (!text.startsWith("---")) return 0;
    const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    return m ? m[0].length : 0;
}

/**
 * Scan for candidate lines and classify them. Does not throw — spans and
 * frontmatter must be resolved before malformed hits can be judged.
 */
function scanHits(text: string): Hit[] {
    const hits: Hit[] = [];
    CANDIDATE_LINE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CANDIDATE_LINE.exec(text))) {
        const lineFrom = m.index;
        // `.` and multiline `$` treat \r as a line terminator, so a CRLF
        // line's match excludes the \r — step over it to reach the true
        // line end.
        let lineTo = m.index + m[0].length;
        if (text.charCodeAt(lineTo) === 13) lineTo++;
        const line = m[0].replace(/^\s+|\s+$/g, "");

        if (line === ORPHAN_BEG_MARKER) {
            hits.push({ kind: "orphan-beg", lineFrom, lineTo });
        } else if (line === ORPHAN_END_MARKER) {
            hits.push({ kind: "orphan-end", lineFrom, lineTo });
        } else {
            const beg = STRICT_BEG.exec(line);
            const end = beg ? null : STRICT_END.exec(line);
            if (beg) {
                hits.push({ kind: "beg", id: beg[1]!, lineFrom, lineTo });
            } else if (end) {
                hits.push({ kind: "end", id: end[1]!, lineFrom, lineTo });
            } else if (/<!--|-->/.test(line)) {
                // A comment-like marker attempt that failed strict parse
                // (missing id, bad chars, extra text on the line, ...).
                // Prose mentions without comment syntax are ignored.
                hits.push({ kind: "malformed", lineFrom, lineTo });
            }
        }
        // Zero-length safety for /m regex on empty trailing line
        if (m[0].length === 0) CANDIDATE_LINE.lastIndex++;
    }
    return hits;
}

/**
 * Locate the orphan section span: first ORPHAN_BEG and the first
 * ORPHAN_END after it. Unpaired or misordered sentinels degrade to
 * "no span" — the stray lines are plain text and vanish on rewrite.
 */
function findOrphanSpan(
    hits: Hit[],
): { begFrom: number; begTo: number; endFrom: number; endTo: number } | null {
    const beg = hits.find((h) => h.kind === "orphan-beg");
    if (!beg) return null;
    const end = hits.find(
        (h) => h.kind === "orphan-end" && h.lineFrom > beg.lineTo,
    );
    if (!end) return null;
    return {
        begFrom: beg.lineFrom,
        begTo: beg.lineTo,
        endFrom: end.lineFrom,
        endTo: end.lineTo,
    };
}

interface ParsedRegion extends PersistRegion {
    /** Offset of the first content char (just after the BEG line's newline). */
    contentFrom: number;
    /** Offset of the END marker line start. */
    endLineFrom: number;
}

/**
 * Pair BEG/END hits into regions. Throws on malformed lines, duplicate
 * ids, unmatched or interleaved markers. `skip` filters hits that fall
 * inside the orphan span or frontmatter.
 */
function pairRegions(
    text: string,
    hits: Hit[],
    skip: (h: Hit) => boolean,
): ParsedRegion[] {
    const regions: ParsedRegion[] = [];
    const seen = new Set<string>();
    let open: { id: string; lineTo: number; lineFrom: number } | null = null;

    for (const h of hits) {
        if (skip(h)) continue;

        if (h.kind === "malformed") {
            parseError(
                text,
                h.lineFrom,
                "Malformed ZF_PERSIST marker — expected `<!-- ZF_PERSIST_BEG_<id> -->` / `<!-- ZF_PERSIST_END_<id> -->` on its own line, id = [A-Za-z0-9_-]",
            );
        }
        if (h.kind === "orphan-beg" || h.kind === "orphan-end") {
            // Stray sentinel outside the recognized span: plain text,
            // discarded on rewrite (self-healing).
            continue;
        }

        if (h.kind === "beg") {
            if (open) {
                parseError(
                    text,
                    h.lineFrom,
                    `Nested persist region "${h.id}" inside "${open.id}" — regions cannot nest`,
                );
            }
            if (seen.has(h.id)) {
                parseError(
                    text,
                    h.lineFrom,
                    `Duplicate persist region id "${h.id}"`,
                );
            }
            open = { id: h.id, lineTo: h.lineTo, lineFrom: h.lineFrom };
        } else if (h.kind === "end") {
            if (!open) {
                parseError(
                    text,
                    h.lineFrom,
                    `Unmatched ZF_PERSIST_END_${h.id} — no open region`,
                );
            }
            if (open.id !== h.id) {
                parseError(
                    text,
                    h.lineFrom,
                    `Mismatched persist markers: region "${open.id}" closed by END "${h.id}"`,
                );
            }
            const contentFrom = Math.min(open.lineTo + 1, h.lineFrom);
            const raw = text.slice(contentFrom, h.lineFrom);
            regions.push({
                id: open.id,
                content: raw.replace(/\r?\n$/, ""),
                contentFrom,
                endLineFrom: h.lineFrom,
            });
            seen.add(open.id);
            open = null;
        }
    }

    if (open) {
        parseError(
            text,
            open.lineFrom,
            `Unclosed persist region "${open.id}" — missing ZF_PERSIST_END_${open.id}`,
        );
    }
    return regions;
}

/* ================================================================ */
/*  Public API                                                      */
/* ================================================================ */

/**
 * Parse persist regions out of an existing note. Strict — throws
 * ZotFlowError(PARSE_ERROR) on any marker irregularity so a damaged
 * note refuses to update instead of losing content.
 */
export function extractPersistRegions(content: string): PersistExtract {
    if (content.indexOf("ZF_PERSIST") === -1) {
        return { regions: [], orphanSectionInner: null };
    }

    const fmEnd = frontmatterEnd(content);
    const hits = scanHits(content);
    const span = findOrphanSpan(hits);

    const regions = pairRegions(content, hits, (h) => {
        if (h.lineFrom < fmEnd) return true;
        if (span && h.lineFrom >= span.begFrom && h.lineTo <= span.endTo)
            return true;
        return false;
    });

    let orphanSectionInner: string | null = null;
    if (span) {
        orphanSectionInner = content
            .slice(span.begTo, span.endFrom)
            .replace(/^\r?\n/, "")
            .replace(/\r?\n$/, "");
    }

    return {
        regions: regions.map(({ id, content: c }) => ({ id, content: c })),
        orphanSectionInner,
    };
}

/** True when the orphan section holds nothing beyond heading/label shells. */
function orphanInnerIsEmpty(inner: string): boolean {
    for (const line of inner.split(/\r?\n/)) {
        const t = line.trim();
        if (t === "" || t === ORPHAN_HEADING) continue;
        if (/^\*\*`[^`]+`\*\*$/.test(t)) continue;
        return false;
    }
    return true;
}

/**
 * Splice previously extracted regions into freshly rendered content.
 *
 * - id present in the render → old content replaces the rendered default;
 * - id gone (orphan): empty content is dropped (that IS the user's delete
 *   gesture), non-empty content is appended — marker-free, under a bold
 *   id label — into the single sentinel-bounded orphan section at EOF,
 *   after the previous section's verbatim inner.
 *
 * Also validates the render itself: marker irregularities or orphan
 * sentinels emitted by a template throw (template error, note not written).
 */
export function reinsertPersistRegions(
    newContent: string,
    extracted: PersistExtract,
): PersistReinsert {
    const { regions: oldRegions, orphanSectionInner } = extracted;
    const eol = newContent.includes("\r\n") ? "\r\n" : "\n";

    // ── Validate the render and index its regions ──
    let rendered: ParsedRegion[] = [];
    if (newContent.indexOf("ZF_PERSIST") !== -1) {
        const fmEnd = frontmatterEnd(newContent);
        const hits = scanHits(newContent);
        for (const h of hits) {
            if (h.lineFrom < fmEnd) continue;
            if (h.kind === "orphan-beg" || h.kind === "orphan-end") {
                parseError(
                    newContent,
                    h.lineFrom,
                    "Template must not emit ZF_PERSIST_ORPHAN markers — the orphan section is generated by ZotFlow",
                );
            }
        }
        rendered = pairRegions(newContent, hits, (h) => h.lineFrom < fmEnd);
    }

    const oldById = new Map(oldRegions.map((r) => [r.id, r]));
    const renderedIds = new Set(rendered.map((r) => r.id));

    // ── Splice matched regions (slice array + single join, O(n)) ──
    const parts: string[] = [];
    let cursor = 0;
    for (const r of rendered) {
        const old = oldById.get(r.id);
        if (!old) continue; // fresh region keeps its rendered default
        parts.push(newContent.slice(cursor, r.contentFrom));
        parts.push(old.content + eol);
        cursor = r.endLineFrom;
    }
    parts.push(newContent.slice(cursor));

    // ── Collect orphans ──
    const newOrphans: PersistRegion[] = [];
    for (const r of oldRegions) {
        if (renderedIds.has(r.id)) continue;
        if (r.content.trim() === "") continue; // empty orphan → dropped
        newOrphans.push({ id: r.id, content: r.content });
    }

    // ── Rebuild the orphan section at EOF ──
    let inner = orphanSectionInner ?? "";
    if (newOrphans.length > 0) {
        if (inner === "") inner = ORPHAN_HEADING + eol;
        for (const o of newOrphans) {
            inner += eol + "**`" + o.id + "`**" + eol + o.content + eol;
        }
    }

    let content = parts.join("");
    if (inner !== "" && !orphanInnerIsEmpty(inner)) {
        if (!/(\r?\n)$/.test(content)) content += eol;
        content +=
            ORPHAN_BEG_MARKER +
            eol +
            inner.replace(/\r?\n$/, "") +
            eol +
            ORPHAN_END_MARKER +
            eol;
    }

    return { content, newOrphans };
}
