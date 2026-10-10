import type {
  AgentRunRequest,
  AutoReviewProvider,
  ConnectorCall,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import { MAX_SHARED_MEMORY_CHARS } from "./builtin-tools.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { FinancialExecution } from "./financial-execution.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const reviewMock = vi.fn();
const autoReviewProvider: AutoReviewProvider = {
  describe: () => ({
    id: "mock",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: { offline: true, keyless: true },
  }),
  review: reviewMock,
};

type Effect = {
  id: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
  runId?: string;
};

function fixture({
  name = "demo_get_item",
  catalog = false,
  readOnly = true,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  trigger = "user",
  secrets = [] as string[],
  prompt = "Read the item",
  bot = {
    name: "Assistant",
    title: "Assistant",
    description: "Test assistant",
  },
  shutdownSignal,
  builtin = false,
  tradingProduct = false,
  mainFinancialPrincipal = false,
  disabledBuiltinTools = [],
  existingSharedMemory,
  advanceRevisionAfterRead = false,
}: {
  builtin?: boolean;
  tradingProduct?: boolean;
  mainFinancialPrincipal?: boolean;
  disabledBuiltinTools?: string[];
  existingSharedMemory?: string;
  /** Simulates another writer landing between the save's read and its commit. */
  advanceRevisionAfterRead?: boolean;
  name?: string;
  catalog?: boolean;
  readOnly?: boolean;
  rules?: ActionApprovalRule[];
  autoReview?: boolean;
  trigger?: string;
  secrets?: string[];
  prompt?: string;
  bot?: { name: string; title: string; description: string };
  shutdownSignal?: AbortSignal;
} = {}) {
  const tool: ConnectorTool = {
    name,
    description: "Read an item",
    readOnly,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    route: { connectorId: "demo", resourceId: "resource-1", toolName: name },
  };
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const sharedMemoryState = {
    content: existingSharedMemory as string | undefined,
    revision: existingSharedMemory === undefined ? 0 : 1,
  };
  const commit = vi.fn(
    async (request: { path: string; content: string; expectedRevision?: number }) => {
      if (
        request.expectedRevision !== undefined &&
        request.expectedRevision !== sharedMemoryState.revision
      ) {
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      }
      sharedMemoryState.content = request.content;
      sharedMemoryState.revision = (sharedMemoryState.revision || 0) + 1;
      return {
        id: "doc-1",
        path: request.path,
        revision: sharedMemoryState.revision,
        content: request.content,
      };
    },
  );
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    leaseFence: 0,
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: string | { in: string[] } };
        data: Partial<Effect>;
      }) => {
        const effect = effects.find(
          (effect) =>
            effect.id === where.id &&
            (typeof where.status === "string"
              ? effect.status === where.status
              : where.status.in.includes(effect.status)),
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        spaceId: run.spaceId,
        spawnKey: mainFinancialPrincipal ? "trading:main:v1" : null,
        name: bot.name,
        title: bot.title,
        description: bot.description,
        disabledBuiltinTools,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        singleOwnerEnforced: tradingProduct,
        ownerSpaceId: "space-1",
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: autoReview })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let calls: { args: Record<string, unknown>; executionId: string }[] = [
    { args: { id: "item-1" }, executionId: "call-1" },
  ];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(
        catalog ? "demo_execute_tool" : name,
        catalog ? { id: `resource-1:${name}`, arguments: call.args } : call.args,
        call.executionId,
      );
      results.push(result);
      if (isApprovalPausedResult(result)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () =>
        builtin
          ? []
          : catalog
            ? [
                {
                  name: "demo_execute_tool",
                  description: "Execute a catalog tool",
                  inputSchema: { type: "object" },
                  route: { connectorId: "demo", toolName: "__catalog_execute" },
                },
              ]
            : [tool],
      resolveCall: async (call: ConnectorCall) =>
        catalog ? resolveCatalogCall(call, catalogEntries([tool])) : undefined,
      execute,
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      read: async (request: { scope: string; path?: string }) => {
        const documents =
          request.scope === "user" &&
          request.path === "MEMORY.md" &&
          sharedMemoryState.content !== undefined
            ? [
                {
                  id: "doc-1",
                  path: "MEMORY.md",
                  content: sharedMemoryState.content,
                  revision: sharedMemoryState.revision,
                  updatedAt: "",
                },
              ]
            : [];
        if (advanceRevisionAfterRead && request.path === "MEMORY.md") {
          sharedMemoryState.content = "Someone else edited";
          sharedMemoryState.revision += 1;
        }
        return { documents };
      },
      commit,
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
    autoReview: autoReviewProvider,
    shutdownSignal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    effects,
    results,
    execute,
    commit,
    sharedMemoryState,
    pauseRunForInput,
    setCalls(next: typeof calls) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("disabled builtins", () => {
  it("refuses a direct call before any effect or memory write", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      disabledBuiltinTools: ["save_shared_memory", "unknown"],
    });
    f.setCalls([{ args: { content: "Must not be saved" }, executionId: "call-1" }]);
    await f.run();
    expect(f.results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  });
});

