import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

/** The snooze menu for a thread, from its environment's presets, read when the menu opens. */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): ReadonlyArray<SnoozePreset> {
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return resolveSharedSnoozePresets(now, {
    ...(presets ? { presets } : {}),
    formatTime: (date) => formatShortTimestamp(date.toISOString(), timestampFormat),
  });
}

/**
 * A menu choice re-resolved when picked, so a duration starts at selection rather than when the
 * menu opened. Falls back to the shown time while it is still ahead.
 */
export function pickSnoozePreset(
  shown: ReadonlyArray<SnoozePreset>,
  id: string,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): SnoozePreset | undefined {
  const now = new Date();
  const fresh = resolveSnoozePresets(now, timestampFormat, environmentId).find(
    (preset) => preset.id === id,
  );
  if (fresh) return fresh;
  const original = shown.find((preset) => preset.id === id);
  return original && Date.parse(original.snoozedUntil) > now.getTime() ? original : undefined;
}
