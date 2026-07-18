/**
 * Note link conversion tests (pure functions, fake resolver).
 *
 * Usage:
 *   node scripts/test-note-links.mjs            # run all
 *   node scripts/test-note-links.mjs inbound    # run only matching
 */
// @ts-ignore
import {
    zotflowToZoteroLinks,
    zoteroToZotflowLinks,
    type NoteLinkResolver,
} from "worker/convert/note-links";

interface TestCase {
    name: string;
    fn: () => Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>) {
    tests.push({ name, fn });
}

function assertEq(actual: unknown, expected: unknown, label: string) {
    if (actual !== expected) {
        throw new Error(
            `assertion failed: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
        );
    }
}

/** Personal library 1; group library 777; annotation ANNO1 → attachment ATT1. */
const resolver: NoteLinkResolver = {
    async getAnnotationParentKey(_libraryID, annotationKey) {
        return annotationKey === "ANNO1" ? "ATT1" : null;
    },
    async isGroupLibrary(libraryID) {
        if (libraryID === 1) return false;
        if (libraryID === 777) return true;
        return null;
    },
    async getPersonalLibraryID() {
        return 1;
    },
};

/** Resolver that knows nothing — everything should be left untouched. */
const blindResolver: NoteLinkResolver = {
    getAnnotationParentKey: async () => null,
    isGroupLibrary: async () => null,
    getPersonalLibraryID: async () => null,
};

const zf = (q: string) => `obsidian://zotflow?${q}`;

/* ================================================================ */
/*  Outbound: ZotFlow → Zotero                                      */
/* ================================================================ */

test("outbound: open-note → select (personal)", async () => {
    const html = `<a href="${zf("type=open-note&libraryID=1&key=ITEM1")}">x</a>`;
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        `<a href="zotero://select/library/items/ITEM1">x</a>`,
        "converted",
    );
});

test("outbound: open-note → select (group prefix)", async () => {
    const html = zf("type=open-note&libraryID=777&key=ITEM1");
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        "zotero://select/groups/777/items/ITEM1",
        "group prefix",
    );
});

test("outbound: open-attachment → open-pdf", async () => {
    const html = zf("type=open-attachment&libraryID=1&key=ATT1");
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        "zotero://open-pdf/library/items/ATT1",
        "converted",
    );
});

test("outbound: open-annotation resolves parent attachment", async () => {
    const html = zf("type=open-annotation&libraryID=1&key=ANNO1");
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        "zotero://open-pdf/library/items/ATT1?annotation=ANNO1",
        "converted",
    );
});

test("outbound: unresolvable annotation left untouched", async () => {
    const html = zf("type=open-annotation&libraryID=1&key=GHOST");
    assertEq(await zotflowToZoteroLinks(html, resolver), html, "untouched");
});

test("outbound: navigation with annotationID → ?annotation", async () => {
    const nav = encodeURIComponent(JSON.stringify({ annotationID: "ANNO1" }));
    const html = zf(
        `type=open-attachment&libraryID=1&key=ATT1&navigation=${nav}`,
    );
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        "zotero://open-pdf/library/items/ATT1?annotation=ANNO1",
        "converted",
    );
});

test("outbound: navigation with position.pageIndex → ?page (1-based)", async () => {
    const nav = encodeURIComponent(
        JSON.stringify({
            position: { pageIndex: 0, rects: [[184.5, 347.0, 273.9, 355.7]] },
            selectedText: "g models also connec",
            pageLabel: 1,
        }),
    );
    const html = zf(
        `type=open-attachment&libraryID=1&key=KPM4CY9J&navigation=${nav}`,
    );
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        "zotero://open-pdf/library/items/KPM4CY9J?page=1",
        "page from pageIndex",
    );
});

test("outbound: html-escaped &amp; separators are parsed", async () => {
    const html = `<a href="obsidian://zotflow?type=open-attachment&amp;libraryID=1&amp;key=ATT1">x</a>`;
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        `<a href="zotero://open-pdf/library/items/ATT1">x</a>`,
        "converted",
    );
});

test("outbound: numeric-entity &#x26; separators are parsed (md2html output)", async () => {
    const html = `<a href="obsidian://zotflow?type=open-note&#x26;libraryID=1&#x26;key=PI7B25T2">Ashish Vaswani (2023)</a>`;
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        `<a href="zotero://select/library/items/PI7B25T2">Ashish Vaswani (2023)</a>`,
        "converted",
    );
});

test("outbound: unknown library left untouched", async () => {
    const html = zf("type=open-attachment&libraryID=99&key=ATT1");
    assertEq(await zotflowToZoteroLinks(html, resolver), html, "untouched");
});

test("outbound: unknown type left untouched", async () => {
    const html = zf("type=open-something&libraryID=1&key=K");
    assertEq(await zotflowToZoteroLinks(html, resolver), html, "untouched");
});

