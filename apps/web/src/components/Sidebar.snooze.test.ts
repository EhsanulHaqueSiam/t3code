// @effect-diagnostics globalDate:off -- Snooze choices resolve against the local wall clock.
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { pickSnoozePreset, resolveSnoozePresets } from "./Sidebar.snooze";

describe("pickSnoozePreset", () => {
  it("starts a duration when it is picked, not when the menu opened", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const environmentId = EnvironmentId.make("env-without-settings");
    vi.useFakeTimers({ now: new Date(2026, 4, 8, 17, 0) });
    const shown = resolveSnoozePresets(new Date(2026, 4, 8, 17, 0), "12-hour", environmentId);

    vi.setSystemTime(new Date(2026, 4, 8, 17, 30));
    const picked = pickSnoozePreset(shown, "after:60", "12-hour", environmentId);

    expect(picked?.snoozedUntil).toBe(new Date(2026, 4, 8, 18, 30).toISOString());
  });
});
