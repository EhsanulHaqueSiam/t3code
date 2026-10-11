import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
  WsSubscribeServerConfigRpc,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
  subscribeServerConfig,
  WS_RPC_SERVER_OPTIONS,
  withLateEditorConfig,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

// Only the fields the late-editor fold reads or rewrites.
const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        // Holds the late snapshot until the settings change has gone out.
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("sends no late snapshot when the scan matches the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["vscode"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["vscode"]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
    ).pipe(Stream.runCollect);

    assert.equal(events.length, 0);
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

// The real launcher on Windows over a filesystem whose probes park until
// released, like a host too busy to finish discovery inside the snapshot timeout.
const makeParkedWindowsLauncher = Effect.gen(function* () {
  const parkedProbes = yield* Queue.unbounded<void>();
  const release = yield* Deferred.make<void>();
  const launcher = yield* ExternalLauncher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Queue.offer(parkedProbes, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ type: "File" } as FileSystem.File.Info),
            ),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
        ),
      ),
    ),
  );
  const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-late-editors-test", PATHEXT: ".EXE" },
          }),
        ),
      ),
    );
  return {
    editors: {
      resolveAvailableEditors: () => onWindows(launcher.resolveAvailableEditors()),
      resolveFileManagerRevealKind: () => onWindows(launcher.resolveFileManagerRevealKind()),
    },
    probeParked: Queue.take(parkedProbes),
    releaseProbes: Deferred.succeed(release, undefined),
  };
});

it.effect("recovers editors after a real scan outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const snapshotFiber = yield* resolveAvailableEditorsForConfig(
      editors.resolveAvailableEditors(),
    ).pipe(Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(5));
    const snapshotEditors = yield* Fiber.join(snapshotFiber);
    assert.deepEqual(snapshotEditors, []);

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: snapshotEditors }),
      Stream.empty,
      editors,
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.availableEditors.includes("vscode"), true);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovers a reveal kind whose real probe outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    // The snapshot's bounded probe timed out: file manager, but no reveal kind.
    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: editors.resolveFileManagerRevealKind,
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(6));
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
).pipe(
  Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provide(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect.each([
  { source: "settings", interval: "discovery" },
  { source: "settings", interval: "snapshot ACK" },
  { source: "keybindings", interval: "discovery" },
  { source: "keybindings", interval: "snapshot ACK" },
] as const)(
  "preserves $source changes during $interval at the config RPC boundary",
  ({ source, interval }) =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const lateEditors = yield* Deferred.make<readonly ["vscode"]>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const group = RpcGroup.make(WsSubscribeServerConfigRpc);
      const loadConfig = Effect.gen(function* () {
        const shortcuts = yield* keybindings.loadConfigState;
        const currentSettings = yield* settings.getSettings;
        yield* Deferred.succeed(discoveryStarted, undefined);
        yield* Deferred.await(finishDiscovery);
        return snapshotConfig({
          keybindings: shortcuts.keybindings,
          issues: shortcuts.issues,
          settings: ServerSettings.redactServerSettingsForClient(currentSettings),
        });
      });
      const server = yield* RpcServer.makeNoSerialization(group, {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Chunk"
            ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                discard: true,
              })
            : Effect.void,
      }).pipe(
        Effect.provide(
          group.toLayerHandler(WS_METHODS.subscribeServerConfig, () =>
            subscribeServerConfig(loadConfig, () => Stream.empty, {
              resolveAvailableEditors: () => Deferred.await(lateEditors),
              resolveFileManagerRevealKind: () => Effect.succeed(undefined),
            }).pipe(
              Stream.provideService(Keybindings.Keybindings, {
                ...keybindings,
                streamChanges: Stream.unwrap(keybindingsChanges),
                subscribeChanges: keybindingsChanges,
              }),
              Stream.provideService(ServerSettings.ServerSettingsService, {
                ...settings,
                streamChanges: Stream.unwrap(settingsChanges),
                subscribeChanges: settingsChanges,
              }),
            ),
          ),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);
      assert.equal(yield* Queue.size(responses), 0);

      const change = () =>
        source === "settings"
          ? settings
              .updateSettings({ defaultAutoPull: true })
              .pipe(
                Effect.map((next) =>
                  settingsUpdated(ServerSettings.redactServerSettingsForClient(next)),
                ),
              )
          : keybindings.upsertKeybindingRule({ key: "mod+alt+y", command: "terminal.toggle" }).pipe(
              Effect.map((next): ServerConfigStreamEvent => ({
                version: 1,
                type: "keybindingsUpdated",
                payload: { keybindings: next, issues: [] },
              })),
            );
      const duringDiscovery = interval === "discovery" ? yield* change() : undefined;
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const expected = duringDiscovery ?? (yield* change());
      assert.equal(yield* Queue.size(responses), 0);
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // A second change gives the old implementation an observable response too:
      // it must fail on the missing first update instead of waiting for a timeout.
      const next =
        source === "settings"
          ? settings
              .updateSettings({ enableProviderUpdateChecks: false })
              .pipe(
                Effect.map((value) =>
                  settingsUpdated(ServerSettings.redactServerSettingsForClient(value)),
                ),
              )
          : keybindings.upsertKeybindingRule({ key: "mod+alt+z", command: "terminal.split" }).pipe(
              Effect.map((value): ServerConfigStreamEvent => ({
                version: 1,
                type: "keybindingsUpdated",
                payload: { keybindings: value, issues: [] },
              })),
            );
      const latest = yield* next;
      assert.deepEqual(yield* Queue.take(responses), expected);
      yield* acknowledge;
      assert.deepEqual(yield* Queue.take(responses), latest);
      yield* acknowledge;
      yield* Deferred.succeed(lateEditors, ["vscode"]);
      const late = yield* Queue.take(responses);
      assert.equal(late.type, "snapshot");
      if (late.type === "snapshot") {
        assert.deepEqual(late.config.availableEditors, ["vscode"]);
        if (latest.type === "settingsUpdated")
          assert.deepEqual(late.config.settings, latest.payload.settings);
        if (latest.type === "keybindingsUpdated")
          assert.deepEqual(late.config.keybindings, latest.payload.keybindings);
      }
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
    }).pipe(Effect.provide(Layer.fresh(layerConfigSources)), Effect.scoped),
);
