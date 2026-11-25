import { describe, expect, it } from "vitest";
import type { AgentId, Listing, SessionDescriptor } from "./contract.js";
import { createKeyPicker, groupByPath, type KeySource, type PickerKey } from "./picker.js";
import type { PiUi } from "./ui.js";

function descriptor(
  over: Partial<SessionDescriptor> & { agent?: AgentId; id?: string; home?: string },
): SessionDescriptor {
  const agent = over.agent ?? "pi";
  return {
    ref: {
      agent,
      home: over.home ?? over.ref?.home ?? "/Users/me/.pi",
      id: over.id ?? over.ref?.id ?? "s-1",
    },
    title: over.title ?? "Some session",
    startedAt: over.startedAt ?? "2026-08-01T09:00:00Z",
    updatedAt: over.updatedAt ?? "2026-08-01T10:00:00Z",
    turnCount: over.turnCount ?? 7,
    repoPath: over.repoPath ?? "/repo",
    repoPaths: over.repoPaths ?? [over.repoPath ?? "/repo"],
    startDirectory: over.startDirectory ?? over.repoPath ?? "/repo",
    filePath: over.filePath ?? "/Users/me/.pi/sessions/s-1.json",
  };
}

function listing(rows: SessionDescriptor[]): Listing {
  return { rows, failures: [], excluded: 0 };
}

function keys(sequence: PickerKey[]): KeySource {
  let index = 0;
  return {
    async next() {
      const key = sequence[index];
      index += 1;
      return key ?? null;
    },
  };
}

function recordingUi(): { ui: PiUi; blocks: string[][] } {
  const blocks: string[][] = [];
  const ui: PiUi = {
    show(lines) {
      blocks.push([...lines]);
    },
    async confirm() {
      throw new Error("the picker must not ask for a confirmation");
    },
  };
  return { ui, blocks };
}

describe("T-PIX-2 — the picker shows one path per workspace", () => {
  it("shows the path of every workspace and nothing else", async () => {
    const rows = [
      descriptor({
        id: "pi-1",
        title: "Refactor the parser",
        updatedAt: "2026-08-03T12:00:00Z",
        turnCount: 41,
        startDirectory: "/repo",
      }),
      descriptor({
        agent: "codex",
        home: "/Users/me/.codex",
        id: "cx-1",
        title: "Chase the flaky test",
        updatedAt: "2026-08-02T08:30:00Z",
        turnCount: 12,
        startDirectory: "/repo/worktree",
      }),
      descriptor({
        agent: "claude-code",
        home: "/Users/me/.claude-team",
        id: "cc-1",
        title: "Write the release notes",
        updatedAt: "2026-08-01T20:15:00Z",
        turnCount: 3,
        startDirectory: "/repo/worktree",
      }),
    ];
    const { ui, blocks } = recordingUi();

    await createKeyPicker({ keys: keys(["down", "enter"]), ui }).pick(listing(rows));

    const shown = blocks.flat();
    expect(shown).toContain("> /repo");
    expect(shown).toContain("> /repo/worktree");
    const text = shown.join("\n");
    for (const row of rows) {
      for (const absent of [row.title, row.ref.home, row.updatedAt, String(row.turnCount)]) {
        expect(text).not.toContain(absent);
      }
    }
  });

  it("groups the sessions of one workspace under that path", () => {
    const rows = [
      descriptor({ id: "s-1", startDirectory: "/repo" }),
      descriptor({
        agent: "codex",
        home: "/Users/me/.codex",
        id: "s-2",
        startDirectory: "/repo/worktree",
      }),
      descriptor({ id: "s-3", startDirectory: "/repo" }),
    ];

    const groups = groupByPath(rows);

    expect(groups.map((group) => group.path)).toEqual(["/repo", "/repo/worktree"]);
    expect(groups[0]?.sessions.map((session) => session.ref.id)).toEqual(["s-1", "s-3"]);
    expect(groups[1]?.sessions.map((session) => session.ref.id)).toEqual(["s-2"]);
  });

  it("falls back to the recorded directory when a session records no start", () => {
    const row = descriptor({ repoPath: "/repo", repoPaths: ["/repo"], startDirectory: null });

    expect(groupByPath([row])[0]?.path).toBe("/repo");
  });

  it("prefers the directory the session started in over the first one it recorded", () => {
    const row = descriptor({ startDirectory: "/repo/worktree" });

    expect(groupByPath([row])[0]?.path).toBe("/repo/worktree");
  });

  it("falls back to the session file's directory when the session records none", () => {
    const row = {
      ...descriptor({ filePath: "/Users/me/.pi/sessions/s-1.jsonl" }),
      repoPath: null,
      repoPaths: [],
      startDirectory: null,
    };

    expect(groupByPath([row])[0]?.path).toBe("/Users/me/.pi/sessions");
  });
});

describe("T-PIX-3 — arrow keys move and Enter selects", () => {
  it("selects the second path after down, Enter", async () => {
    const rows = [
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: "s-1" }, startDirectory: "/a" }),
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: "s-2" }, startDirectory: "/b" }),
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: "s-3" }, startDirectory: "/c" }),
    ];
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys(["down", "enter"]), ui }).pick(listing(rows));

    expect(result.choice).toBe("selected");
    expect(result.selected?.path).toBe("/b");
    expect(result.selected?.sessions.map((session) => session.ref.id)).toEqual(["s-2"]);
  });

  it("selects every session of the chosen path", async () => {
    const rows = [
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: "s-1" }, startDirectory: "/a" }),
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: "s-2" }, startDirectory: "/a" }),
    ];
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys(["enter"]), ui }).pick(listing(rows));

    expect(result.selected?.sessions.map((session) => session.ref.id)).toEqual(["s-1", "s-2"]);
  });

  it("stops at the first path and at the last path", async () => {
    const rows = [
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: "s-1" }, startDirectory: "/a" }),
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: "s-2" }, startDirectory: "/b" }),
    ];
    const { ui } = recordingUi();

    const top = await createKeyPicker({ keys: keys(["up", "up", "enter"]), ui }).pick(
      listing(rows),
    );
    const bottom = await createKeyPicker({
      keys: keys(["down", "down", "down", "enter"]),
      ui,
    }).pick(listing(rows));

    expect(top.selected?.path).toBe("/a");
    expect(bottom.selected?.path).toBe("/b");
  });
});

describe("T-PIX-4 — Escape cancels", () => {
  it("reports a cancelled choice and selects nothing", async () => {
    const rows = [descriptor({})];
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys(["down", "escape"]), ui }).pick(
      listing(rows),
    );

    expect(result.choice).toBe("cancelled");
    expect(result.selected).toBeNull();
  });

  it("treats an exhausted key source as a cancel", async () => {
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys([]), ui }).pick(listing([descriptor({})]));

    expect(result.choice).toBe("cancelled");
    expect(result.selected).toBeNull();
  });

  it("cancels over an empty listing", async () => {
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys(["enter"]), ui }).pick(listing([]));

    expect(result.choice).toBe("cancelled");
    expect(result.selected).toBeNull();
  });
});
