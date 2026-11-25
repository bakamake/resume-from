import { dirname, resolve } from "node:path";
import type { PathSelection, PickResult, SessionDescriptor, SessionPicker } from "./contract.js";
import { safeText } from "./presentation.js";
import type { PiUi } from "./ui.js";

/** The keys the picker understands (FR-9). */
export type PickerKey = "up" | "down" | "enter" | "escape";

/** Where the picker takes its keys from. Resolving with null ends the picker. */
export interface KeySource {
  next(): Promise<PickerKey | null>;
}

export interface KeyPickerDeps {
  keys: KeySource;
  ui: PiUi;
}

const HEADER = "Select a path — up/down to move, Enter to select, Escape to cancel:";

/** The workspace a session ran in: where it started, else the directory it recorded first. */
export function pathOf(row: SessionDescriptor): string {
  return resolve(row.startDirectory ?? row.repoPath ?? dirname(row.filePath));
}

/**
 * The listing grouped by path. The groups keep the order of the listing: the group of the
 * newest session comes first, and its sessions run newest first.
 */
export function groupByPath(rows: readonly SessionDescriptor[]): PathSelection[] {
  const groups = new Map<string, SessionDescriptor[]>();
  for (const row of rows) {
    const path = pathOf(row);
    const group = groups.get(path);
    if (group === undefined) groups.set(path, [row]);
    else group.push(row);
  }
  return [...groups].map(([path, sessions]) => ({ path, sessions }));
}

/** One picker entry: the path, and nothing else. */
export function formatEntry(path: string): string {
  return safeText(path);
}

function render(groups: PathSelection[], cursor: number): string[] {
  return [
    HEADER,
    ...groups.map((group, index) => `${index === cursor ? ">" : " "} ${formatEntry(group.path)}`),
  ];
}

const CANCELLED: PickResult = { choice: "cancelled", selected: null };

/** A picker driven by keys: arrow keys move, Enter selects, Escape cancels (FR-9). */
export function createKeyPicker(deps: KeyPickerDeps): SessionPicker {
  return {
    async pick(listing) {
      const groups = groupByPath(listing.rows);
      if (groups.length === 0) return CANCELLED; // A picker over nothing is a trap.
      let cursor = 0;
      for (;;) {
        deps.ui.show(render(groups, cursor));
        const key = await deps.keys.next();
        if (key === null || key === "escape") return CANCELLED;
        if (key === "up") cursor = Math.max(0, cursor - 1);
        else if (key === "down") cursor = Math.min(groups.length - 1, cursor + 1);
        else if (key === "enter") {
          const selected = groups[cursor];
          return selected === undefined ? CANCELLED : { choice: "selected", selected };
        }
      }
    },
  };
}
