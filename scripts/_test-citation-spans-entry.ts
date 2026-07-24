/**
 * Citation/annotation span link wrap-strip tests (end-to-end through
 * ConvertService html2md/md2html).
 *
 * Usage:
 *   node scripts/test-citation-spans.mjs            # run all
 *   node scripts/test-citation-spans.mjs strip      # run only matching
 */
// @ts-ignore
import { ConvertService } from "worker/services/convert";
// @ts-ignore
import { stripCitationSpanLinks } from "worker/convert/citation-span-links";

const convert = new ConvertService();

interface TestCase {
    name: string;
    fn: () => Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>) {
    tests.push({ name, fn });
}

function assert(cond: boolean, label: string) {
    if (!cond) throw new Error(`assertion failed: ${label}`);
}

function assertContains(haystack: string, needle: string, label: string) {
    if (!haystack.includes(needle)) {
        throw new Error(
            `assertion failed: ${label}\n  needle: ${JSON.stringify(needle)}\n  in:     ${JSON.stringify(haystack)}`,
        );
    }
}

/** Real-world sample (user library 12985680). */
const ANNOTATION_PAYLOAD = encodeURIComponent(
    JSON.stringify({
        attachmentURI: "http://zotero.org/users/12985680/items/KPM4CY9J",
        annotationKey: "8U7YVR5M",
        color: "#ffd400",
        pageLabel: "1",
        position: { pageIndex: 0, rects: [[338.692, 547.223, 374.846, 557.683]] },
        citationItem: {
            uris: ["http://zotero.org/users/12985680/items/PI7B25T2"],
            locator: "1",
        },
    }),
);

const CITATION_PAYLOAD = encodeURIComponent(
    JSON.stringify({
        citationItems: [
            {
                uris: ["http://zotero.org/users/12985680/items/PI7B25T2"],
                locator: "1",
            },
        ],
        properties: {},
    }),
);

const NOTE_HTML =
    `<p><span class="highlight" data-annotation="${ANNOTATION_PAYLOAD}">“Niki Par”</span> ` +
    `<span class="citation" data-citation="${CITATION_PAYLOAD}">(<span class="citation-item">Vaswani et al., 2023, p. 1</span>)</span></p>`;

// NB: hast-util-to-html serializes `&` inside attribute values as
// `&#x26;` — the DOM decodes it back, so clicks receive the clean URL.
const EXPECTED_ANNO_HREF = `obsidian://zotflow?type=open-attachment&#x26;libraryID=12985680&#x26;key=KPM4CY9J&#x26;navigation=${encodeURIComponent(JSON.stringify({ annotationID: "8U7YVR5M" }))}`;
const EXPECTED_CITE_HREF =
    "obsidian://zotflow?type=open-note&#x26;libraryID=12985680&#x26;key=PI7B25T2";

/* ================================================================ */
/*  Wrap (html2md with linkCitationSpans)                           */
/* ================================================================ */

test("wrap: highlight span content gets an annotation anchor", async () => {
    const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
    assertContains(
        md,
        `<a class="zotflow-span-link" href="${EXPECTED_ANNO_HREF}">“Niki Par”</a>`,
        "anchor inside highlight span",
    );
});

test("wrap: citation span content gets an open-note anchor", async () => {
    const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
    assertContains(
        md,
        `<a class="zotflow-span-link" href="${EXPECTED_CITE_HREF}">(<span class="citation-item">Vaswani et al., 2023, p. 1</span>)</a>`,
        "anchor wraps nested citation-item",
    );
});

test("wrap: span payloads stay untouched", async () => {
    const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
    assertContains(md, `data-annotation="${ANNOTATION_PAYLOAD}"`, "annotation payload");
    assertContains(md, `data-citation="${CITATION_PAYLOAD}"`, "citation payload");
});

test("wrap: disabled option leaves spans inert", async () => {
    const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: false });
    assert(!md.includes("zotflow-span-link"), "no anchors injected");
});

test("wrap: group-library URI maps to group libraryID", async () => {
    const payload = encodeURIComponent(
        JSON.stringify({
            attachmentURI: "http://zotero.org/groups/777/items/ATT1",
            annotationKey: "ANNO1",
        }),
    );
    const html = `<p><span class="highlight" data-annotation="${payload}">x</span></p>`;
    const md = await convert.html2md(html, { linkCitationSpans: true });
    assertContains(md, "libraryID=777&#x26;key=ATT1", "group id as libraryID");
});

test("wrap: unresolvable payload stays unwrapped", async () => {
    const payload = encodeURIComponent(JSON.stringify({ color: "#ffd400" }));
    const html = `<p><span class="highlight" data-annotation="${payload}">x</span></p>`;
    const md = await convert.html2md(html, { linkCitationSpans: true });
    assert(!md.includes("zotflow-span-link"), "no anchor without target");
});

/* ================================================================ */
/*  Strip (md2html) + round trip                                    */
/* ================================================================ */

test("roundtrip: md2html strips anchors and restores original spans", async () => {
    const md = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
    const html = await convert.md2html(md, {});
    assert(!html.includes("zotflow-span-link"), "anchors stripped");
    assert(!html.includes("obsidian://zotflow"), "no zotflow residue");
    assertContains(html, `data-annotation="${ANNOTATION_PAYLOAD}"`, "annotation payload survives");
    assertContains(html, `data-citation="${CITATION_PAYLOAD}"`, "citation payload survives");
    assertContains(
        html,
        `<span class="citation-item">Vaswani et al., 2023, p. 1</span>`,
        "nested citation-item survives",
    );
    assertContains(html, "“Niki Par”", "highlight text survives");
});

test("roundtrip: double cycle is stable", async () => {
    const md1 = await convert.html2md(NOTE_HTML, { linkCitationSpans: true });
    const html1 = await convert.md2html(md1, {});
    const md2 = await convert.html2md(html1, { linkCitationSpans: true });
    const html2 = await convert.md2html(md2, {});
    if (html1 !== html2) {
        throw new Error(
            `assertion failed: double roundtrip stable\n  first:  ${JSON.stringify(html1)}\n  second: ${JSON.stringify(html2)}`,
        );
    }
});

test("strip: tolerates shuffled attribute order", async () => {
    const html = `<p><span class="highlight" data-annotation="x"><a href="obsidian://zotflow?x" class="zotflow-span-link extra">text</a></span></p>`;
    const out = stripCitationSpanLinks(html);
    assert(!out.includes("<a"), "anchor removed");
    assertContains(out, ">text</span>", "children kept");
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
