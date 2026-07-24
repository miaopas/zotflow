/**
 * Clickable Zotero annotation/citation spans.
 *
 * Zotero notes carry `<span class="highlight|underline" data-annotation>`
 * and `<span class="citation" data-citation>` elements whose URL-encoded
 * JSON payloads identify an annotation (attachmentURI + annotationKey) or
 * a cited item (citationItems[].uris). They round-trip through ZotFlow as
 * raw-HTML passthrough — data-preserving but inert in Obsidian.
 *
 * To make them clickable WITHOUT touching the payloads:
 *  - inbound (html2md, HAST stage): wrap each span's children in
 *    `<a class="zotflow-span-link" href="obsidian://zotflow?…">` built
 *    from the payload — Obsidian renders a normal clickable link in every
 *    view mode;
 *  - outbound (md2html, final string): strip those anchors again —
 *    UNCONDITIONALLY, so the derived links never leak into IDB/Zotero.
 *
 * Payloads that cannot be resolved to a target are left unwrapped.
 */

import { visit, SKIP } from "unist-util-visit";
import { h } from "hastscript";
import type { Root as HRoot, Element, ElementContent } from "hast";

/** Marker class on injected anchors — the outbound strip keys on it. */
export const SPAN_LINK_CLASS = "zotflow-span-link";

const ZOTERO_WEB_URI_RE =
    /^https?:\/\/(?:www\.)?zotero\.org\/(?:users|groups)\/(\d+)\/items\/([A-Z0-9]+)$/i;

/**
 * Parse a Zotero web URI (`http://zotero.org/users/<id>/items/<KEY>`).
 * Both the personal userID and group ids map directly to ZotFlow's
 * libraryID.
 */
function parseZoteroWebUri(
    uri: unknown,
): { libraryID: number; key: string } | null {
    if (typeof uri !== "string") return null;
    const m = ZOTERO_WEB_URI_RE.exec(uri.trim());
    if (!m) return null;
    return { libraryID: Number(m[1]), key: m[2]! };
}

function decodePayload(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const parsed: unknown = JSON.parse(decodeURIComponent(raw));
        return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** highlight/underline span → open the attachment at the annotation. */
function hrefForAnnotation(payload: Record<string, unknown>): string | null {
    const target = parseZoteroWebUri(payload.attachmentURI);
    const annotationKey = payload.annotationKey;
    if (!target || typeof annotationKey !== "string" || !annotationKey) {
        return null;
    }
    const navigation = encodeURIComponent(
        JSON.stringify({ annotationID: annotationKey }),
    );
    return `obsidian://zotflow?type=open-attachment&libraryID=${target.libraryID}&key=${target.key}&navigation=${navigation}`;
}

/** citation span → open the cited item's source note. */
function hrefForCitation(payload: Record<string, unknown>): string | null {
    const items = payload.citationItems;
    if (!Array.isArray(items) || items.length === 0) return null;
    const first: unknown = items[0];
    if (typeof first !== "object" || first === null) return null;
    const uris = (first as Record<string, unknown>).uris;
    const target = parseZoteroWebUri(Array.isArray(uris) ? uris[0] : null);
    if (!target) return null;
    return `obsidian://zotflow?type=open-note&libraryID=${target.libraryID}&key=${target.key}`;
}

function isSpanLinkAnchor(node: ElementContent): boolean {
    return (
        node.type === "element" &&
        node.tagName === "a" &&
        Array.isArray(node.properties?.className) &&
        node.properties.className.includes(SPAN_LINK_CLASS)
    );
}

/**
 * Wrap annotation/citation span contents with zotflow anchors (in place).
 * Runs on the parsed note HAST before rehype→remark, so the raw-HTML
 * passthrough serializes span + anchor together.
 */
export function wrapCitationSpanLinks(tree: HRoot): void {
    visit(tree, "element", (node: Element) => {
        if (node.tagName !== "span") return;

        const className = node.properties?.className;
        const classes = Array.isArray(className) ? className.map(String) : [];

        let href: string | null = null;
        if (classes.includes("citation")) {
            const payload = decodePayload(node.properties?.dataCitation);
            href = payload ? hrefForCitation(payload) : null;
        } else if (
            classes.includes("highlight") ||
            classes.includes("underline")
        ) {
            const payload = decodePayload(node.properties?.dataAnnotation);
            href = payload ? hrefForAnnotation(payload) : null;
        }
        if (!href) return;

        // Idempotency: already wrapped
        if (node.children.length === 1 && isSpanLinkAnchor(node.children[0]!)) {
            return SKIP;
        }

        node.children = [
            h(
                "a",
                { className: [SPAN_LINK_CLASS], href },
                node.children,
            ),
        ];
        return SKIP;
    });
}

/**
 * Remove every injected span-link anchor from note HTML (keeps children).
 * Runs unconditionally on the md2html output — derived links must never
 * reach IDB/Zotero, regardless of the display setting's current state.
 */
export function stripCitationSpanLinks(html: string): string {
    if (!html.includes(SPAN_LINK_CLASS)) return html;
    // Anchors never nest, so lazy-matching to the first </a> is exact.
    return html.replace(
        /<a\b[^>]*class="[^"]*zotflow-span-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
        "$1",
    );
}
