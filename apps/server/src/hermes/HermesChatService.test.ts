// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { HermesChatService, layer } from "./HermesChatService.ts";
import {
  HERMES_STATE_DDL,
  insertHermesGatewaySession,
  insertHermesMessage,
} from "./hermesRunFixtures.ts";

const KEY = "agent:main:discord:thread:9:9";

function hermesHome() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-chat-service-"));
  const db = new NodeSqlite.DatabaseSync(NodePath.join(root, "state.db"));
  try {
    db.exec(HERMES_STATE_DDL);
    insertHermesGatewaySession(db, { id: "s1", sessionKey: KEY, startedAt: 1_000 });
    insertHermesMessage(db, { sessionId: "s1", role: "user", content: "hello", timestamp: 1_001 });
  } finally {
    db.close();
  }
  return root;
}

const serviceWith = (settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
  layer.pipe(Layer.provide(ServerSettings.layerTest(settings)), Layer.provide(NodeServices.layer));

it.effect("reads conversations from the enabled Hermes instance's home", () => {
  const root = hermesHome();
  return Effect.gen(function* () {
    const chat = yield* HermesChatService;
    const transcript = yield* chat.transcript({ sessionKey: KEY });
    expect(transcript).toMatchObject({
      availability: "ready",
      conversation: { sessionKey: KEY, messageCount: 1 },
      messages: [{ role: "user", text: "hello", timestamp: "1970-01-01T00:16:41.000Z" }],
    });
    // it.effect's TestClock starts at the epoch, so the fixture's activity is recent.
    expect(yield* chat.list({ limit: 5 })).toMatchObject({
      availability: "ready",
      conversations: [{ sessionKey: KEY, latestMessagePreview: "hello", userName: "Yato" }],
    });
  }).pipe(
    Effect.provide(
      serviceWith({
        providerInstances: {
          [ProviderInstanceId.make("hermes")]: {
            driver: ProviderDriverKind.make("hermes"),
            enabled: true,
            environment: [{ name: "HERMES_HOME", value: root, sensitive: false }],
          },
        },
      }),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("answers hermes-off without touching any store while Hermes is disabled", () =>
  Effect.gen(function* () {
    const chat = yield* HermesChatService;
    expect(yield* chat.list({})).toEqual({ availability: "hermes-off", conversations: [] });
    expect(yield* chat.transcript({ sessionKey: KEY })).toMatchObject({
      availability: "hermes-off",
      messages: [],
    });
  }).pipe(Effect.provide(serviceWith({}))),
);
