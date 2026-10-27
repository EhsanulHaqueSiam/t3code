import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";

describe("DeliveryAttempts", () => {
  it.effect("reports completed source jobs when the durable claim already exists", () => {
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "2026-05-26T00:00:00.000Z",
                  apnsStatus: 200,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("completed");
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("reports in-flight source jobs while an active claim lease exists", () => {
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "2999-01-01T00:00:00.000Z",
                  apnsStatus: null,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("in_flight");
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("reclaims source jobs after the claim lease expires", () => {
    const updatedValues: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "1969-12-31T23:00:00.000Z",
                  apnsStatus: null,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: () => ({
              returning: () => Effect.succeed([{ id: "attempt-1" }]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("claimed");
      expect(updatedValues[0]?.createdAt).toEqual(expect.any(String));
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  const pruneWith = (batches: ReadonlyArray<number>) => {
    const deleteCalls: number[] = [];
    const fakeDb = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({}) }) }) }),
      delete: () => ({
        where: () => ({
          returning: () => {
            const size = batches[deleteCalls.length] ?? 0;
            deleteCalls.push(size);
            return Effect.succeed(Array.from({ length: size }, (_, index) => ({ id: `${index}` })));
          },
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    const run = DeliveryAttempts.DeliveryAttempts.pipe(
      Effect.flatMap((attempts) => attempts.pruneExpired),
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
    return { run, deleteCalls };
  };

  it.effect("stops pruning once a batch comes back short", () => {
    const full = DeliveryAttempts.DELIVERY_ATTEMPT_PRUNE_BATCH_SIZE;
    const { run, deleteCalls } = pruneWith([full, 12]);
    return Effect.gen(function* () {
      expect(yield* run).toBe(full + 12);
      expect(deleteCalls).toEqual([full, 12]);
    });
  });

  it.effect("caps each run at the batch limit while a backlog remains", () => {
    const full = DeliveryAttempts.DELIVERY_ATTEMPT_PRUNE_BATCH_SIZE;
    const { run, deleteCalls } = pruneWith(Array.from({ length: 10 }, () => full));
    return Effect.gen(function* () {
      expect(yield* run).toBe(full * DeliveryAttempts.DELIVERY_ATTEMPT_PRUNE_MAX_BATCHES);
      expect(deleteCalls).toHaveLength(DeliveryAttempts.DELIVERY_ATTEMPT_PRUNE_MAX_BATCHES);
    });
  });
});
