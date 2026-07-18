import { db } from "db/db";
import type { NoteLinkResolver } from "worker/convert/note-links";

/**
 * DB-backed resolver for note link conversion (see note-links.ts).
 *
 * Lookups are memoized per resolver instance: a note full of links to
 * the same library would otherwise fire one IndexedDB query per link.
 * Callers create a fresh resolver per conversion, so the cache lifetime
 * is a single note render/save — no invalidation needed.
 */
export function createDbNoteLinkResolver(): NoteLinkResolver {
    const parentKeys = new Map<string, Promise<string | null>>();
    const groupFlags = new Map<number, Promise<boolean | null>>();
    let personalLibraryID: Promise<number | null> | undefined;

    return {
        getAnnotationParentKey(libraryID, annotationKey) {
            const cacheKey = `${libraryID}:${annotationKey}`;
            let cached = parentKeys.get(cacheKey);
            if (!cached) {
                cached = db.items
                    .get([libraryID, annotationKey])
                    .then((item) =>
                        item && item.itemType === "annotation"
                            ? item.parentItem || null
                            : null,
                    );
                parentKeys.set(cacheKey, cached);
            }
            return cached;
        },

        isGroupLibrary(libraryID) {
            let cached = groupFlags.get(libraryID);
            if (!cached) {
                cached = db.libraries
                    .get(libraryID)
                    .then((library) =>
                        library ? library.type === "group" : null,
                    );
                groupFlags.set(libraryID, cached);
            }
            return cached;
        },

        getPersonalLibraryID() {
            if (!personalLibraryID) {
                personalLibraryID = db.libraries
                    .toArray()
                    .then(
                        (libraries) =>
                            libraries.find((l) => l.type === "user")?.id ??
                            null,
                    );
            }
            return personalLibraryID;
        },
    };
}
