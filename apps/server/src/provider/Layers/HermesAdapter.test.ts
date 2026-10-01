// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  hermesPromptSettlementBelongsToContext,
  makeHermesAdapter,
  makeHermesAttachmentPromptPart,
} from "./HermesAdapter.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const HERMES_MOCK_MODELS = "hermes-4:Hermes 4,openai/gpt-5:GPT-5";

/**
 * Stand-in for the `hermes` binary. The wrapper takes `acp` as its argument
 * exactly like the real CLI and execs the shared mock ACP agent.
 */
async function makeMockHermesWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-hermes.sh");
  const envExports = Object.entries({ T3_ACP_MODEL_IDS: HERMES_MOCK_MODELS, ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

/** Wraps a mock `hermes` so it records the HERMES_HOME it was spawned with. */
async function makeHermesHomeRecordingWrapper(baseWrapper: string, homeLogPath: string) {
  const wrapperPath = NodePath.join(NodePath.dirname(homeLogPath), "fake-hermes-home.sh");
  const script = `#!/bin/sh
printf '%s' "$HERMES_HOME" > ${JSON.stringify(homeLogPath)}
exec ${JSON.stringify(baseWrapper)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 40): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (raw.trim().length > 0) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeHermesAdapter>[1]) =>
  makeHermesAdapter(decodeHermesSettings({ enabled: true, binaryPath }), options).pipe(
    Effect.orDie,
  );

it("requires a settlement to match the live Hermes turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it("keeps image attachments inline in Hermes ACP prompts", () => {
  assert.deepStrictEqual(
    makeHermesAttachmentPromptPart({
      attachment: {
        type: "image",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 3,
      },
      attachmentPath: "/tmp/diagram.png",
      imageBytes: Uint8Array.from([1, 2, 3]),
    }),
    { type: "image", data: "AQID", mimeType: "image/png" },
  );
});

it("sends generic files to Hermes as local ACP resource links", () => {
  const attachmentPath = NodePath.join(NodeOS.tmpdir(), "Hermes notes #1.txt");

  assert.deepStrictEqual(
    makeHermesAttachmentPromptPart({
      attachment: {
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
      attachmentPath,
    }),
    {
      type: "resource_link",
      uri: NodeURL.pathToFileURL(attachmentPath).href,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 42,
    },
  );
});

it.layer(hermesAdapterTestLayer)("HermesAdapterLive", (it) => {
  it.effect("starts a session and maps the mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mock-thread");
      const requestLogDir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-prompts-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.jsonl");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });

      assert.equal(session.provider, "hermes");
      assert.equal(session.model, "openai/gpt-5");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });

      yield* Deferred.await(turnCompleted);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptRequest = requests.find((request) => request.method === "session/prompt");
      const params = promptRequest?.params as { prompt: Array<{ type: string; text: string }> };
      assert.equal(params.prompt.length, 2);
      assert.deepStrictEqual(params.prompt[0], { type: "text", text: "hello hermes" });
      assert.equal(params.prompt[1]?.type, "text");
      assert.include(params.prompt[1]!.text, "Hermes harness, as openai/gpt-5");
      assert.include(params.prompt[1]!.text, "link_pull_request");
      assert.include(params.prompt[1]!.text, "list_thread_pull_requests");
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  const startRedirectableTurn = (threadId: ThreadId, requestLogPath: string) =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_REDIRECT_OVERLAPPING_PROMPTS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const approvalRequested = yield* Deferred.make<ApprovalRequestId>();
      const turnCompleted = yield* Deferred.make<void>();
      const texts = new Map<string, Deferred.Deferred<void>>();
      const textArrived = (text: string) => {
        const existing = texts.get(text);
        if (existing) return existing;
        const created = Deferred.makeUnsafe<void>();
        texts.set(text, created);
        return created;
      };
      const events: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "request.opened") {
            yield* Deferred.succeed(
              approvalRequested,
              ApprovalRequestId.make(String(event.requestId)),
            );
          }
          if (event.type === "content.delta") {
            yield* Deferred.succeed(textArrived(event.payload.delta), undefined);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => adapter.stopSession(threadId).pipe(Effect.ignore));

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const firstPrompt = yield* adapter
        .sendTurn({ threadId, input: "original task", attachments: [] })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(textArrived("Working on the original task."));
      const requestId = yield* Deferred.await(approvalRequested);
      const finishFirstTurn = adapter
        .respondToRequest(threadId, requestId, "accept")
        .pipe(Effect.andThen(Fiber.join(firstPrompt)));
      return { adapter, events, textArrived, turnCompleted, finishFirstTurn };
    });

  const promptPartsOf = (request: Record<string, unknown> | undefined) =>
    (request?.params as { prompt?: Array<{ type: string; text?: string }> } | undefined)?.prompt ??
    [];

  const findDelta = (events: ReadonlyArray<ProviderRuntimeEvent>, text: string) =>
    events.find((event) => event.type === "content.delta" && event.payload.delta === text);

  it.effect("steers a running Hermes turn with a text-only follow-up", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-live-steer");
      const requestLogDir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-live-steer-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.jsonl");
      const { adapter, events, turnCompleted, finishFirstTurn } = yield* startRedirectableTurn(
        threadId,
        requestLogPath,
      );

      // Resolves while the original prompt is still waiting on its approval.
      yield* adapter.sendTurn({
        threadId,
        input: "change the task while the tool runs",
        attachments: [],
      });
      assert.isFalse(events.some((event) => event.type === "turn.completed"));

      yield* finishFirstTurn;
      yield* Deferred.await(turnCompleted);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests.filter((request) => request.method === "session/prompt");
      assert.equal(prompts.length, 2);
      assert.deepStrictEqual(promptPartsOf(prompts[1]), [
        { type: "text", text: "change the task while the tool runs" },
      ]);
      const turnStarted = events.filter((event) => event.type === "turn.started");
      const turnsCompleted = events.filter((event) => event.type === "turn.completed");
      assert.equal(turnStarted.length, 1);
      assert.equal(turnsCompleted.length, 1);
      assert.equal(turnsCompleted[0]?.turnId, turnStarted[0]?.turnId);
      // Hermes's redirect confirmation is dropped; the steer message already shows it.
      assert.isUndefined(findDelta(events, "Redirected the active turn with your correction."));
      // The steer starts a new assistant message rather than splicing into the old one.
      const before = findDelta(events, "Working on the original task.");
      const after = findDelta(events, "Finished the redirected task.");
      assert.isDefined(before?.itemId);
      assert.isDefined(after?.itemId);
      assert.notEqual(after?.itemId, before?.itemId);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("holds a Hermes steer with attachments until the running prompt finishes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-attachment-steer");
      const requestLogDir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-attachment-steer-")),
        ),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.jsonl");
      const { adapter, events, turnCompleted, finishFirstTurn } = yield* startRedirectableTurn(
        threadId,
        requestLogPath,
      );

      const steer = yield* adapter
        .sendTurn({
          threadId,
          input: "use this report",
          attachments: [
            {
              type: "file",
              id: "hermes-attachment-steer-00000000-0000-4000-8000-000000000001",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 6,
            },
          ],
        })
        .pipe(Effect.forkScoped);
      // A later text steer still goes live (it resolves before the approval is
      // answered), so the turn is provably still running after the attachment
      // steer was accepted.
      yield* adapter.sendTurn({ threadId, input: "and keep it short", attachments: [] });
      yield* finishFirstTurn;
      yield* Fiber.join(steer);
      yield* Deferred.await(turnCompleted);

      // Hermes would have queued an overlapping attachment prompt as text only.
      assert.isUndefined(findDelta(events, "Queued for the next turn. (1 queued)"));
      assert.isDefined(findDelta(events, "Handled follow-up."));
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests.filter((request) => request.method === "session/prompt");
      assert.equal(prompts.length, 3);
      assert.isTrue(promptPartsOf(prompts[2]).some((part) => part.type === "resource_link"));
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("maps ACP usage_update and Hermes compaction onto thread runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-usage-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "48120/200000",
          T3_ACP_EMIT_COMPACTION_INFO: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const usageSeen = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "thread.token-usage.updated"
              ? Deferred.succeed(usageSeen, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });
      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });

      // Wait on the usage receipt itself rather than the turn, since Hermes
      // sends usage_update after the assistant message.
      yield* Deferred.await(usageSeen);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usage = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.isDefined(usage);
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 48_120);
        assert.equal(usage.payload.usage.maxTokens, 200_000);
        assert.equal(usage.payload.usage.compactsAutomatically, true);
      }

      const compacted = runtimeEvents.find(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      assert.isDefined(compacted, "expected a compacted thread.state.changed event");

      const titled = runtimeEvents.find((event) => event.type === "thread.metadata.updated");
      assert.equal(
        titled?.type === "thread.metadata.updated" ? titled.payload.name : undefined,
        "Compacted thread",
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("streams Hermes reasoning as reasoning text, separate from the reply", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-reasoning-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EMIT_THOUGHT_TEXT: "weighing the options" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "think first", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const deltas = runtimeEvents.flatMap((event) =>
        event.type === "content.delta" ? [event.payload] : [],
      );
      assert.deepEqual(
        deltas.map((delta) => [delta.streamKind, delta.delta]),
        [
          ["reasoning_text", "weighing the options"],
          ["assistant_text", "hello from mock"],
        ],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("folds session/prompt usage totals into the context-window snapshot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-prompt-usage-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "48120/200000",
          // input/output/total/cachedRead/thought, shaped like Hermes's
          // PromptResponse.usage.
          T3_ACP_EMIT_PROMPT_USAGE: "48120/900/51000/12000/300",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnCompleted = yield* Deferred.make<void>();
      const secondTurnCompleted = yield* Deferred.make<void>();
      let completedTurns = 0;
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
          if (event.type === "turn.completed") {
            completedTurns += 1;
          }
          return completedTurns;
        }).pipe(
          Effect.flatMap((seen) =>
            event.type !== "turn.completed"
              ? Effect.void
              : seen === 1
                ? Deferred.succeed(firstTurnCompleted, undefined)
                : Deferred.succeed(secondTurnCompleted, undefined),
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });

      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });
      yield* Deferred.await(firstTurnCompleted);
      yield* adapter.sendTurn({ threadId, input: "again", attachments: [] });
      yield* Deferred.await(secondTurnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usages = runtimeEvents.filter((event) => event.type === "thread.token-usage.updated");
      assert.isAtLeast(usages.length, 3);

      // usage_update alone knows nothing about totals.
      assert.equal(usages[0]?.payload.usage.usedTokens, 48_120);
      assert.isUndefined(usages[0]?.payload.usage.totalProcessedTokens);

      // The prompt response contributes the totals and the breakdown while the
      // window reading from usage_update survives.
      const afterPrompt = usages[1]?.payload.usage;
      assert.deepStrictEqual(afterPrompt, {
        usedTokens: 48_120,
        totalProcessedTokens: 51_000,
        maxTokens: 200_000,
        inputTokens: 48_120,
        cachedInputTokens: 12_000,
        outputTokens: 900,
        reasoningOutputTokens: 300,
        compactsAutomatically: true,
      });

      // The next turn's usage_update carries no total, and must not erase one.
      assert.equal(usages[2]?.payload.usage.totalProcessedTokens, 51_000);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("omits totalProcessedTokens when the turn total does not exceed the window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-prompt-usage-small-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "48120/200000",
          T3_ACP_EMIT_PROMPT_USAGE: "30000/900/40000",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });
      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usages = runtimeEvents.filter((event) => event.type === "thread.token-usage.updated");
      assert.isAtLeast(usages.length, 2);
      for (const usage of usages) {
        assert.isUndefined(usage.payload.usage.totalProcessedTokens);
      }
      // The breakdown still lands even when the total is not worth showing.
      assert.equal(usages.at(-1)?.payload.usage.outputTokens, 900);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("opens an approval request and answers with the agent-supplied option id", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "hermes-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "hermes-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels a silent turn and stays ready for the follow-up", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-cancel-silent-turn");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({ threadId, input: "hang forever", attachments: [] });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({ threadId, input: "continue after stop", attachments: [] });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompleted = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompleted, 1);
      assert.equal(followUpCompleted[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("resumes through session/load and drops the replayed history", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EMIT_LOAD_REPLAY: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({ threadId, input: "after resume", attachments: [] });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("starts a mirrored run's first session in its profile and primes it once", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-run:upstream-sync:s1");
      const logDir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-primer-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(logDir, "requests.jsonl");
      const homeLogPath = NodePath.join(logDir, "hermes-home.txt");
      const baseWrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeHermesHomeRecordingWrapper(baseWrapper, homeLogPath),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const turnsCompleted = yield* Queue.unbounded<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Queue.offer(turnsCompleted, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          hermesHome: "/srv/hermes/profiles/upstream-sync",
          primer: "<hermes_background_run>context</hermes_background_run>",
        },
      });
      // The primer stays in the persisted cursor until Hermes has accepted it.
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
        hermesHome: "/srv/hermes/profiles/upstream-sync",
        primer: "<hermes_background_run>context</hermes_background_run>",
      });
      assert.equal(yield* waitForFileContent(homeLogPath), "/srv/hermes/profiles/upstream-sync");

      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "keep the fork's composer",
        attachments: [],
      });
      yield* Queue.take(turnsCompleted);
      assert.deepStrictEqual(firstTurn.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
        hermesHome: "/srv/hermes/profiles/upstream-sync",
      });
      yield* adapter.sendTurn({ threadId, input: "and push", attachments: [] });
      yield* Queue.take(turnsCompleted);

      const prompts = (yield* Effect.promise(() => readJsonLines(requestLogPath)))
        .filter((request) => request.method === "session/prompt")
        .map((request) => (request.params as { prompt: Array<{ text?: string }> }).prompt);
      assert.equal(prompts.length, 2);
      assert.equal(prompts[0]![0]?.text, "<hermes_background_run>context</hermes_background_run>");
      assert.equal(prompts[0]![1]?.text, "keep the fork's composer");
      assert.equal(prompts[1]![0]?.text, "and push");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("restores a Hermes session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "fail prompt", attachments: [] }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a startSession routed to another provider", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("hermes-provider-mismatch"),
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-empty-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "   ", attachments: [] }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. Every other test here calls startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-consumer-outlives-start-session");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello hermes", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );
});

it.layer(hermesAdapterTestLayer)("Hermes delegation", (it) => {
  for (const mode of ["stock", "progress"] as const) {
    it.effect(`renders ${mode} delegate batches as child tasks rather than shell calls`, () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`hermes-delegation-${mode}`);
        const wrapper = yield* Effect.promise(() =>
          makeMockHermesWrapper({ T3_ACP_HERMES_DELEGATION: mode }),
        );
        const adapter = yield* makeTestAdapter(wrapper);
        const events: ProviderRuntimeEvent[] = [];
        const done = yield* Deferred.make<void>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "turn.completed") yield* Deferred.succeed(done, undefined);
          }),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "delegate review and tests", attachments: [] });
        yield* Deferred.await(done);
        assert.lengthOf(
          events.filter((event) => event.type === "task.started"),
          2,
        );
        assert.deepStrictEqual(
          events
            .filter((event) => event.type === "task.completed")
            .map((event) => event.payload.status),
          ["completed", "failed"],
        );
        assert.isFalse(
          events.some(
            (event) =>
              event.type === "item.started" && event.payload.itemType === "command_execution",
          ),
        );
        const ticks = events.filter((event) => event.type === "task.progress");
        assert.deepStrictEqual(
          ticks.slice(0, 2).map((event) => event.payload.status),
          ["pending", "pending"],
        );
        if (mode === "progress") {
          assert.deepStrictEqual(
            ticks.slice(2, 4).map((event) => event.payload.taskId),
            ["hermes-delegate-1:task:0", "hermes-delegate-1:task:1"],
          );
          assert.isTrue(
            ticks.some(
              (event) =>
                event.payload.summary === "Routing inspected; checking parallel child isolation.",
            ),
          );
        }
        yield* adapter.stopSession(threadId);
      }),
    );
  }

  it.effect("keeps late background child completion on the original turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-background-delegation");
      const wrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES_DELEGATION: "progress",
          T3_ACP_HERMES_DELEGATION_CASE: "dispatched",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapper);
      const events: ProviderRuntimeEvent[] = [];
      const firstDone = yield* Deferred.make<void>();
      const secondDone = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed")
            yield* Deferred.succeed(
              events.filter((item) => item.type === "turn.completed").length === 1
                ? firstDone
                : secondDone,
              undefined,
            );
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({
        threadId,
        input: "delegate background work",
        attachments: [],
      });
      yield* Deferred.await(firstDone);
      assert.lengthOf(
        events.filter((event) => event.type === "task.completed"),
        0,
      );
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      const second = yield* adapter.sendTurn({ threadId, input: "continue", attachments: [] });
      yield* Deferred.await(secondDone);
      const completed = events.filter((event) => event.type === "task.completed");
      assert.lengthOf(completed, 1);
      assert.equal(completed[0]?.turnId, first.turnId);
      assert.notEqual(first.turnId, second.turnId);
      assert.equal(completed[0]?.payload.summary, "Background review completed.");
      assert.lengthOf(
        events.filter((event) => event.type === "turn.completed"),
        2,
      );
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preserves detached children when their parent is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-detached-cancel");
      const wrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES_DELEGATION: "progress",
          T3_ACP_HERMES_DELEGATION_CASE: "dispatched",
          T3_ACP_HERMES_DELEGATION_HANG_AFTER_DISPATCH: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapper);
      const events: ProviderRuntimeEvent[] = [];
      const dispatched = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (
            event.type === "task.progress" &&
            event.payload.status === "running" &&
            events.filter((e) => e.type === "task.progress").length === 5
          )
            yield* Deferred.succeed(dispatched, undefined);
          if (event.type === "turn.completed") yield* Deferred.succeed(cancelled, undefined);
          if (event.type === "task.completed") yield* Deferred.succeed(completed, undefined);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const prompt = yield* adapter
        .sendTurn({ threadId, input: "delegate", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(dispatched);
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(cancelled);
      const first = yield* Fiber.join(prompt);
      assert.lengthOf(
        events.filter((event) => event.type === "task.updated"),
        0,
      );
      yield* adapter.sendTurn({ threadId, input: "continue", attachments: [] });
      yield* Deferred.await(completed);
      assert.equal(events.find((event) => event.type === "task.completed")?.turnId, first.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupts background children when an idle ACP process disconnects", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-detached-exit");
      const wrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES_DELEGATION: "progress",
          T3_ACP_HERMES_DELEGATION_CASE: "dispatched",
          T3_ACP_HERMES_DELEGATION_EXIT_ON_CANCEL: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapper);
      const interrupted = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "task.updated" && event.payload.status === "interrupted"
          ? Deferred.succeed(interrupted, event)
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "delegate", attachments: [] });
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.interruptTurn(threadId);
      const event = yield* Deferred.await(interrupted);
      assert.equal(event.turnId, first.turnId);
      assert.match(
        event.type === "task.updated" ? (event.payload.error ?? "") : "",
        /ACP disconnected/,
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels pending children when an active delegation is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-interrupt-delegation");
      const wrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES_DELEGATION: "stock",
          T3_ACP_HERMES_DELEGATION_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapper);
      const events: ProviderRuntimeEvent[] = [];
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "task.progress" && event.payload.taskId.endsWith(":1"))
            yield* Deferred.succeed(started, undefined);
          if (event.type === "turn.completed") yield* Deferred.succeed(cancelled, undefined);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const prompt = yield* adapter
        .sendTurn({ threadId, input: "delegate work", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(cancelled);
      yield* Fiber.join(prompt);
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "task.updated")
          .map((event) => event.payload.status),
        ["cancelled", "cancelled"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(hermesAdapterTestLayer)("Hermes background work", (it) => {
  it.effect("keeps a patched Hermes background process live until it reports its exit", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-background-process");
      const wrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_HERMES_BACKGROUND: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapper);
      const started = yield* Deferred.make<ProviderRuntimeEvent>();
      const completed = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "task.started"
          ? Deferred.succeed(started, event)
          : event.type === "task.completed"
            ? Deferred.succeed(completed, event)
            : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const first = yield* adapter.sendTurn({ threadId, input: "watch CI", attachments: [] });
      const start = yield* Deferred.await(started);
      assert.equal(start.turnId, first.turnId);
      assert.deepInclude(start.type === "task.started" ? start.payload : {}, {
        taskId: "proc_ci000001",
        taskType: "shell",
        description: "gh pr checks 94 --watch",
        toolUseId: "hermes-terminal-1",
      });
      // The turn settled, but the process still runs: nothing has completed it.
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.isFalse(yield* Deferred.isDone(completed));

      yield* adapter.sendTurn({ threadId, input: "is CI done?", attachments: [] });
      const exit = yield* Deferred.await(completed);
      assert.equal(exit.turnId, first.turnId);
      assert.deepInclude(exit.type === "task.completed" ? exit.payload : {}, {
        taskId: "proc_ci000001",
        status: "failed",
        summary: "Exit code 1",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  const findDelta = (events: ReadonlyArray<ProviderRuntimeEvent>, text: string) =>
    events.find((event) => event.type === "content.delta" && event.payload.delta === text);

  const makeBackgroundRequestLog = Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-background-"))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  ).pipe(Effect.map((dir) => NodePath.join(dir, "requests.jsonl")));

  const promptTexts = (requestLogPath: string) =>
    Effect.promise(() => readJsonLines(requestLogPath)).pipe(
      Effect.map((requests) =>
        requests
          .filter((request) => request.method === "session/prompt")
          .map(
            (request) =>
              (request.params as { prompt: Array<{ text?: string }> }).prompt[0]?.text ?? "",
          ),
      ),
    );

  it.effect("wakes the agent with Hermes's notice once its background work finishes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-background-wake");
      const requestLogPath = yield* makeBackgroundRequestLog;
      const wrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES_BACKGROUND: "1",
          T3_ACP_HERMES_BACKGROUND_FINISH: "after-turn",
          T3_ACP_HERMES_NOTIFICATION_ID: "deleg-receipt-1",
          T3_ACP_HERMES_REPEAT_NOTIFICATION: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapper);
      const events: ProviderRuntimeEvent[] = [];
      const woke = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (events.filter((item) => item.type === "turn.completed").length === 2)
            yield* Deferred.succeed(woke, undefined);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const first = yield* adapter.sendTurn({ threadId, input: "watch CI", attachments: [] });
      yield* Deferred.await(woke);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
      assert.lengthOf(yield* promptTexts(requestLogPath), 2);

      const [, wake] = events.filter((event) => event.type === "turn.started");
      assert.isDefined(wake);
      assert.notEqual(wake?.turnId, first.turnId);
      assert.equal(
        findDelta(events, "CI failed on Test Server 1; looking into it.")?.turnId,
        wake?.turnId,
      );
      const [, wakePrompt] = yield* promptTexts(requestLogPath);
      assert.match(wakePrompt ?? "", /^\[IMPORTANT: Background process proc_ci000001 exited/);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const initialize = requests.find((request) => request.method === "initialize");
      assert.deepEqual(
        (initialize?.params as { clientCapabilities: { _meta?: unknown } }).clientCapabilities
          ._meta,
        { "hermes.backgroundNotifications": 1 },
      );
      const [, wakeRequest] = requests.filter((request) => request.method === "session/prompt");
      assert.deepEqual((wakeRequest?.params as { _meta?: unknown })._meta, {
        "hermes.notificationIds": ["deleg-receipt-1"],
      });
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("holds a wake after Stop until the user's next turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-background-wake-held");
      const requestLogPath = yield* makeBackgroundRequestLog;
      const wrapper = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES_BACKGROUND: "1",
          T3_ACP_HERMES_BACKGROUND_FINISH: "cancel",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapper);
      const noticeHandled = yield* Deferred.make<void>();
      const woke = yield* Deferred.make<void>();
      let completedTurns = 0;
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "task.started" && event.payload.taskId === "proc_next0002"
          ? Deferred.succeed(noticeHandled, undefined)
          : event.type === "turn.completed" && ++completedTurns === 3
            ? Deferred.succeed(woke, undefined)
            : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      yield* adapter.sendTurn({ threadId, input: "watch CI", attachments: [] });
      // Stop, after which the watcher finishes and Hermes sends its notice.
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(noticeHandled);
      yield* adapter.sendTurn({ threadId, input: "what happened?", attachments: [] });
      yield* Deferred.await(woke);

      const prompts = yield* promptTexts(requestLogPath);
      assert.deepEqual(prompts.slice(0, 2), ["watch CI", "what happened?"]);
      assert.match(prompts[2] ?? "", /^\[IMPORTANT: Background process proc_ci000001 exited/);
      yield* adapter.stopSession(threadId);
    }),
  );
});
