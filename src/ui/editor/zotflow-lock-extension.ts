import type { Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import {
    editableRegionsField,
    unlockedRegionsField,
} from "./zotflow-editable-region-extension";
import { services } from "services/services";

interface FrontmatterInfo {
    locked: boolean;
    fmEnd: number;
    hasLibraryId: boolean;
    libraryId: number | undefined;
    /** True for local attachment source notes (zotflow-local-attachment). */
    isLocal: boolean;
}

/** Parse frontmatter once, extracting lock state, end offset, and library-id. */
function parseFrontmatter(state: EditorState): FrontmatterInfo {
    if (state.doc.sliceString(0, 3) !== "---") {
        return {
            locked: false,
            fmEnd: -1,
            hasLibraryId: false,
            libraryId: undefined,
            isLocal: false,
        };
    }

    const head = state.doc.sliceString(0, 10000);

    const locked = /^---\s*[\s\S]*?zotflow-locked:\s*true/m.test(head);

    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(
        head,
    );
    const fmEnd = fmMatch ? fmMatch[0].length : -1;

    const fm = fmMatch ? fmMatch[0] : "";
    const libIdMatch = /^library-id:\s*(\d+)/m.exec(fm);
    const libraryId = libIdMatch ? Number(libIdMatch[1]) : undefined;
    const isLocal = /^zotflow-local-attachment:/m.test(fm);

    return {
        locked,
        fmEnd,
        hasLibraryId: libraryId !== undefined,
        libraryId,
        isLocal,
    };
}

/**
 * Returns a CM6 extension that makes the editor read-only when `zotflow-locked: true` is in frontmatter,
 * except for changes within the frontmatter itself and editable regions (when `library-id` is present).
 *
 * @param isDefaultLocked — returns the current `defaultEditableRegionLocked` setting value.
 */
export function ZotFlowLockExtension(
    isDefaultLocked: () => boolean,
): Extension {
    return [
        EditorState.changeFilter.of((tr) => {
            if (!tr.docChanged) return true;
            if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return true;

            // Allow programmatic document updates (e.g. vault.modify() re-rendering
            // the source note).  Obsidian dispatches these with userEvent "set".
            if (tr.isUserEvent("set")) return true;

            const fm = parseFrontmatter(tr.startState);
            if (!fm.locked) return true;
            if (fm.fmEnd === -1) return true;

            const fmEnd = fm.fmEnd;

            // If the library-id resolves to a library where note edits are
            // disallowed (read-only sync mode, or API key lacks notes/write
            // permission), only frontmatter and local-only PERSIST regions
            // stay editable — PERSIST content never syncs to Zotero, so
            // library write permissions don't apply to it.
            const readOnlyLibrary =
                fm.libraryId !== undefined &&
                !services.libraryCache.canEditNotes(fm.libraryId);

            // Editable regions are active for Zotero source notes
            // (library-id) and local attachment source notes.
            const regionsEnabled = fm.hasLibraryId || fm.isLocal;
            let regions = regionsEnabled
                ? (tr.startState.field(editableRegionsField, false) ?? [])
                : [];
            if (readOnlyLibrary) {
                regions = regions.filter((r) => r.type === "PERSIST");
            }
            const unlocked =
                tr.startState.field(unlockedRegionsField, false) ??
                new Set<string>();

            // When defaultEditableRegionLocked is false, regions start
            // unlocked and the toggle set tracks explicitly *locked* keys.
            // When true (default), the toggle set tracks explicitly *unlocked* keys.
            const defaultLocked = isDefaultLocked();

            let allow = true;

            tr.changes.iterChanges((fromChange, toChange) => {
                if (!allow) return;

                // Allow changes within frontmatter
                if (toChange <= fmEnd) return;

                // Check if change falls within an editable region that is unlocked
                if (regions.length > 0) {
                    const inUnlockedRegion = regions.some((r) => {
                        // Determine if this region is currently unlocked
                        const isUnlocked = defaultLocked
                            ? unlocked.has(r.key) // default locked → toggle unlocks
                            : !unlocked.has(r.key); // default unlocked → toggle locks

                        return (
                            isUnlocked &&
                            fromChange >= r.from &&
                            toChange <= r.to &&
                            // Protect the BEG/END marker text itself. Strict
                            // overlap: a point insertion at a marker boundary
                            // sits in the content (inline/zero-width regions
                            // start right at the marker edge), while any edit
                            // that consumes marker characters is rejected.
                            !(fromChange < r.begTo && toChange > r.begFrom) &&
                            !(fromChange < r.endTo && toChange > r.endFrom)
                        );
                    });

                    if (inUnlockedRegion) return;
                }

                allow = false;
            });

            return allow;
        }),
    ];
}