/* ================================================================ */
/*  Inbound: Zotero → ZotFlow                                       */
/* ================================================================ */

test("inbound: select → open-note (personal)", async () => {
    const html = `<a href="zotero://select/library/items/ITEM1">x</a>`;
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        `<a href="${zf("type=open-note&libraryID=1&key=ITEM1")}">x</a>`,
        "converted",
    );
});

test("inbound: select with group prefix", async () => {
    const html = "zotero://select/groups/777/items/ITEM1";
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        zf("type=open-note&libraryID=777&key=ITEM1"),
        "converted",
    );
});

test("inbound: open-pdf?annotation → open-annotation", async () => {
    const html = "zotero://open-pdf/library/items/ATT1?annotation=ANNO1";
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        zf("type=open-annotation&libraryID=1&key=ANNO1"),
        "converted",
    );
});

test("inbound: open-pdf?page → open-attachment with navigation", async () => {
    const html = "zotero://open-pdf/library/items/ATT1?page=3";
    const navigation = encodeURIComponent(JSON.stringify({ pageIndex: 2 }));
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        zf(`type=open-attachment&libraryID=1&key=ATT1&navigation=${navigation}`),
        "converted",
    );
});

test("inbound: bare open-pdf → open-attachment", async () => {
    const html = "zotero://open-pdf/groups/777/items/ATT1";
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        zf("type=open-attachment&libraryID=777&key=ATT1"),
        "converted",
    );
});

test("inbound: unknown query param left untouched", async () => {
    const html = "zotero://open-pdf/library/items/ATT1?sel=abc";
    assertEq(await zoteroToZotflowLinks(html, resolver), html, "untouched");
});

test("inbound: unknown personal library left untouched", async () => {
    const html = "zotero://select/library/items/ITEM1";
    assertEq(await zoteroToZotflowLinks(html, blindResolver), html, "untouched");
});

test("inbound: markdown link destination terminates at closing paren", async () => {
    const md = "see [item](zotero://select/library/items/ITEM1) here";
    assertEq(
        await zoteroToZotflowLinks(md, resolver),
        `see [item](${zf("type=open-note&libraryID=1&key=ITEM1")}) here`,
        "converted inside markdown parens",
    );
});

/* ================================================================ */
/*  Zotero 7 generic `open` + Better Notes note links               */
/* ================================================================ */

test("inbound: zotero://open behaves like open-pdf (annotation)", async () => {
    const html = "zotero://open/library/items/ATT1?annotation=ANNO1";
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        zf("type=open-annotation&libraryID=1&key=ANNO1"),
        "converted",
    );
});

test("inbound: zotero://open bare and with page", async () => {
    const bare = await zoteroToZotflowLinks(
        "zotero://open/groups/777/items/ATT1",
        resolver,
    );
    assertEq(
        bare,
        zf("type=open-attachment&libraryID=777&key=ATT1"),
        "bare open",
    );
    const navigation = encodeURIComponent(JSON.stringify({ pageIndex: 4 }));
    const paged = await zoteroToZotflowLinks(
        "zotero://open/library/items/ATT1?page=5",
        resolver,
    );
    assertEq(
        paged,
        zf(`type=open-attachment&libraryID=1&key=ATT1&navigation=${navigation}`),
        "paged open",
    );
});

test("inbound: zotero://open with unknown param left untouched", async () => {
    const html = "zotero://open/library/items/ATT1?cfi=epubcfi(/6/4)";
    assertEq(await zoteroToZotflowLinks(html, resolver), html, "untouched");
});

test("inbound: Better Notes u-form → open-note (anchors dropped)", async () => {
    const html = `<a href="zotero://note/u/NOTE1/?ignore=1&line=5#sel">note</a>`;
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        `<a href="${zf("type=open-item-note&libraryID=1&key=NOTE1")}">note</a>`,
        "converted, params and hash dropped",
    );
});

test("inbound: Better Notes bare u-form without trailing slash", async () => {
    const html = "zotero://note/u/NOTE1";
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        zf("type=open-item-note&libraryID=1&key=NOTE1"),
        "converted",
    );
});

test("inbound: Better Notes numeric (internal group id) form untouched", async () => {
    const html = "zotero://note/12345/NOTE1/?line=2";
    assertEq(await zoteroToZotflowLinks(html, resolver), html, "untouched");
});

test("inbound: unexpected deeper note path left fully untouched", async () => {
    const html = "zotero://note/u/NOTE1/extra/segments";
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        html,
        "no partial conversion",
    );
});

test("inbound: deeper standard path left fully untouched", async () => {
    const html = "zotero://select/library/items/ITEM1/extra";
    assertEq(
        await zoteroToZotflowLinks(html, resolver),
        html,
        "no partial conversion",
    );
});

