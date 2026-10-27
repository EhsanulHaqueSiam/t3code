import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_PRESET_MINUTES,
  MAX_SNOOZE_PRESETS,
  SnoozePresetDay,
  type SnoozePresetSetting,
} from "@t3tools/contracts/settings";
import { resolveSnoozePreset, snoozePresetId } from "@t3tools/client-runtime/state/thread-settled";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { PlusIcon, XIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;
type DurationUnit = keyof typeof UNIT_MINUTES;
const UNIT_LABELS: Record<DurationUnit, string> = {
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

const WHEN_LABELS: Record<"after" | SnoozePresetDay, string> = {
  after: "In",
  today: "Today",
  tomorrow: "Tomorrow",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};
const WHEN_VALUES = ["after", ...SnoozePresetDay.literals] as const;

// Offered in order when adding, skipping any already in the list.
const ADD_CANDIDATES: ReadonlyArray<SnoozePresetSetting> = [
  ...DEFAULT_SNOOZE_PRESETS,
  { kind: "after", minutes: 30 },
  { kind: "at", day: "saturday", time: "09:00" },
  { kind: "after", minutes: 24 * 60 },
];

function splitMinutes(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes % UNIT_MINUTES.days === 0)
    return { amount: minutes / UNIT_MINUTES.days, unit: "days" };
  if (minutes % UNIT_MINUTES.hours === 0) {
    return { amount: minutes / UNIT_MINUTES.hours, unit: "hours" };
  }
  return { amount: minutes, unit: "minutes" };
}

function nextCandidate(presets: ReadonlyArray<SnoozePresetSetting>): SnoozePresetSetting {
  const used = new Set(presets.map(snoozePresetId));
  return (
    ADD_CANDIDATES.find((candidate) => !used.has(snoozePresetId(candidate))) ?? {
      kind: "after",
      minutes: 60,
    }
  );
}

const isSnoozePresetDay = Schema.is(SnoozePresetDay);

function withWhen(preset: SnoozePresetSetting, when: string): SnoozePresetSetting | null {
  if (when === "after") return preset.kind === "after" ? preset : { kind: "after", minutes: 60 };
  if (!isSnoozePresetDay(when)) return null;
  return { kind: "at", day: when, time: preset.kind === "at" ? preset.time : "09:00" };
}

/** Edits the snooze menu's options. Menus sort them by wake time, so rows keep the order they were added in. */
export function SnoozePresetsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const presets = settings.snoozePresets;
  const save = (snoozePresets: ReadonlyArray<SnoozePresetSetting>) =>
    updateSettings({ snoozePresets });
  const replaceAt = (index: number, next: SnoozePresetSetting) =>
    save(presets.map((preset, candidate) => (candidate === index ? next : preset)));

  return (
    <SettingsRow
      serverScoped
      settingKeys={["snoozePresets"]}
      {...searchableSetting("snooze-options")}
      description="Choices in every snooze menu, listed soonest first. Weekdays mean the next one after today."
      resetAction={
        Equal.equals(presets, DEFAULT_SNOOZE_PRESETS) ? null : (
          <SettingResetButton label="snooze options" onClick={() => save(DEFAULT_SNOOZE_PRESETS)} />
        )
      }
    >
      <SnoozePresetList
        presets={presets}
        timestampFormat={settings.timestampFormat}
        onChange={replaceAt}
        onRemove={(index) => save(presets.filter((_, candidate) => candidate !== index))}
        onAdd={() => save([...presets, nextCandidate(presets)])}
      />
    </SettingsRow>
  );
}

