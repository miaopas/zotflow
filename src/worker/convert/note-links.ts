/**
 * Bidirectional link conversion for item-note HTML.
 *
 * Canonical storage (IDB + Zotero) keeps native `zotero://` links so notes
 * opened in Zotero navigate with Zotero's reader; the Obsidian-facing
 * markdown shows `obsidian://zotflow?…` links so the same click opens
 * ZotFlow's reader. Conversion happens at the existing md↔html boundary:
 * outbound (`zotflowToZoteroLinks`) right after md2html before an IDB
 * write, inbound (`zoteroToZotflowLinks`) right before html2md for
 * display.
 *
 * Mapping (page numbers are 1-based in zotero URIs, pageIndex is 0-based):
 *
 *   obsidian://zotflow?type=open-note        ↔ zotero://select/<prefix>/items/<key>
 *   obsidian://zotflow?type=open-annotation  ↔ zotero://open-pdf/<prefix>/items/<attKey>?annotation=<key>
 *   obsidian://zotflow?type=open-attachment  ↔ zotero://open-pdf/<prefix>/items/<key>[?page=N]
 *     (navigation: annotationID → ?annotation; position.pageIndex/pageLabel → ?page)
 *
 * Anything that cannot be converted without losing its target (unknown
 * libraries, annotations without a resolvable parent, unrecognized query
 * params) is left untouched — a native link that still works beats a
 * broken converted one.
 */

import {
    zoteroLibraryPrefix,
    zoteroOpenPdfUri,
    zoteroSelectItemUri,
} from "utils/zotero-uri";

/** Lookups the converter needs; backed by the worker DB in production. */
export interface NoteLinkResolver {
    /** Annotation key → its parent attachment key, or null when unknown. */
    getAnnotationParentKey(
        libraryID: number,
        annotationKey: string,
    ): Promise<string | null>;
    /** Whether the library is a group library, or null when unknown. */
    isGroupLibrary(libraryID: number): Promise<boolean | null>;
    /** The personal ("user") libraryID, or null when unknown. */
    getPersonalLibraryID(): Promise<number | null>;
}

/* ================================================================ */
/*  Helpers                                                         */
/* ================================================================ */

/** Replace every regex match via an async callback. */
async function replaceAsync(
    str: string,
    re: RegExp,
    fn: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(str))) {
        out += str.slice(last, m.index);
        out += await fn(m);
        last = m.index + m[0].length;
    }
    return out + str.slice(last);
}

/**
 * Parse a query string tolerating HTML-escaped separators — serializers
 * write `&` as `&amp;` (Zotero) or `&#x26;`/`&#38;` (hast-util-to-html).
 */