test("inbound: autolink becomes a resource link keeping zotero text", async () => {
    // html2md emits <url> when a link's text equals its URL (Zotero
    // "Copy Link" pastes) — the visible text must NOT become a raw
    // zotflow URL.
    const md = "<zotero://open-pdf/library/items/KPM4CY9J?annotation=KRVQWZXH>";
    assertEq(
        await zoteroToZotflowLinks(md, resolver),
        `[zotero://open-pdf/library/items/KPM4CY9J?annotation=KRVQWZXH](${zf("type=open-annotation&libraryID=1&key=KRVQWZXH")})`,
        "resource link with original zotero URL as text",
    );
});

test("inbound: unconvertible autolink stays an autolink", async () => {
    const md = "<zotero://open-pdf/library/items/ATT1?cfi=x>";
    assertEq(await zoteroToZotflowLinks(md, resolver), md, "untouched");
});

test("inbound: Better Notes autolink converts too", async () => {
    const md = "<zotero://note/u/NOTE1/?line=3>";
    assertEq(
        await zoteroToZotflowLinks(md, resolver),
        `[zotero://note/u/NOTE1/?line=3](${zf("type=open-item-note&libraryID=1&key=NOTE1")})`,
        "BN autolink → resource link",
    );
});

test("outbound: open-item-note (personal) emits Better Notes form", async () => {
    const html = zf("type=open-item-note&libraryID=1&key=NOTE1");
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        "zotero://note/u/NOTE1/",
        "BN form for personal child note",
    );
});

test("outbound: open-item-note (group) falls back to select", async () => {
    const html = zf("type=open-item-note&libraryID=777&key=NOTE1");
    assertEq(
        await zotflowToZoteroLinks(html, resolver),
        "zotero://select/groups/777/items/NOTE1",
        "select for group note",
    );
});

test("roundtrip: Better Notes link is stable after first anchor drop", async () => {
    const original = "zotero://note/u/NOTE1/?line=5";
    const displayed = await zoteroToZotflowLinks(original, resolver);
    const stored = await zotflowToZoteroLinks(displayed, resolver);
    assertEq(stored, "zotero://note/u/NOTE1/", "stays a BN link, never select");
    const displayed2 = await zoteroToZotflowLinks(stored, resolver);
    assertEq(
        await zotflowToZoteroLinks(displayed2, resolver),
        stored,
        "stable thereafter",
    );
});

/* ================================================================ */
/*  Round trips                                                     */
/* ================================================================ */

test("roundtrip: annotation link is stable", async () => {
    const stored = "zotero://open-pdf/library/items/ATT1?annotation=ANNO1";
    const displayed = await zoteroToZotflowLinks(stored, resolver);
    assertEq(
        await zotflowToZoteroLinks(displayed, resolver),
        stored,
        "back to stored form",
    );
});

test("roundtrip: page link is stable", async () => {
    const stored = "zotero://open-pdf/library/items/ATT1?page=5";
    const displayed = await zoteroToZotflowLinks(stored, resolver);
    assertEq(
        await zotflowToZoteroLinks(displayed, resolver),
        stored,
        "back to stored form",
    );
});

test("roundtrip: select link is stable", async () => {
    const stored = "zotero://select/groups/777/items/ITEM1";
    const displayed = await zoteroToZotflowLinks(stored, resolver);
    assertEq(
        await zotflowToZoteroLinks(displayed, resolver),
        stored,
        "back to stored form",
    );
});

test("mixed: multiple links and surrounding prose convert independently", async () => {
    const html =
        `<p>see <a href="zotero://select/library/items/A1">item</a> and ` +
        `<a href="zotero://open-pdf/groups/777/items/B2?annotation=ANNO1">note</a>, ` +
        `plus plain text zotero://unrelated/thing</p>`;
    const out = await zoteroToZotflowLinks(html, resolver);
    assertEq(
        out,
        `<p>see <a href="${zf("type=open-note&libraryID=1&key=A1")}">item</a> and ` +
            `<a href="${zf("type=open-annotation&libraryID=777&key=ANNO1")}">note</a>, ` +
            `plus plain text zotero://unrelated/thing</p>`,
        "each link converted, unrelated scheme untouched",
    );
});

/* ================================================================ */
/*  Runner                                                          */
/* ================================================================ */

export async function run(filter?: string[]) {
    let pass = 0;
    let fail = 0;
    for (const t of tests) {
        if (filter && !filter.some((f) => t.name.includes(f))) continue;
        try {
            await t.fn();
            pass++;
            console.log(`  ✓ ${t.name}`);
        } catch (e: any) {
            fail++;
            console.error(`  ✗ ${t.name}\n    ${e.message}`);
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}
