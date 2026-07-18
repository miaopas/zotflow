import {
    StateField,
    StateEffect,
    type Extension,
    type EditorState,
    type Text,
} from "@codemirror/state";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { TFile } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { LocalDataManager } from "ui/reader/local-data-manager";

/* ================================================================ */
/*  Marker Registry                                                 */
/* ================================================================ */

interface MarkerType {
    begPrefix: string;
    endPrefix: string;
    type: string;
}

const MARKER_REGISTRY: MarkerType[] = [
    { begPrefix: "ZF_NOTE_BEG_", endPrefix: "ZF_NOTE_END_", type: "NOTE" },
    { begPrefix: "ZF_ANNO_BEG_", endPrefix: "ZF_ANNO_END_", type: "ANNO" },
    // Persist regions: user-owned local-only blocks. Editable like the
    // others, but NEVER synced back to Zotero (see scheduleSync).
    {
        begPrefix: "ZF_PERSIST_BEG_",
        endPrefix: "ZF_PERSIST_END_",
        type: "PERSIST",
    },
];

/* ================================================================ */
/*  EditableRegion                                                  */
/* ================================================================ */

export interface EditableRegion {
    /** Marker category — e.g. "NOTE", future "ANNO". */
    type: string;
    /** Zotero item key extracted from marker (e.g. the note key). */
    key: string;
    /** Editable content start (first char after BEG marker line). */
    from: number;
    /** Editable content end (last char before END marker line). */
    to: number;
    /** BEG marker line start offset. */
    begFrom: number;
    /** BEG marker line end offset. */
    begTo: number;
    /** END marker line start offset. */
    endFrom: number;
    /** END marker line end offset. */
    endTo: number;
    /** `<!-- ZF_NOTE_META ... -->` start offset (if present inside region). */
    metaFrom?: number;
    /** `<!-- ZF_NOTE_META ... -->` end offset (if present inside region). */
    metaTo?: number;
}

/* ================================================================ */
/*  Parser                                                          */
/* ================================================================ */

