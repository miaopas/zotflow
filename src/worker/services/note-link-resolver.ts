import { db } from "db/db";
import type { NoteLinkResolver } from "worker/convert/note-links";

/** DB-backed resolver for note link conversion (see note-links.ts). */
export function createDbNoteLinkResolver(): NoteLinkResolver {
    return {
        async getAnnotationParentKey(libraryID, annotationKey) {
            const item = await db.items.get([libraryID, annotationKey]);
            if (!item || item.itemType !== "annotation") return null;
            return item.parentItem || null;
        },

        async isGroupLibrary(libraryID) {
            const library = await db.libraries.get(libraryID);
            if (!library) return null;
            return library.type === "group";
        },

        async getPersonalLibraryID() {
            const libraries = await db.libraries.toArray();
            return libraries.find((l) => l.type === "user")?.id ?? null;
        },
    };
}
