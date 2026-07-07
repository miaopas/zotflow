import { workerBridge } from "bridge";
import { Zotero_Item_Types } from "types/zotero-item-const";
import { services } from "services/services";

import type { SearchFilterField } from "utils/search-query";

/**
 * Main-thread provider of value suggestions for search operators
 * (`collection:`, `tag:`, `type:`). Lists are fetched from the worker on
 * demand and cached for the session; call {@link invalidateAutocompleteCache}
 * after a sync so new collections/tags appear.
 */

let tagCache: string[] | null = null;
let collectionCache: string[] | null = null;
let libraryCache: string[] | null = null;

/** Item types offered for `type:` completion (annotations is internal). */
const TYPE_VALUES = Zotero_Item_Types.filter((t) => t !== "annotation");

/** Clear cached tag / collection / library lists (e.g. after a sync). */
export function invalidateAutocompleteCache(): void {
    tagCache = null;
    collectionCache = null;
    libraryCache = null;
}

/**
 * Return up to `limit` value suggestions for the given operator field that
 * contain `partial` (case-insensitive). Returns `[]` for fields without value
 * completion (e.g. `creator`).
 */
export async function getValueSuggestions(
    field: SearchFilterField,
    partial: string,
    limit = 200,
): Promise<string[]> {
    let source: string[];
    try {
        switch (field) {
            case "library":
                libraryCache ??= await workerBridge.dbHelper.getLibraryNames();
                source = libraryCache;
                break;
            case "tag":
                tagCache ??= await workerBridge.tag.getTagNames();
                source = tagCache;
                break;
            case "collection":
                collectionCache ??=
                    await workerBridge.dbHelper.getCollectionNames();
                source = collectionCache;
                break;
            case "type":
                source = TYPE_VALUES;
                break;
            default:
                return [];
        }
    } catch (err) {
        services.logService.error(
            "Failed to load value suggestions",
            "SearchAutocomplete",
            err,
        );
        return [];
    }

    const p = partial.toLowerCase();
    const matches = p
        ? source.filter((v) => v.toLowerCase().includes(p))
        : source;
    return matches.slice(0, limit);
}
