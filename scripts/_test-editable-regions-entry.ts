/**
 * Editable-region parser tests (pure CM6 Text, no Obsidian).
 *
 * Usage:
 *   node scripts/test-editable-regions.mjs            # run all
 *   node scripts/test-editable-regions.mjs inline     # run only matching
 */
import { Text } from "@codemirror/state";
// @ts-ignore
import {
    parseEditableRegions,
    type EditableRegion,
} from "ui/editor/editable-region-parser";

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

function parse(str: string): {
    regions: EditableRegion[];
    content: (r: EditableRegion) => string;
} {
    const doc = Text.of(str.split("\n"));
    const regions = parseEditableRegions(doc);
    return {
        regions,
        content: (r) => doc.sliceString(r.from, r.to),
    };
}

const B = (t: string, k: string) => `<!-- ZF_${t}_BEG_${k} -->`;
const E = (t: string, k: string) => `<!-- ZF_${t}_END_${k} -->`;

/* ================================================================ */
/*  Block form                                                      */
/* ================================================================ */

test("block: NOTE region content between marker lines", () => {
    const str = `# T\n${B("NOTE", "K1")}\nline one\nline two\n${E("NOTE", "K1")}\ntail`;
    const { regions, content } = parse(str);
    assertEq(regions.length, 1, "one region");
    assertEq(regions[0]!.type, "NOTE", "type");
    assertEq(regions[0]!.key, "K1", "key");
    assertEq(content(regions[0]!), "line one\nline two", "content");
});

test("block: marker spans cover exactly the marker text", () => {
    const str = `${B("NOTE", "K1")}\nx\n${E("NOTE", "K1")}`;
    const doc = Text.of(str.split("\n"));
    const r = parseEditableRegions(doc)[0]!;
    assertEq(
        doc.sliceString(r.begFrom, r.begTo),
        B("NOTE", "K1"),
        "BEG span",
    );
    assertEq(doc.sliceString(r.endFrom, r.endTo), E("NOTE", "K1"), "END span");
});

test("block: ANNO inside blockquote keeps `> ` prefix in content", () => {
    const str = `> ${B("ANNO", "K1")}\n> comment\n> ${E("ANNO", "K1")}`;
    const { regions, content } = parse(str);
    assertEq(regions.length, 1, "one region");
    assertEq(content(regions[0]!), "> comment", "content with quote prefix");
});

test("block: adjacent markers form a zero-width region", () => {
    const str = `${B("PERSIST", "summary")}\n${E("PERSIST", "summary")}`;
    const { regions } = parse(str);
    assertEq(regions.length, 1, "region exists");
    assertEq(regions[0]!.from, regions[0]!.to, "zero-width");
});

test("block: single blank line region is editable", () => {
    const str = `${B("PERSIST", "summary")}\n\n${E("PERSIST", "summary")}`;
    const { regions, content } = parse(str);
    assertEq(regions.length, 1, "region exists");
    assertEq(content(regions[0]!), "", "empty content");
});

/* ================================================================ */
/*  Inline form                                                     */
/* ================================================================ */

test("inline: ANNO markers and content on one line", () => {
    const str = `> ${B("ANNO", "K1")}my comment${E("ANNO", "K1")}`;
    const { regions, content } = parse(str);
    assertEq(regions.length, 1, "one region");
    assertEq(content(regions[0]!), "my comment", "content between markers");
});

test("inline: empty region is zero-width at the marker seam", () => {
    const str = `> ${B("ANNO", "K1")}${E("ANNO", "K1")}`;
    const { regions } = parse(str);
    assertEq(regions.length, 1, "region exists");
    assertEq(regions[0]!.from, regions[0]!.to, "zero-width");
});

test("inline: marker spans exclude content", () => {
    const str = `> ${B("ANNO", "K1")}abc${E("ANNO", "K1")}`;
    const doc = Text.of(str.split("\n"));
    const r = parseEditableRegions(doc)[0]!;
    assertEq(doc.sliceString(r.begFrom, r.begTo), B("ANNO", "K1"), "BEG span");
    assertEq(doc.sliceString(r.endFrom, r.endTo), E("ANNO", "K1"), "END span");
    assertEq(doc.sliceString(r.from, r.to), "abc", "content");
});

/* ================================================================ */
/*  Mixed forms (multi-line paste into an inline region)            */
/* ================================================================ */

test("mixed: inline BEG, content continues to line with inline END", () => {
    const str = `> ${B("ANNO", "K1")}line1\n> line2${E("ANNO", "K1")}`;
    const { regions, content } = parse(str);
    assertEq(regions.length, 1, "one region");
    assertEq(content(regions[0]!), "line1\n> line2", "mixed content");
});

test("mixed: inline BEG with block END line", () => {
    const str = `> ${B("ANNO", "K1")}line1\n> ${E("ANNO", "K1")}`;
    const { regions, content } = parse(str);
    assertEq(content(regions[0]!), "line1", "content excludes END prefix");
});

test("mixed: block BEG with inline END", () => {
    const str = `> ${B("ANNO", "K1")}\n> line1${E("ANNO", "K1")}`;
    const { regions, content } = parse(str);
    assertEq(content(regions[0]!), "> line1", "content from next line start");
});

/* ================================================================ */
/*  Meta / ids / pairing                                            */
/* ================================================================ */

test("meta: ZF_NOTE_META line moves content start", () => {
    const str = `${B("NOTE", "K1")}\n<!-- ZF_NOTE_META data -->\nbody\n${E("NOTE", "K1")}`;
    const { regions, content } = parse(str);
    const r = regions[0]!;
    assert(r.metaFrom != null && r.metaTo != null, "meta detected");
    assertEq(content(r), "body", "content starts after meta line");
});

test("ids: hyphenated persist ids parse", () => {
    const str = `${B("PERSIST", "reading-todo")}\nx\n${E("PERSIST", "reading-todo")}`;
    const { regions } = parse(str);
    assertEq(regions.length, 1, "region exists");
    assertEq(regions[0]!.key, "reading-todo", "hyphenated id");
});

test("pairing: multiple regions, unmatched markers ignored", () => {
    const str = [
        `> ${B("ANNO", "A1")}c1${E("ANNO", "A1")}`,
        B("NOTE", "N1"),
        "note body",
        E("NOTE", "N1"),
        E("ANNO", "STRAY"),
        `> ${B("ANNO", "A2")}c2${E("ANNO", "A2")}`,
    ].join("\n");
    const { regions, content } = parse(str);
    assertEq(regions.length, 3, "three regions");
    assertEq(content(regions[0]!), "c1", "first inline");
    assertEq(content(regions[1]!), "note body", "block note");
    assertEq(content(regions[2]!), "c2", "second inline");
});

test("pairing: type/key mismatch does not cross-pair", () => {
    const str = `${B("NOTE", "K1")}\nx\n${E("ANNO", "K1")}\n${E("NOTE", "K1")}`;
    const { regions } = parse(str);
    assertEq(regions.length, 1, "one region (NOTE pairs with NOTE end)");
    assertEq(regions[0]!.type, "NOTE", "type");
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