/** Build a single regex that matches all registered BEG/END markers. */
function buildMarkerRegex(): RegExp {
    const prefixes: string[] = [];
    for (const m of MARKER_REGISTRY) {
        prefixes.push(m.begPrefix, m.endPrefix);
    }
    // Escape regex-special chars in prefixes (defensive)
    const escaped = prefixes.map((p) =>
        p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    // Match: <!-- <PREFIX><KEY> -->
    // \w plus "-": persist region ids allow hyphens (Zotero keys are \w-only).
    return new RegExp(`<!-- (${escaped.join("|")})([\\w-]+) -->`, "g");
}

const MARKER_REGEX = buildMarkerRegex();

interface ParsedMarker {
    type: string;
    role: "beg" | "end";
    key: string;
    lineFrom: number;
    lineTo: number;
}

/** Single-pass parse of all editable regions in the document. */
export function parseEditableRegions(doc: Text): EditableRegion[] {
    const text = doc.toString();
    MARKER_REGEX.lastIndex = 0;

    const markers: ParsedMarker[] = [];

    let match;
    while ((match = MARKER_REGEX.exec(text))) {
        const prefix = match[1]!;
        const key = match[2]!;

        // Find which registry entry this prefix belongs to
        let markerType: MarkerType | undefined;
        let role: "beg" | "end" | undefined;
        for (const m of MARKER_REGISTRY) {
            if (prefix === m.begPrefix) {
                markerType = m;
                role = "beg";
                break;
            }
            if (prefix === m.endPrefix) {
                markerType = m;
                role = "end";
                break;
            }
        }
        if (!markerType || !role) continue;

        const line = doc.lineAt(match.index);
        markers.push({
            type: markerType.type,
            role,
            key,
            lineFrom: line.from,
            lineTo: line.to,
        });
    }

    // Pair BEG with the nearest following END of the same type+key
    const regions: EditableRegion[] = [];
    const used = new Set<number>();

    for (let i = 0; i < markers.length; i++) {
        const beg = markers[i]!;
        if (beg.role !== "beg" || used.has(i)) continue;

        for (let j = i + 1; j < markers.length; j++) {
            const end = markers[j]!;
            if (used.has(j)) continue;
            if (
                end.role !== "end" ||
                end.type !== beg.type ||
                end.key !== beg.key
            )
                continue;

            // Editable content starts after the BEG line's newline
            const editFrom = beg.lineTo + 1;
            // Editable content ends at the char before the END line
            const editTo = end.lineFrom > 0 ? end.lineFrom - 1 : end.lineFrom;

            // Only create region if there's a valid range
            if (editFrom <= editTo) {
                regions.push({
                    type: beg.type,
                    key: beg.key,
                    from: editFrom,
                    to: editTo,
                    begFrom: beg.lineFrom,
                    begTo: beg.lineTo,
                    endFrom: end.lineFrom,
                    endTo: end.lineTo,
                });
            }

            used.add(i);
            used.add(j);
            break;
        }
    }

    // Detect <!-- ZF_NOTE_META ... --> inside NOTE regions only.
    // Uses the global flag + lastIndex to scan within each region's bounds
    // on the already-allocated `text` string — avoids a .slice() per region.
    const META_REGEX_G = /<!-- ZF_NOTE_META [\s\S]*?-->/g;
    for (const region of regions) {
        if (region.type !== "NOTE") continue;

        META_REGEX_G.lastIndex = region.from;
        const metaMatch = META_REGEX_G.exec(text);
        if (metaMatch && metaMatch.index < region.to) {
            region.metaFrom = metaMatch.index;
            region.metaTo = metaMatch.index + metaMatch[0]!.length;

            // Move editable start past the meta line
            const metaLine = doc.lineAt(region.metaTo);
            const newFrom = metaLine.to + 1;
            if (newFrom <= region.to) {
                region.from = newFrom;
            }
        }
    }

    return regions;
}

/* ================================================================ */
/*  StateField                                                      */
/* ================================================================ */

export const editableRegionsField = StateField.define<EditableRegion[]>({
    create(state) {
        return parseEditableRegions(state.doc);
    },

    update(regions, tr) {
        if (!tr.docChanged) return regions;

        // Programmatic set (vault.modify) may add/remove regions → full reparse
        if (tr.isUserEvent("set")) return parseEditableRegions(tr.newDoc);

        // Fast path: shift all positions via mapPos
        const mapped: EditableRegion[] = [];
        let needsReparse = false;

        for (const r of regions) {
            try {
                const newRegion: EditableRegion = {
                    type: r.type,
                    key: r.key,
                    from: tr.changes.mapPos(r.from, -1),
                    to: tr.changes.mapPos(r.to, 1),
                    begFrom: tr.changes.mapPos(r.begFrom, 1),
                    begTo: tr.changes.mapPos(r.begTo, -1),
                    endFrom: tr.changes.mapPos(r.endFrom, 1),
                    endTo: tr.changes.mapPos(r.endTo, -1),
                    metaFrom:
                        r.metaFrom != null
                            ? tr.changes.mapPos(r.metaFrom, 1)
                            : undefined,
                    metaTo:
                        r.metaTo != null
                            ? tr.changes.mapPos(r.metaTo, -1)
                            : undefined,
                };

                // Validate: editable range must remain positive
                if (
                    newRegion.from > newRegion.to ||
                    newRegion.begFrom > newRegion.begTo ||
                    newRegion.endFrom > newRegion.endTo ||
                    (newRegion.metaFrom != null &&
                        newRegion.metaTo != null &&
                        newRegion.metaFrom > newRegion.metaTo)
                ) {
                    needsReparse = true;
                    break;
                }

                mapped.push(newRegion);
            } catch {
                needsReparse = true;
                break;
            }
        }

        if (needsReparse) {
            return parseEditableRegions(tr.newDoc);
        }

        return mapped;
    },
});

/** Read the editable regions from an EditorState. */
export function getEditableRegions(state: EditorState): EditableRegion[] {
    return state.field(editableRegionsField, false) ?? [];
}

/* ================================================================ */
/*  Frontmatter Helper                                              */
/* ================================================================ */

function getLibraryId(doc: Text): number | null {
    if (doc.sliceString(0, 3) !== "---") return null;

    const head = doc.sliceString(0, 10000);
    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(
        head,
    );
    if (!fmMatch) return null;

    const match = /^library-id:\s*(\d+)/m.exec(fmMatch[0]);

    return match?.[1] ? Number(match[1]) : null;
}

/** Extract the local attachment path from `zotflow-local-attachment: "[[path]]"`. */
export function getLocalAttachmentPath(doc: Text): string | null {
    if (doc.sliceString(0, 3) !== "---") return null;

    const head = doc.sliceString(0, 10000);
    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(
        head,
    );
    if (!fmMatch) return null;

    const match =
        /^zotflow-local-attachment:\s*["']?\[\[(.+?)\]\]["']?\s*$/m.exec(
            fmMatch[0],
        );

    return match?.[1] ?? null;
}

/** Where region edits should be saved: a Zotero library or a local sidecar. */
type SyncTarget =
    | { kind: "zotero"; libraryId: number }
    | { kind: "local"; attachmentPath: string };

/* ================================================================ */
/*  ViewPlugin — sync edits to Worker                               */
/* ================================================================ */

const DEBOUNCE_DELAY = 2000;

const editableRegionSyncPlugin = ViewPlugin.fromClass(
    class {
        private debouncers = new Map<string, ReturnType<typeof setTimeout>>();

        update(update: ViewUpdate) {
            if (!update.docChanged) return;

            // Skip programmatic updates (e.g. template re-renders via
            // vault.modify()).  Only user-typed edits should sync to the
            // worker — otherwise we get a circular chain
            const isUserEdit = update.transactions.some(
                (tr) =>
                    tr.docChanged &&
                    !tr.isUserEvent("set") &&
                    (tr.isUserEvent("input") ||
                        tr.isUserEvent("delete") ||
                        tr.isUserEvent("move") ||
                        tr.isUserEvent("undo") ||
                        tr.isUserEvent("redo")),
            );
            if (!isUserEdit) return;

            const regions = update.state.field(editableRegionsField, false);
            if (!regions || regions.length === 0) return;

            const libraryId = getLibraryId(update.state.doc);
            let target: SyncTarget | null = null;
            if (libraryId !== null) {
                target = { kind: "zotero", libraryId };
            } else {
                const attachmentPath = getLocalAttachmentPath(
                    update.state.doc,
                );
                if (attachmentPath !== null) {
                    target = { kind: "local", attachmentPath };
                }
            }
            if (!target) return;

            // Find which regions were touched by the changes
            update.changes.iterChangedRanges((fromA, toA) => {
                for (const region of regions) {
                    // Check if the change range overlaps this region's editable zone
                    if (fromA <= region.to && toA >= region.from) {
                        this.scheduleSync(target, region, update.state);
                    }
                }
            });
        }

        private scheduleSync(
            target: SyncTarget,
            region: EditableRegion,
            state: EditorState,
        ) {
            // PERSIST regions are purely local — never sync them anywhere.
            if (region.type === "PERSIST") return;
            // Local notes only carry ANNO regions.
            if (target.kind === "local" && region.type !== "ANNO") return;

            const debounceKey =
                target.kind === "zotero"
                    ? `${target.libraryId}-${region.key}`
                    : `${target.attachmentPath}-${region.key}`;

            // Clear previous timer for this region
            const existing = this.debouncers.get(debounceKey);
            if (existing !== undefined) {
                clearTimeout(existing);
            }

            const timer = setTimeout(() => {
                this.debouncers.delete(debounceKey);

                if (region.type === "NOTE") {
                    if (target.kind !== "zotero") return;
                    // NOTE regions: include meta comment for wrapper-div
                    // attributes reconstruction, then convert MD → HTML.
                    const syncFrom = region.metaFrom ?? region.from;
                    const noteContent = state.doc.sliceString(
                        syncFrom,
                        region.to,
                    );
                    workerBridge.itemNote
                        .updateNoteContent(
                            target.libraryId,
                            region.key,
                            noteContent,
                            "editor",
                        )
                        .catch(() => {
                            // Background sync — errors logged by worker
                        });
                } else if (region.type === "ANNO") {
                    // ANNO regions live inside blockquotes in the template:
                    //   > <!-- ZF_ANNO_BEG_KEY -->
                    //   > comment text here
                    //   > <!-- ZF_ANNO_END_KEY -->
                    // Strip the leading `> ` prefix from each line first.
                    const content = state.doc.sliceString(
                        region.from,
                        region.to,
                    );
                    const stripped = content.replace(/^>[ \t]?/gm, "");

                    if (target.kind === "zotero") {
                        // MD → restricted HTML happens worker-side.
                        workerBridge.annotation
                            .updateAnnotationComment(
                                target.libraryId,
                                region.key,
                                stripped,
                            )
                            .catch(() => {
                                // Background sync — errors logged by worker
                            });
                    } else {
                        // Local attachment: comments live in the .zf.json
                        // sidecar as plain markdown — update it directly on
                        // the main thread, without re-rendering the note
                        // (the note already contains the new text).
                        // Undo the template's blockquote-safety escaping
                        // (sanitizeQuotesString: `>` → `\>`) so repeated
                        // round-trips don't accumulate backslashes.
                        const unescaped = stripped.replace(/\\>/g, ">");

                        const file = services.app.vault.getAbstractFileByPath(
                            target.attachmentPath,
                        );
                        if (!(file instanceof TFile)) return;

                        new LocalDataManager(file)
                            .updateAnnotationCommentFromNote(
                                region.key,
                                unescaped,
                            )
                            .then((changed) => {
                                if (changed) {
                                    // Let an open local reader refresh its cache.
                                    services.taskMonitor.localAnnotationChanged.emit(
                                        target.attachmentPath,
                                        region.key,
                                    );
                                }
                            })
                            .catch((e) => {
                                services.logService.error(
                                    "Failed to save local annotation comment from note",
                                    "ZotFlowEditableRegion",
                                    e,
                                );
                            });
                    }
                }
            }, DEBOUNCE_DELAY);

            this.debouncers.set(debounceKey, timer);
        }

        destroy() {
            for (const timer of this.debouncers.values()) {
                clearTimeout(timer);
            }
            this.debouncers.clear();
        }
    },
);

/* ================================================================ */
/*  Region Unlock Toggle                                            */
/* ================================================================ */

/** Dispatched to toggle a region's lock state by key. */
export const toggleRegionLockEffect = StateEffect.define<string>();

/** Tracks which region keys are currently unlocked by the user. */
export const unlockedRegionsField = StateField.define<Set<string>>({
    create() {
        return new Set();
    },

    update(unlocked, tr) {
        let next = unlocked;
        for (const effect of tr.effects) {
            if (effect.is(toggleRegionLockEffect)) {
                next = new Set(next);
                if (next.has(effect.value)) {
                    next.delete(effect.value);
                } else {
                    next.add(effect.value);
                }
            }
        }
        return next;
    },
});

/* ================================================================ */
/*  Extension Factory                                               */
/* ================================================================ */

/** CM6 extension for editable regions: StateField tracking + unlock toggle + ViewPlugin sync. */
export function ZotFlowEditableRegionExtension(): Extension {
    return [
        editableRegionsField,
        unlockedRegionsField,
        editableRegionSyncPlugin,
    ];
}
