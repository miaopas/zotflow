/**
 * Persist-region splice util tests (pure functions, no Obsidian).
 *
 * Usage:
 *   node scripts/test-persist-regions.mjs            # run all
 *   node scripts/test-persist-regions.mjs orphan     # run only matching
 */
// @ts-ignore
import {
    extractPersistRegions,
    reinsertPersistRegions,
    ORPHAN_BEG_MARKER,
    ORPHAN_END_MARKER,
    ORPHAN_HEADING,
} from "utils/persist-regions";

interface TestCase {
    name: string;
    fn: () => void;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void) {
    tests.push({ name, fn });
}

function assert(cond: boolean, label: string) {
    if (!cond) throw new Error(`assertion failed: ${label}`);
}

function assertEq(actual: unknown, expected: unknown, label: string) {
    if (actual !== expected) {
        throw new Error(
            `assertion failed: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
        );
    }
}

function assertThrows(fn: () => void, needle: string, label: string) {
    try {
        fn();
    } catch (e: any) {
        assert(
            String(e.message).includes(needle),
            `${label} — message "${e.message}" should contain "${needle}"`,
        );
        return;
    }
    throw new Error(`assertion failed: ${label} — expected throw`);
}

const beg = (id: string) => `<!-- ZF_PERSIST_BEG_${id} -->`;
const end = (id: string) => `<!-- ZF_PERSIST_END_${id} -->`;

/* ================================================================ */
/*  Extract                                                         */
/* ================================================================ */

test("extract: no markers fast path", () => {
    const r = extractPersistRegions("# Note\n\nplain text\n");
    assertEq(r.regions.length, 0, "no regions");
    assertEq(r.orphanSectionInner, null, "no orphan section");
});

test("extract: basic region content verbatim", () => {
    const doc = `# T\n${beg("summary")}\nline one\n\nline two\n${end("summary")}\ntail\n`;
    const r = extractPersistRegions(doc);
    assertEq(r.regions.length, 1, "one region");
    assertEq(r.regions[0]!.id, "summary", "id");
    assertEq(r.regions[0]!.content, "line one\n\nline two", "content verbatim");
});

test("extract: empty region", () => {
    const doc = `${beg("a")}\n${end("a")}\n`;
    const r = extractPersistRegions(doc);
    assertEq(r.regions[0]!.content, "", "empty content");
});

test("extract: prose mention of ZF_PERSIST is ignored", () => {
    const doc = "The ZF_PERSIST_BEG_x token is documented here.\n";
    const r = extractPersistRegions(doc);
    assertEq(r.regions.length, 0, "prose ignored");
});

test("extract: marker text inside frontmatter is ignored", () => {
    const doc = `---\nnote: "${beg("fm")}"\n---\nbody\n`;
    const r = extractPersistRegions(doc);
    assertEq(r.regions.length, 0, "frontmatter ignored");
});

test("extract: CRLF document", () => {
    const doc = `# T\r\n${beg("a")}\r\nhello\r\nworld\r\n${end("a")}\r\n`;
    const r = extractPersistRegions(doc);
    assertEq(r.regions[0]!.content, "hello\r\nworld", "CRLF content verbatim");
});

test("extract: code fence limitation — markers matched anywhere", () => {
    const doc = `\`\`\`\n${beg("fenced")}\nx\n${end("fenced")}\n\`\`\`\n`;
    const r = extractPersistRegions(doc);
    assertEq(r.regions.length, 1, "fenced marker still parsed (documented v1 limitation)");
});

/* ================================================================ */
/*  Throw cases                                                     */
/* ================================================================ */

test("throw: missing id", () => {
    assertThrows(
        () => extractPersistRegions("<!-- ZF_PERSIST_BEG_ -->\n"),
        "Malformed",
        "missing id throws",
    );
});

test("throw: invalid id chars", () => {
    assertThrows(
        () => extractPersistRegions("<!-- ZF_PERSIST_BEG_bad id -->\n"),
        "Malformed",
        "space in id throws",
    );
});

test("throw: marker not on its own line", () => {
    assertThrows(
        () => extractPersistRegions(`text ${beg("a")}\nx\n${end("a")}\n`),
        "Malformed",
        "mid-line marker throws",
    );
});

test("throw: malformed comment syntax", () => {
    assertThrows(
        () => extractPersistRegions("<!--ZF_PERSIST_BEG_a-->\n"),
        "Malformed",
        "missing spaces throws",
    );
});

test("throw: duplicate id", () => {
    const doc = `${beg("a")}\nx\n${end("a")}\n${beg("a")}\ny\n${end("a")}\n`;
    assertThrows(() => extractPersistRegions(doc), "Duplicate", "duplicate id");
});

test("throw: unclosed BEG", () => {
    assertThrows(
        () => extractPersistRegions(`${beg("a")}\nx\n`),
        "Unclosed",
        "unclosed region",
    );
});

test("throw: unmatched END", () => {
    assertThrows(
        () => extractPersistRegions(`x\n${end("a")}\n`),
        "Unmatched",
        "unmatched END",
    );
});

test("throw: nested regions", () => {
    const doc = `${beg("a")}\n${beg("b")}\nx\n${end("b")}\n${end("a")}\n`;
    assertThrows(() => extractPersistRegions(doc), "Nested", "nesting");
});

test("throw: mismatched END id", () => {
    const doc = `${beg("a")}\nx\n${end("b")}\n`;
    assertThrows(() => extractPersistRegions(doc), "Mismatched", "mismatch");
});

test("throw: error carries line number", () => {
    assertThrows(
        () => extractPersistRegions("line1\nline2\n<!-- ZF_PERSIST_BEG_ -->\n"),
        "line 3",
        "line number in message",
    );
});

/* ================================================================ */
/*  Reinsert: id match                                              */
/* ================================================================ */

const TPL = `---\nzotero-key: K\n---\n# Title\n\n${beg("summary")}\n\n${end("summary")}\n\nrendered tail\n`;

test("reinsert: matched id replaces rendered default", () => {
    const old = `---\nzotero-key: K\n---\n# Old\n\n${beg("summary")}\nmy precious notes\n${end("summary")}\n`;
    const ex = extractPersistRegions(old);
    const r = reinsertPersistRegions(TPL, ex);
    assert(
        r.content.includes(`${beg("summary")}\nmy precious notes\n${end("summary")}`),
        "old content spliced into new render",
    );
    assert(!r.content.includes(ORPHAN_BEG_MARKER), "no orphan section");
    assertEq(r.newOrphans.length, 0, "no orphans");
});

test("reinsert: fresh region keeps rendered default", () => {
    const tpl = `${beg("summary")}\nDefault text\n${end("summary")}\n`;
    const r = reinsertPersistRegions(tpl, {
        regions: [],
        orphanSectionInner: null,
    });
    assert(r.content.includes("Default text"), "default preserved");
});

test("reinsert: user-cleared region stays empty", () => {
    const old = `${beg("summary")}\n\n${end("summary")}\n`;
    const tpl = `${beg("summary")}\nDefault text\n${end("summary")}\n`;
    const ex = extractPersistRegions(old);
    const r = reinsertPersistRegions(tpl, ex);
    assert(!r.content.includes("Default text"), "default replaced by empty");
});

test("reinsert: multiple regions, order independent", () => {
    const old = `${beg("a")}\nAAA\n${end("a")}\n${beg("b")}\nBBB\n${end("b")}\n`;
    const tpl = `${beg("b")}\n\n${end("b")}\nmiddle\n${beg("a")}\n\n${end("a")}\n`;
    const r = reinsertPersistRegions(tpl, extractPersistRegions(old));
    assert(
        r.content.indexOf("BBB") < r.content.indexOf("AAA"),
        "contents land at their template positions",
    );
});

test("reinsert: idempotent across cycles", () => {
    const old = `${beg("summary")}\nkeep me\n${end("summary")}\n`;
    const first = reinsertPersistRegions(TPL, extractPersistRegions(old));
    const second = reinsertPersistRegions(TPL, extractPersistRegions(first.content));
    assertEq(second.content, first.content, "stable fixpoint");
});

test("reinsert: CRLF render uses CRLF for spliced lines", () => {
    const old = `${beg("a")}\nuser text\n${end("a")}\n`;
    const tpl = `# T\r\n${beg("a")}\r\n\r\n${end("a")}\r\n`;
    const r = reinsertPersistRegions(tpl, extractPersistRegions(old));
    assert(
        r.content.includes(`${beg("a")}\r\nuser text\r\n${end("a")}`),
        "CRLF preserved around splice",
    );
});

/* ================================================================ */
/*  Reinsert: orphans                                               */
/* ================================================================ */

test("orphan: empty orphan silently dropped", () => {
    const old = `${beg("gone")}\n   \n${end("gone")}\n`;
    const r = reinsertPersistRegions("# fresh render\n", extractPersistRegions(old));
    assertEq(r.newOrphans.length, 0, "not reported");
    assert(!r.content.includes(ORPHAN_BEG_MARKER), "no section");
    assert(!r.content.includes("gone"), "no residue");
});

test("orphan: non-empty demoted to bare labelled content", () => {
    const old = `${beg("gone")}\nsave this\n${end("gone")}\n`;
    const r = reinsertPersistRegions("# fresh render\n", extractPersistRegions(old));
    assertEq(r.newOrphans.length, 1, "reported");
    assertEq(r.newOrphans[0]!.id, "gone", "orphan id");
    assert(r.content.includes(ORPHAN_BEG_MARKER), "sentinel BEG");
    assert(r.content.includes(ORPHAN_END_MARKER), "sentinel END");
    assert(r.content.includes(ORPHAN_HEADING), "heading");
    assert(r.content.includes("**`gone`**"), "bold id label");
    assert(r.content.includes("save this"), "content kept");
    assert(!r.content.includes(beg("gone")), "persist markers stripped");
});

test("orphan: section round-trips verbatim, new orphans appended after", () => {
    // Cycle 1: region "a" orphaned
    const old1 = `${beg("a")}\nfirst orphan\n${end("a")}\n`;
    const c1 = reinsertPersistRegions("render\n", extractPersistRegions(old1));
    // Cycle 2: nothing new — section must survive byte-identically
    const c2 = reinsertPersistRegions("render\n", extractPersistRegions(c1.content));
    assertEq(c2.content, c1.content, "verbatim round-trip");
    assertEq(c2.newOrphans.length, 0, "existing orphan NOT re-reported (Notice fires once)");
    // Cycle 3: region "b" orphaned too
    const old3 = `${beg("b")}\nsecond orphan\n${end("b")}\nrender\n` + c2.content.slice("render\n".length);
    const c3 = reinsertPersistRegions("render\n", extractPersistRegions(old3));
    assertEq(c3.newOrphans.length, 1, "only the new orphan reported");
    assert(
        c3.content.indexOf("first orphan") < c3.content.indexOf("second orphan"),
        "new orphan appended after existing",
    );
    assertEq(
        c3.content.split(ORPHAN_BEG_MARKER).length,
        2,
        "single sentinel pair",
    );
});

test("orphan: marker-like text inside section is plain text", () => {
    const doc = `body\n${ORPHAN_BEG_MARKER}\n${ORPHAN_HEADING}\n\n**\`x\`**\n<!-- ZF_PERSIST_BEG_ -->\nbroken marker as content\n${ORPHAN_END_MARKER}\n`;
    const ex = extractPersistRegions(doc); // must NOT throw
    assert(
        ex.orphanSectionInner!.includes("<!-- ZF_PERSIST_BEG_ -->"),
        "kept verbatim",
    );
    const r = reinsertPersistRegions("render\n", ex);
    assert(
        r.content.includes("broken marker as content"),
        "survives rewrite",
    );
});

test("orphan: emptied section is dropped", () => {
    const doc = `body\n${ORPHAN_BEG_MARKER}\n${ORPHAN_HEADING}\n\n**\`x\`**\n\n${ORPHAN_END_MARKER}\n`;
    const r = reinsertPersistRegions("render\n", extractPersistRegions(doc));
    assert(!r.content.includes(ORPHAN_BEG_MARKER), "empty shell removed");
});

test("orphan: dangling sentinel degrades to no span", () => {
    const doc = `body\n${ORPHAN_BEG_MARKER}\nstranded\n`;
    const ex = extractPersistRegions(doc); // must NOT throw
    assertEq(ex.orphanSectionInner, null, "no span detected");
    const r = reinsertPersistRegions("render\n", ex);
    assert(!r.content.includes(ORPHAN_BEG_MARKER), "stray sentinel healed away");
});

/* ================================================================ */
/*  Reinsert: render validation                                     */
/* ================================================================ */

test("render validation: template emitting orphan sentinel throws", () => {
    assertThrows(
        () =>
            reinsertPersistRegions(`${ORPHAN_BEG_MARKER}\n${ORPHAN_END_MARKER}\n`, {
                regions: [],
                orphanSectionInner: null,
            }),
        "must not emit",
        "orphan sentinel in render",
    );
});

test("render validation: duplicate id in render throws", () => {
    const tpl = `${beg("a")}\n\n${end("a")}\n${beg("a")}\n\n${end("a")}\n`;
    assertThrows(
        () =>
            reinsertPersistRegions(tpl, { regions: [], orphanSectionInner: null }),
        "Duplicate",
        "duplicate in render",
    );
});

test("render validation: marker text via synced content throws, not garbles", () => {
    // e.g. a Zotero note body contained a lone END marker that survived html2md
    const tpl = `# T\n${end("evil")}\n`;
    assertThrows(
        () =>
            reinsertPersistRegions(tpl, { regions: [], orphanSectionInner: null }),
        "Unmatched",
        "safe refusal",
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
            t.fn();
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