describe("domain-owned financial tool dispatch", () => {
  it("routes any eligible Agent execution through the financial handler even with generic review disabled/always-allow", async () => {
    const service = vi.spyOn(FinancialExecution.prototype, "execute").mockResolvedValue({
      effectId: "financial",
      status: "SUCCEEDED",
      mode: "SIMULATION",
      providerReference: "sim_financial",
    });
    try {
      const f = fixture({
        name: "trade_execute",
        builtin: true,
        tradingProduct: true,
        mainFinancialPrincipal: true,
        autoReview: false,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "trade_execute" }],
      });
      f.setCalls([
        { args: { proposalId: "proposal", previewId: "preview" }, executionId: "execute" },
      ]);
      await f.run();
      expect(service).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: "user-1",
          botId: "bot-1",
          execution: expect.objectContaining({ runId: "run-1" }),
        }),
        { proposalId: "proposal", previewId: "preview" },
        autoReviewProvider,
        expect.anything(),
        expect.any(Array),
      );
      expect(f.effects).toEqual([]); // The domain, not the generic executor, owns its effect.
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results[0]).toMatchObject({ status: "SUCCEEDED", mode: "SIMULATION" });
    } finally {
      service.mockRestore();
    }
  });
  it("dispatches a normal peer through its own financial handler", async () => {
    const service = vi.spyOn(FinancialExecution.prototype, "execute").mockResolvedValue({
      effectId: "peer-effect",
      status: "SUCCEEDED",
      mode: "SIMULATION",
      providerReference: "sim_peer",
    });
    try {
      const f = fixture({ name: "trade_execute", builtin: true, tradingProduct: true });
      f.setCalls([
        { args: { proposalId: "proposal", previewId: "preview" }, executionId: "execute" },
      ]);
      await f.run();
      expect(service).toHaveBeenCalledWith(
        expect.objectContaining({ botId: "bot-1" }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(f.effects).toEqual([]);
      expect(f.results[0]).toMatchObject({ status: "SUCCEEDED" });
    } finally {
      service.mockRestore();
    }
  });
  it("uses the existing pause/card path for a mandatory financial escalation", async () => {
    const ask = {
      kind: "ask" as const,
      approvalEffectId: "financial",
      text: "Review simulation action",
      status: "pending" as const,
      actions: [
        { id: "allow", label: "Approve once" },
        { id: "deny", label: "Deny" },
      ],
    };
    const service = vi.spyOn(FinancialExecution.prototype, "execute").mockResolvedValue({
      effectId: "financial",
      status: "APPROVAL_REQUIRED",
      mode: "SIMULATION",
      ask,
    });
    try {
      const f = fixture({
        name: "trade_execute",
        builtin: true,
        tradingProduct: true,
        mainFinancialPrincipal: true,
      });
      f.setCalls([
        { args: { proposalId: "proposal", previewId: "preview" }, executionId: "execute" },
      ]);
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(expect.objectContaining({ blocks: [ask] }));
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(f.effects).toEqual([]);
    } finally {
      service.mockRestore();
    }
  });
});

