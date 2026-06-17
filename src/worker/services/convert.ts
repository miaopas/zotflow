import { unified } from "unified";
import rehypeParse from "rehype-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";

import { html2mdWithProcessors } from "worker/convert/html-to-md";
import { md2htmlWithProcessors } from "worker/convert/md-to-html";
import { annoHtml2md, annoMd2html } from "worker/convert/annotation-comment";

import type { CompileResults, Processor } from "unified";
import type { Node } from "unist";

type GenericProcessor = Processor<
    Node | undefined,
    Node | undefined,
    Node | undefined,
    Node | undefined,
    CompileResults | undefined
>;
import type { Html2MdOptions } from "worker/convert/html-to-md";
import type { ConvertOptions } from "worker/convert/md-to-html";

/**
 * Singleton service that owns the frozen unified processor instances
 * and exposes all HTML ↔ Markdown conversion methods.
 */
export class ConvertService {
    /* Frozen (reusable) processor instances */

    /** rehype parser — HTML string → hast. */
    private readonly rehypeParser: GenericProcessor;

    /** remark stringifier base — hast→mdast output → MD string. */
    private readonly remarkStringifier: GenericProcessor;

    /** remark parser — MD string → mdast. */
    private readonly remarkParser: GenericProcessor;

    /** remark→rehype runner — mdast → hast. */
    private readonly remark2rehypeProc: GenericProcessor;

    /** rehype stringifier — hast → HTML string. */
    private readonly rehypeStringifier: GenericProcessor;

    constructor() {
        this.rehypeParser = unified()
            .use(rehypeParse, { fragment: true })
            .freeze();

        this.remarkStringifier = unified()
            .use(remarkGfm)
            .use(remarkMath)
            .freeze();

        this.remarkParser = unified()
            .use(remarkGfm)
            .use(remarkMath)
            .use(remarkParse)
            .freeze();

        this.remark2rehypeProc = unified()
            .use(remarkRehype, { allowDangerousHtml: true })
            .freeze();

        this.rehypeStringifier = unified()
            .use(rehypeStringify, {
                allowDangerousCharacters: true,
                allowDangerousHtml: true,
            })
            .freeze();
    }

    /* Public API */

    /** Convert Zotero-format note HTML to Markdown. */
    async html2md(html: string, options?: Html2MdOptions): Promise<string> {
        return html2mdWithProcessors(
            html,
            this.rehypeParser,
            this.remarkStringifier,
            options,
        );
    }

    /** Convert Markdown to Zotero-format note HTML. */
    async md2html(md: string, options?: ConvertOptions): Promise<string> {
        return md2htmlWithProcessors(
            md,
            this.remarkParser,
            this.remark2rehypeProc,
            this.rehypeStringifier,
            options,
        );
    }

    /** Convert annotation comment HTML → Markdown (restricted subset). */
    annoHtml2md(html: string): string {
        return annoHtml2md(html);
    }

    /** Convert annotation comment Markdown → HTML (restricted subset). */
    annoMd2html(md: string): string {
        return annoMd2html(md);
    }
}