function SnoozePresetList(props: {
  presets: ReadonlyArray<SnoozePresetSetting>;
  timestampFormat: Parameters<typeof formatShortTimestamp>[1];
  onChange: (index: number, preset: SnoozePresetSetting) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  const nowMinute = useNowMinute();
  const now = new Date(`${nowMinute}Z`);
  const formatTime = (date: Date) =>
    formatShortTimestamp(date.toISOString(), props.timestampFormat);
  const seenWakes = new Set<string>();
  const previews = props.presets.map((preset) => {
    const resolved = resolveSnoozePreset(preset, now, formatTime);
    if (resolved === null) {
      const [hours, minutes] = preset.kind === "at" ? preset.time.split(":") : [];
      const passedAt = new Date(now);
      passedAt.setHours(Number(hours), Number(minutes), 0, 0);
      return { tone: "muted", text: `Hidden after ${formatTime(passedAt)}` } as const;
    }
    if (seenWakes.has(resolved.snoozedUntil)) {
      return { tone: "muted", text: "Same time as an option above" } as const;
    }
    seenWakes.add(resolved.snoozedUntil);
    return { tone: "menu", label: resolved.label, when: resolved.whenLabel } as const;
  });

  return (
    <div className="flex flex-col gap-1.5 pt-3 pb-2">
      {props.presets.map((preset, index) => {
        const preview = previews[index]!;
        return (
          <div
            // Rows have no identity beyond their position; editing one never reorders the rest.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            className="flex flex-wrap items-center gap-2"
          >
            <SnoozePresetFields preset={preset} onChange={(next) => props.onChange(index, next)} />
            <div
              className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {preview.tone === "menu" ? (
                <span className="truncate">
                  <span className="text-foreground">{preview.label}</span>
                  <span className="ps-2 tabular-nums">{preview.when}</span>
                </span>
              ) : (
                <span className="truncate">{preview.text}</span>
              )}
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label="Remove snooze option"
                onClick={() => props.onRemove(index)}
              >
                <XIcon />
              </Button>
            </div>
          </div>
        );
      })}
      {props.presets.length === 0 ? (
        <p className="text-xs text-muted-foreground">Snooze menus offer only Custom…</p>
      ) : null}
      <div>
        <Button
          variant="ghost-muted"
          size="compact"
          disabled={props.presets.length >= MAX_SNOOZE_PRESETS}
          onClick={props.onAdd}
        >
          <PlusIcon />
          Add option
        </Button>
      </div>
    </div>
  );
}

function SnoozePresetFields(props: {
  preset: SnoozePresetSetting;
  onChange: (preset: SnoozePresetSetting) => void;
}) {
  const { preset, onChange } = props;
  const when = preset.kind === "after" ? "after" : preset.day;
  return (
    <div className="flex items-center gap-2">
      <Select
        value={when}
        items={WHEN_LABELS}
        onValueChange={(value) => {
          const next = value === null ? null : withWhen(preset, value);
          if (next) onChange(next);
        }}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="When">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {WHEN_VALUES.map((value) => (
            <SelectItem hideIndicator key={value} value={value}>
              {WHEN_LABELS[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {preset.kind === "after" ? (
        <DurationFields
          minutes={preset.minutes}
          onChange={(minutes) => onChange({ ...preset, minutes })}
        />
      ) : (
        <>
          <span className="text-xs text-muted-foreground">at</span>
          <Input
            nativeInput
            size="sm"
            type="time"
            className="w-32"
            aria-label="Time"
            value={preset.time}
            onChange={(event) => {
              if (/^\d{2}:\d{2}$/.test(event.target.value)) {
                onChange({ ...preset, time: event.target.value });
              }
            }}
          />
        </>
      )}
    </div>
  );
}

function DurationFields(props: { minutes: number; onChange: (minutes: number) => void }) {
  const { amount, unit } = splitMinutes(props.minutes);
  const maxAmount = Math.floor(MAX_SNOOZE_PRESET_MINUTES / UNIT_MINUTES[unit]);
  return (
    <>
      <NumberField
        size="sm"
        className="w-24"
        min={1}
        max={maxAmount}
        step={1}
        value={amount}
        onValueChange={(value) => {
          if (value !== null && Number.isInteger(value) && value >= 1 && value <= maxAmount) {
            props.onChange(value * UNIT_MINUTES[unit]);
          }
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label="Decrease" />
          <NumberFieldInput aria-label="Amount" />
          <NumberFieldIncrement aria-label="Increase" />
        </NumberFieldGroup>
      </NumberField>
      <Select
        value={unit}
        items={UNIT_LABELS}
        onValueChange={(value) => {
          if (value === "minutes" || value === "hours" || value === "days") {
            props.onChange(Math.min(amount * UNIT_MINUTES[value], MAX_SNOOZE_PRESET_MINUTES));
          }
        }}
      >
        <SelectTrigger size="sm" className="w-28" aria-label="Unit">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {(Object.keys(UNIT_LABELS) as DurationUnit[]).map((value) => (
            <SelectItem hideIndicator key={value} value={value}>
              {UNIT_LABELS[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </>
  );
}