function parseQuery(query: string): Map<string, string> {
    const normalized = query.replace(/&amp;|&#x26;|&#38;/gi, "&");
    const params = new Map<string, string>();
    for (const pair of normalized.split("&")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        try {
            params.set(
                pair.slice(0, eq),
                decodeURIComponent(pair.slice(eq + 1)),
            );
        } catch {
            return new Map(); // malformed encoding → treat as unparseable
        }
    }
    return params;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
}

/** Derive a 1-based page number from a parsed `navigation` payload. */
function pageFromNavigation(nav: unknown): number | null {
    const record = asRecord(nav);
    if (!record) return null;

    const position = asRecord(record.position);
    const pageIndex = position ? position.pageIndex : record.pageIndex;
    if (typeof pageIndex === "number" && Number.isInteger(pageIndex)) {
        return pageIndex + 1;
    }

    const label = record.pageLabel;
    if (typeof label === "number" && Number.isInteger(label)) return label;
    if (typeof label === "string" && /^\d+$/.test(label)) {
        return parseInt(label, 10);
    }
    return null;
}

/* ================================================================ */
/*  ZotFlow → Zotero (outbound, before IDB write)                   */
/* ================================================================ */

const ZOTFLOW_LINK_RE = /obsidian:\/\/zotflow\?[^"'\s<>)]+/g;

export async function zotflowToZoteroLinks(
    html: string,
    resolver: NoteLinkResolver,
): Promise<string> {
    if (!html.includes("obsidian://zotflow")) return html;

    return replaceAsync(html, ZOTFLOW_LINK_RE, async (m) => {
        const link = m[0];
        const query = link.slice(link.indexOf("?") + 1);
        const params = parseQuery(query);

        const type = params.get("type");
        const key = params.get("key");
        const libraryID = Number(params.get("libraryID"));
        if (!type || !key || !Number.isFinite(libraryID)) return link;

        const isGroup = await resolver.isGroupLibrary(libraryID);
        if (isGroup === null) return link;
        const prefix = zoteroLibraryPrefix(isGroup, libraryID);

        if (type === "open-note") {
            return zoteroSelectItemUri(prefix, key);
        }

        if (type === "open-annotation") {
            const attachmentKey = await resolver.getAnnotationParentKey(
                libraryID,
                key,
            );
            if (!attachmentKey) return link;
            return zoteroOpenPdfUri(prefix, attachmentKey, key);
        }

        if (type === "open-attachment") {
            const navigation = params.get("navigation");
            if (navigation === undefined) {
                return zoteroOpenPdfUri(prefix, key);
            }
            let nav: unknown;
            try {
                nav = JSON.parse(navigation);
            } catch {
                return link; // unreadable navigation → keep the working link
            }
            const annotationID = asRecord(nav)?.annotationID;
            if (typeof annotationID === "string" && annotationID) {
                return zoteroOpenPdfUri(prefix, key, annotationID);
            }
            const page = pageFromNavigation(nav);
            if (page !== null) {
                return `${zoteroOpenPdfUri(prefix, key)}?page=${page}`;
            }
            return link; // navigation carries data zotero URIs can't express
        }

        return link; // unknown type → untouched
    });
}

/* ================================================================ */
/*  Zotero → ZotFlow (inbound, before html2md display)              */
/* ================================================================ */

const ZOTERO_LINK_RE =
    /zotero:\/\/(select|open-pdf)\/(library|groups\/\d+)\/items\/([A-Z0-9]+)(\?[^"'\s<>)]*)?/g;

export async function zoteroToZotflowLinks(
    html: string,
    resolver: NoteLinkResolver,
): Promise<string> {
    if (!html.includes("zotero://")) return html;

    return replaceAsync(html, ZOTERO_LINK_RE, async (m) => {
        const [link, action, prefix, key, rawQuery] = m as unknown as [
            string,
            string,
            string,
            string,
            string | undefined,
        ];

        let libraryID: number | null;
        if (prefix === "library") {
            libraryID = await resolver.getPersonalLibraryID();
        } else {
            libraryID = Number(prefix.slice("groups/".length));
        }
        if (libraryID === null || !Number.isFinite(libraryID)) return link;

        if (action === "select") {
            return `obsidian://zotflow?type=open-note&libraryID=${libraryID}&key=${key}`;
        }

        // open-pdf
        const params = parseQuery(rawQuery ? rawQuery.slice(1) : "");
        const known = new Set(["annotation", "page"]);
        for (const name of params.keys()) {
            if (!known.has(name)) return link; // e.g. ?sel= / ?cfi= → keep
        }

        const annotation = params.get("annotation");
        if (annotation) {
            return `obsidian://zotflow?type=open-annotation&libraryID=${libraryID}&key=${annotation}`;
        }

        const page = params.get("page");
        if (page !== undefined) {
            if (!/^\d+$/.test(page)) return link;
            const navigation = encodeURIComponent(
                JSON.stringify({ pageIndex: parseInt(page, 10) - 1 }),
            );
            return `obsidian://zotflow?type=open-attachment&libraryID=${libraryID}&key=${key}&navigation=${navigation}`;
        }

        return `obsidian://zotflow?type=open-attachment&libraryID=${libraryID}&key=${key}`;
    });
}
