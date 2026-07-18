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