describe("connector read-only metadata and approval enforcement", () => {
  beforeEach(() => {
    reviewMock.mockReset();
  });

  it.each(["shell", "write_file"])(
    "forces owner approval for webhook-triggered %s despite an allow rule",
    async (name) => {
      const f = fixture({
        name,
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    },
  );

  it("writes shared memory directly, including when an always-allow rule exists", async () => {
    const args = { path: " MEMORY.md ", content: "Printing: all print jobs go to Clyde." };
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      autoReview: true,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "save_shared_memory" }],
    });
    f.setCalls([{ args, executionId: "call-1" }]);
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(reviewMock).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "user",
        path: "MEMORY.md",
        content: args.content,
        expectedRevision: 0,
      }),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
    expect(f.commit.mock.calls[0]![0]).not.toHaveProperty("botId");
    expect(f.results.at(-1)).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
  });

  it("replaces an existing shared document at the revision it just read", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      existingSharedMemory: "Old rule",
    });
    f.setCalls([{ args: { path: "MEMORY.md", content: "New rule" }, executionId: "call-1" }]);
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: "New rule", expectedRevision: 1 }),
      expect.anything(),
    );
    expect(f.results.at(-1)).toEqual({ ok: true, path: "MEMORY.md", revision: 2 });
  });

  it("does not overwrite shared memory that changed after it was read", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      existingSharedMemory: "Old rule",
      advanceRevisionAfterRead: true,
    });
    f.setCalls([{ args: { path: "MEMORY.md", content: "New rule" }, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1 }),
      expect.anything(),
    );
    expect(f.sharedMemoryState.content).toBe("Someone else edited");
    expect(f.results.at(-1)).toEqual({ error: MEMORY_REVISION_CONFLICT_ERROR });
  });

  it("rejects shared memory content over the size limit", async () => {
    const args = {
      path: "MEMORY.md",
      content: "x".repeat(MAX_SHARED_MEMORY_CHARS + 1),
    };
    const f = fixture({ name: "save_shared_memory", builtin: true });
    f.setCalls([{ args, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({
      error: `content exceeds ${MAX_SHARED_MEMORY_CHARS} characters`,
    });
  });

  it("rejects a shared memory save without a path", async () => {
    const f = fixture({ name: "save_shared_memory", builtin: true });
    f.setCalls([{ args: { path: "  ", content: "ok" }, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({ error: "path is required" });
  });

  describe.each([false, true])("catalog = %s", (catalog) => {
    it.each(["tool", "connector"] as const)(
      "honors an explicit %s approval rule",
      async (matchKind) => {
        const f = fixture({
          catalog,
          autoReview: true,
          rules: [
            {
              effect: "require_approval",
              matchKind,
              matchValue: matchKind === "tool" ? "demo_get_item" : "demo",
            },
          ],
        });
        await f.run();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.pauseRunForInput).toHaveBeenCalledOnce();
        expect(f.pauseRunForInput).toHaveBeenCalledWith(
          expect.objectContaining({
            blocks: [expect.objectContaining({ kind: "ask", approvalEffectId: f.effects[0]!.id })],
          }),
        );
        expect(isApprovalPausedResult(f.results[0])).toBe(true);
        expect(reviewMock).not.toHaveBeenCalled();
      },
    );

    it("replays the approved arguments once and returns the result on retry", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: { id: "item-1" },
          executionId: approvalEffectKey("run-1", "demo_get_item", { id: "item-1" }),
        }),
        expect.anything(),
      );
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("executes a later identical-args call after an approved replay when approval is not required by default", async () => {
      const args = { id: "item-1" };
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([
        { args, executionId: "call-2" },
        { args, executionId: "call-3" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.effects).toHaveLength(2);
      expect(f.effects[0]?.idempotencyKey).toBe(approvalEffectKey("run-1", "demo_get_item", args));
      expect(f.effects[1]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", args, 1),
      );
      expect(f.results.slice(1)).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("honors a persisted denial on a new tool call id", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "denied";
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toEqual({
        error:
          "The user denied this action. Do not retry or rephrase it; tell the user and ask what they want instead.",
      });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("consumes the saved approval after the user chooses always allow", async () => {
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("allows ordinary reads without approval or automatic review", async () => {
      const f = fixture({ catalog, autoReview: true });
      f.setCalls([
        { args: { id: "item-1" }, executionId: "call-1" },
        { args: { id: "item-1" }, executionId: "call-2" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.results).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("replays a non-approval connector effect when the tool-call id changes", async () => {
      const f = fixture({ catalog });
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-1" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects[0]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", { id: "item-1" }),
      );

      f.setCalls([{ args: { id: "item-1" }, executionId: "call-new" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
    });

    it("keeps an explicit allow rule ahead of automatic review", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("forces owner approval for webhook-triggered writes despite an allow rule", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("forces owner approval for a webhook-triggered read-named write operation", async () => {
      const f = fixture({
        catalog,
        name: "demo_read_profile_card",
        readOnly: false,
        trigger: "webhook",
        rules: [
          { effect: "always_allow", matchKind: "tool", matchValue: "demo_read_profile_card" },
        ],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
    });

    it("lets a webhook-triggered declared read run unattended", async () => {
      const f = fixture({ catalog, trigger: "webhook" });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it("treats a read-named write operation as consequential for automatic review", async () => {
      reviewMock.mockResolvedValue({ decision: "ask", reason: "Writes data", model: "mock" });
      const f = fixture({
        catalog,
        name: "demo_find_validator_record",
        readOnly: false,
        autoReview: true,
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledOnce();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it.each(["ask", "error", "pass", "deny"] as const)(
      "honors automatic review %s despite a read-only hint",
      async (decision) => {
        reviewMock.mockResolvedValue({
          decision,
          reason: "Review result",
          model: "scripted/checker",
        });
        const f = fixture({ catalog, name: "demo_send_message", autoReview: true });
        await f.run();
        expect(reviewMock).toHaveBeenCalledOnce();
        expect(reviewMock).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: "demo_send_message", connectorKind: "demo" }),
          expect.objectContaining({ runId: "run-1" }),
        );
        expect(f.effects[0]?.reviewDecision).toBe(decision);
        expect(f.execute).toHaveBeenCalledTimes(decision === "pass" ? 1 : 0);
        expect(f.pauseRunForInput).toHaveBeenCalledTimes(
          decision === "ask" || decision === "error" ? 1 : 0,
        );
        if (decision === "deny") {
          expect(f.effects[0]?.status).toBe("denied");
          expect(f.results.at(-1)).toEqual({ error: "Independent review denied this action." });
          reviewMock.mockResolvedValue({ decision: "pass", model: "fixture" });
          f.setCalls([{ args: { id: "item-1" }, executionId: "call-2" }]);
          await f.run();
          expect(f.execute).not.toHaveBeenCalled();
          expect(f.effects).toHaveLength(1);
          expect(f.effects[0]?.status).toBe("denied");
        }
      },
    );

    it("redacts run secrets from automatic review task and bot context", async () => {
      reviewMock.mockResolvedValue({ decision: "pass", model: "mock" });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        secrets: ["super-secret-token"],
        prompt: "Send mail with super-secret-token",
        bot: {
          name: "Mail",
          title: "Helper",
          description: "Uses super-secret-token",
        },
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userTask: "Send mail with [redacted]",
          botDescription: "Mail: Helper\nUses [redacted]",
        }),
        expect.objectContaining({ runId: "run-1" }),
      );
    });

    it("does not persist a review decision when the run is cancelled", async () => {
      const shutdown = new AbortController();
      reviewMock.mockImplementation(async () => {
        shutdown.abort();
        return { decision: "error", reason: "Checker timed out or failed.", model: "mock" };
      });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        shutdownSignal: shutdown.signal,
      });
      await f.run();
      expect(f.effects[0]?.reviewDecision).toBeUndefined();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });
  });
});

describe("mandatory support review precedes approval rules", () => {
  it.each([false, true])(
    "allows reviewed ordinary connector work with generic review disabled (catalog=%s)",
    async (catalog) => {
      reviewMock.mockResolvedValueOnce({
        decision: "pass",
        model: "fixture",
        reason: "Nonfinancial research",
      });
      const f = fixture({
        tradingProduct: true,
        catalog,
        autoReview: false,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ connectorKind: "trading_support", matchingRules: [] }),
        expect.anything(),
      );
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );

  beforeEach(() => vi.clearAllMocks());
  it.each([false, true])(
    "blocks connector execution when independent support review fails, even with allow rule (catalog=%s)",
    async (catalog) => {
      const f = fixture({
        tradingProduct: true,
        name: "demo_get_item",
        readOnly: true,
        catalog,
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(reviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ connectorKind: "trading_support", matchingRules: [] }),
        expect.anything(),
      );
      expect(f.effects).toHaveLength(0);
      expect(f.results.at(-1)).toEqual({
        error: expect.stringContaining("could not exclude a financial bypass"),
      });
    },
  );
  it("rejects shell financial bypass even when user approval rules say always allow", async () => {
    const f = fixture({
      tradingProduct: true,
      name: "shell",
      builtin: true,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "shell" }],
    });
    f.setCalls([{ args: { command: "curl broker.invalid/trade" }, executionId: "call-1" }]);
    await f.run();
    expect(f.effects).toHaveLength(0);
    expect(reviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ connectorKind: "trading_support", matchingRules: [] }),
      expect.anything(),
    );
    expect(f.results.at(-1)).toEqual({
      error: expect.stringContaining("could not exclude a financial bypass"),
    });
  });
});
