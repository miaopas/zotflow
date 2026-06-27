import { AbstractInputSuggest, Modal, setIcon, Setting } from "obsidian";

import type { App } from "obsidian";
import type { TagInput } from "worker/services/tag";

/** Options for {@link TagEditModal}. */
export interface TagEditModalOptions {
    /** Human-readable title of the item being edited (shown as a subtitle). */
    itemTitle: string;
    /** The item's current tags. */
    initialTags: TagInput[];
    /** All known tag names across active libraries, for autocomplete. */
    suggestions: string[];
    /** Called with the final tag list when the user saves. */
    onSave: (tags: TagInput[]) => Promise<void> | void;
}

/**
 * Obsidian-native autocomplete for the tag input. Suggests known Zotero tag
 * names, excludes tags already on the item, and offers raw typed text as a
 * create-new option.
 */
class TagInputSuggest extends AbstractInputSuggest<string> {
    constructor(
        app: App,
        private readonly inputEl: HTMLInputElement,
        private readonly getAllSuggestions: () => string[],
        private readonly getExisting: () => string[],
        private readonly onChoose: (value: string) => void,
    ) {
        super(app, inputEl);
    }

    getSuggestions(query: string): string[] {
        const q = query.trim().toLowerCase();
        const existing = new Set(
            this.getExisting().map((t) => t.toLowerCase()),
        );

        const matches = this.getAllSuggestions()
            .filter((name) => {
                const lower = name.toLowerCase();
                if (existing.has(lower)) return false;
                return q === "" || lower.includes(q);
            })
            .sort((a, b) =>
                a.localeCompare(b, undefined, {
                    sensitivity: "accent",
                }),
            );

        // Offer a "create" entry when the typed text isn't an existing or
        // already-added tag.
        const raw = query.trim();
        if (
            raw !== "" &&
            !existing.has(raw.toLowerCase()) &&
            !matches.some((m) => m.toLowerCase() === raw.toLowerCase())
        ) {
            matches.unshift(raw);
        }

        return matches;
    }

    renderSuggestion(value: string, el: HTMLElement): void {
        el.addClass("zotflow-tag-suggestion");
        el.setText(value);
    }

    selectSuggestion(value: string): void {
        this.onChoose(value);
        this.inputEl.value = "";
        this.inputEl.focus();
        this.close();
    }

    open(): void {
        super.open();

        // AbstractInputSuggest sizes its popover to the content; constrain it
        // to the input width instead. `suggestEl` is the (undocumented)
        // popover container created by PopoverSuggest.
        const el = (this as unknown as { suggestEl?: HTMLElement }).suggestEl;
        if (el) {
            el.style.width = `${this.inputEl.offsetWidth}px`;
            el.style.maxWidth = `${this.inputEl.offsetWidth}px`;
        }
    }
}

/**
 * Modal for editing the tags of a single Zotero item (regular item,
 * attachment, or child note). Renders existing tags as removable chips and
 * provides an autocompleting input for adding new tags.
 */
export class TagEditModal extends Modal {
    private tags: TagInput[];
    private readonly options: TagEditModalOptions;

    private chipsEl!: HTMLElement;
    private inputEl!: HTMLInputElement;
    private saving = false;

    constructor(app: App, options: TagEditModalOptions) {
        super(app);
        this.options = options;
        // Clone so we never mutate the caller's array.
        this.tags = options.initialTags.map((t) => ({ ...t }));
        this.modalEl.addClass("zotflow-tag-edit-modal");
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;

        titleEl.setText("Edit tags");

        if (this.options.itemTitle) {
            contentEl.createDiv({
                cls: "zotflow-tag-edit-subtitle",
                text: this.options.itemTitle,
            });
        }

        this.chipsEl = contentEl.createDiv({ cls: "zotflow-tag-edit-chips" });

        const inputRow = contentEl.createDiv({ cls: "zotflow-tag-edit-row" });
        this.inputEl = inputRow.createEl("input", {
            cls: "zotflow-tag-edit-input",
            type: "text",
            placeholder: "Add a tag and press Enter…",
        });

        new TagInputSuggest(
            this.app,
            this.inputEl,
            () => this.options.suggestions,
            () => this.tags.map((t) => t.tag),
            (value) => this.addTag(value),
        );

        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.addTagFromInput();
            } else if (
                e.key === "Backspace" &&
                this.inputEl.value === "" &&
                this.tags.length > 0
            ) {
                // Quick-delete the last chip when input is empty.
                this.tags.pop();
                this.renderChips();
            }
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Save")
                    .setCta()
                    .onClick(() => void this.save()),
            );

        this.renderChips();
        window.setTimeout(() => this.inputEl.blur(), 0);
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private addTag(name: string): void {
        const trimmed = name.trim();
        if (!trimmed) return;
        // Case-sensitive dedupe to match Zotero semantics.
        if (!this.tags.some((t) => t.tag === trimmed)) {
            this.tags.push({ tag: trimmed });
            this.renderChips();
        }
    }

    private addTagFromInput(): void {
        this.addTag(this.inputEl.value);
        this.inputEl.value = "";
    }

    private renderChips(): void {
        this.chipsEl.empty();

        if (this.tags.length === 0) {
            this.chipsEl.createDiv({
                cls: "zotflow-tag-edit-empty",
                text: "No tags yet.",
            });
            return;
        }

        for (const entry of this.tags) {
            const chip = this.chipsEl.createDiv({
                cls: "zotflow-tag-edit-chip",
            });
            if (entry.type === 1) chip.addClass("is-automatic");

            chip.createSpan({
                cls: "zotflow-tag-edit-chip-label",
                text: entry.tag,
            });
            const remove = chip.createSpan({
                cls: "zotflow-tag-edit-chip-remove",
            });
            setIcon(remove, "x");
            remove.setAttribute("aria-label", `Remove tag ${entry.tag}`);
            remove.addEventListener("click", () => {
                this.tags = this.tags.filter((t) => t !== entry);
                this.renderChips();
            });
        }
    }

    private async save(): Promise<void> {
        if (this.saving) return;
        this.saving = true;

        // Commit any text still sitting in the input.
        this.addTagFromInput();

        try {
            await this.options.onSave(this.tags);
            this.close();
        } finally {
            this.saving = false;
        }
    }
}
