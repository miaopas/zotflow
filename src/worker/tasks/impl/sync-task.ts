import { BaseTask } from "../base";
import { db } from "db/db";
import type { SyncService } from "worker/services/sync";
import type { LibraryNoteService } from "worker/services/library-note";
import type { TaskManager } from "../manager";
import type { ZotFlowSettings } from "settings/types";
import type { TaskStatus } from "types/tasks";
import type { ItemIdentifier } from "./batch-extract-images-task";

/** Tracked background task that runs a full or library-scoped sync cycle. */
export class SyncTask extends BaseTask {
    constructor(
        private syncService: SyncService,
        private libraryId?: number,
        private taskManager?: TaskManager,
        private libraryNoteService?: LibraryNoteService,
        private settings?: ZotFlowSettings,
    ) {
        super("sync");
        this.displayText = libraryId
            ? `Syncing Library ${libraryId}`
            : "Syncing Libraries";
    }

    protected async run(signal: AbortSignal): Promise<void> {
        // Populate input context for Activity Center display
        if (this.libraryId !== undefined) {
            const lib = await db.libraries.get(this.libraryId);
            this.taskInput = {
                library: lib?.name ?? String(this.libraryId),
                libraryId: this.libraryId,
            };
            if (lib) {
                this.displayText = `Syncing: ${lib.name}`;
            }
        } else {
            this.taskInput = { scope: "all" };
        }

        this.reportProgress(0, 1, "Starting sync...");

        const { successCount, failCount, changedItems } =
            await this.syncService.startSync(
                signal,
                (completed, total, message) => {
                    this.reportProgress(completed, total, message);
                },
                this.libraryId,
            );

        this.result = {
            successCount,
            failCount,
            details: {
                libraries: successCount + failCount,
                synced: successCount,
                failed: failCount,
                changedItems: changedItems.length,
            },
        };

        // Auto-update source notes for changed items, if enabled.
        if (
            !signal.aborted &&
            this.settings?.autoUpdateSourceNotesAfterSync &&
            this.taskManager &&
            this.libraryNoteService &&
            changedItems.length > 0
        ) {
            try {
                const resolved =
                    await this.resolveNoteBearingItems(changedItems);
                if (resolved.length > 0) {
                    // Fire-and-forget: spawned task is independently tracked.
                    void this.taskManager.createBatchNoteTask(
                        this.libraryNoteService,
                        { items: resolved },
                        {},
                        true,
                    );
                }
            } catch (e) {
                // Never let post-sync chaining fail the sync task itself.
                // (Logging is best-effort; the SyncService already logs sync issues.)
                void e;
            }
        }
    }

    /**
     * Resolve a list of changed item identifiers to the set of items whose
     * source notes should be refreshed. Attachment/note children are swapped
     * for their parent (source notes are top-level only). Items without a
     * note-bearing target are dropped. Result is deduplicated.
     */
    private async resolveNoteBearingItems(
        changed: ItemIdentifier[],
    ): Promise<ItemIdentifier[]> {
        const seen = new Set<string>();
        const out: ItemIdentifier[] = [];

        for (const { libraryID, itemKey } of changed) {
            const item = await db.items.get([libraryID, itemKey]);
            if (!item) continue;

            let targetKey = itemKey;
            if (item.itemType === "attachment" || item.itemType === "note") {
                if (!item.parentItem) continue;
                const parent = await db.items.get([libraryID, item.parentItem]);
                if (
                    !parent ||
                    parent.itemType === "attachment" ||
                    parent.itemType === "note"
                ) {
                    continue;
                }
                targetKey = parent.key;
            }

            const dedupKey = `${libraryID}:${targetKey}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            out.push({ libraryID, itemKey: targetKey });
        }

        return out;
    }

    protected getTerminalDisplayText(status: TaskStatus): string {
        if (status === "cancelled") return "Sync — Cancelled";
        if (status === "failed") return "Sync — Failed";
        const r = this.result;
        if (r && r.failCount > 0) {
            return `Synced ${r.successCount} libraries (${r.failCount} failed)`;
        }
        return `Synced ${r?.successCount ?? 0} libraries`;
    }
}
