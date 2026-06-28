/**
 * Helpers for building native Zotero (`zotero://`) URIs.
 *
 * The "library path prefix" segment differs between the personal user library
 * ("library") and group libraries ("groups/<id>"). Build it once with
 * `zoteroLibraryPrefix`, then pass it to the URI builders.
 */

/** Build the Zotero URI library path prefix. */
export function zoteroLibraryPrefix(
    isGroup: boolean,
    libraryID: number,
): string {
    return isGroup ? `groups/${libraryID}` : "library";
}

/** `zotero://select/<prefix>/items/<key>` — selects/opens an item in Zotero. */
export function zoteroSelectItemUri(prefix: string, itemKey: string): string {
    return `zotero://select/${prefix}/items/${itemKey}`;
}

/**
 * `zotero://open-pdf/<prefix>/items/<attachmentKey>` — opens an attachment in
 * Zotero's PDF reader, optionally navigated to a specific annotation.
 */
export function zoteroOpenPdfUri(
    prefix: string,
    attachmentKey: string,
    annotationKey?: string,
): string {
    const base = `zotero://open-pdf/${prefix}/items/${attachmentKey}`;
    return annotationKey ? `${base}?annotation=${annotationKey}` : base;
}
