import { describe, expect, it, vi } from "vitest";

const activatePiExtension = vi.hoisted(() => vi.fn());

vi.mock("resume-from", () => ({ activatePiExtension }));

type EntryRenderer = (
  entry: { data?: unknown },
  options: { expanded: boolean },
  theme: { bg(name: string, text: string): string },
) => { render(width: number): string[]; invalidate(): void };
type ShimFactory = (pi: {
  registerEntryRenderer(customType: string, renderer: EntryRenderer): void;
  registerCommand(name: string, definition: unknown): void;
}) => void;

type OuterCommandContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(message: string, level: string): void;
    confirm(title: string, question: string): Promise<boolean>;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
  switchSession(path: string, options: unknown): Promise<unknown>;
};

type OuterCommandHandler = (rawArgs: string, context: OuterCommandContext) => Promise<void>;
type MockPiActivation = {
  home: string | null;
  picker?: {
    pick(listing: unknown): Promise<{ choice: string; selected: unknown }>;
  };
  registrar: {
    registerCommand(definition: { name: string; description: string; run: unknown }): void;
  };
};

async function loadOuterCommand(): Promise<OuterCommandHandler> {
  const shimUrl = new URL("../../../shims/pi/extensions/resume-from.js", import.meta.url).href;
  const module = (await import(shimUrl)) as { default: ShimFactory };
  let handler: OuterCommandHandler | undefined;

  module.default({
    registerEntryRenderer() {},
    registerCommand(_name, definition) {
      handler = (definition as { handler: OuterCommandHandler }).handler;
    },
  });

  if (handler === undefined) throw new Error("resume-from shim did not register its command");
  return handler;
}

describe("Pi package shim provenance", () => {
  it("registers provenance as a transcript renderer instead of a persistent widget", async () => {
    const shimUrl = new URL("../../../shims/pi/extensions/resume-from.js", import.meta.url).href;
    const module = (await import(shimUrl)) as { default: ShimFactory };
    let renderer: EntryRenderer | undefined;

    module.default({
      registerEntryRenderer(customType, candidate) {
        expect(customType).toBe("resume-from-provenance");
        renderer = candidate;
      },
      registerCommand() {},
    });

    const render = (lines: string[], expanded: boolean) =>
      renderer?.({ data: { lines } }, { expanded }, { bg: (_name, text) => text });
    const lines = ["Imported from pi", "Source session: source-1", "Dropped: 57"];

    expect(renderer).toBeDefined();
    expect(render(lines, false)?.render(80)).toEqual(["Imported from pi · Dropped: 57"]);
    expect(render(lines, true)?.render(80)).toEqual(lines);

    const unsafe = render(["Imported from pi\u001b[31m", "Dropped: 57"], true);
    expect(unsafe?.render(80)[0]).toBe("Imported from pi ");
    expect(unsafe?.render(10)).toEqual(["Imported f\u001b[0m", "Dropped: 5\u001b[0m"]);

    expect(render(["界界界界界", "Dropped: 57"], true)?.render(5)).toEqual([
      "界界\u001b[0m",
      "Dropp\u001b[0m",
    ]);
  });
});

function outerContext(): OuterCommandContext {
  return {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      select: vi.fn().mockResolvedValue(undefined),
    },
    switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
  };
}

function registerRun(run: unknown): void {
  activatePiExtension.mockImplementation(async (deps: MockPiActivation) => {
    deps.registrar.registerCommand({ name: "resume-from", description: "test", run });
  });
}

describe("Pi package shim picker", () => {
  it("groups the listing by path and offers the paths alone", async () => {
    let picker: MockPiActivation["picker"];
    activatePiExtension.mockImplementation(async (deps: MockPiActivation) => {
      picker = deps.picker;
      deps.registrar.registerCommand({
        name: "resume-from",
        description: "test",
        run: vi.fn().mockResolvedValue(undefined),
      });
    });

    const handler = await loadOuterCommand();
    const select = vi.fn().mockResolvedValue("/repo/worktree");
    const context = outerContext();
    context.ui.select = select;

    await handler("", context);

    const session = (id: string, startDirectory: string) => ({
      ref: { agent: "pi", home: "/Users/me/.pi", id },
      title: id,
      startedAt: "2026-08-01T09:00:00Z",
      updatedAt: "2026-08-01T10:00:00Z",
      turnCount: 7,
      repoPath: startDirectory,
      repoPaths: [startDirectory],
      startDirectory,
      filePath: `/Users/me/.pi/sessions/${id}.jsonl`,
    });
    const picked = await picker?.pick({
      rows: [session("s-1", "/repo"), session("s-2", "/repo/worktree"), session("s-3", "/repo")],
      failures: [],
      excluded: 0,
    });

    expect(select).toHaveBeenCalledWith("Select a path to import", ["/repo", "/repo/worktree"]);
    expect(picked?.choice).toBe("selected");
    expect(picked?.selected).toMatchObject({
      path: "/repo/worktree",
      sessions: [{ ref: { id: "s-2" } }],
    });
  });
});

describe("Pi package shim command boundary", () => {
  it("uses one absolute home and preserves a path containing spaces as one argument", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "relative-pi-home";
    const run = vi.fn().mockResolvedValue(undefined);
    registerRun(run);

    try {
      const handler = await loadOuterCommand();
      await handler(" sessions/my session.jsonl ", outerContext());

      const activation = activatePiExtension.mock.calls.at(-1)?.[0] as MockPiActivation | undefined;
      expect(activation?.home).toMatch(/\/relative-pi-home$/);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0].home).toBe(activation?.home);
      expect(run.mock.calls[0]?.[1]).toEqual(["sessions/my session.jsonl"]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("ends quietly when Pi invalidates the command context mid-run", async () => {
    registerRun(
      vi
        .fn()
        .mockRejectedValue(
          new Error("This extension ctx is stale after session replacement or reload."),
        ),
    );
    const handler = await loadOuterCommand();

    await expect(handler(" cx-1 ", outerContext())).resolves.toBeUndefined();
  });

  it("still surfaces failures that are not Pi's stale-context error", async () => {
    const failure = new Error("the import pipeline exploded");
    registerRun(vi.fn().mockRejectedValue(failure));
    const handler = await loadOuterCommand();

    await expect(handler(" cx-1 ", outerContext())).rejects.toBe(failure);
  });
});
