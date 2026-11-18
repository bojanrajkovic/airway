import type { SettingsChangeRow } from "./rows.ts";
import type { StrDay, UsedStrDay } from "./str.ts";

/**
 * The settings that changed on each used day from `from` on, compared with the used day before
 * it. That day can come before `from` or have no DATALOG folder, so a change shows on the day the
 * machine first used it. Unused days are skipped, and the first used day has nothing to compare.
 */
export function settingsChanges(
  days: readonly StrDay[],
  from: Temporal.PlainDate,
): SettingsChangeRow[] {
  const used = days.filter((day): day is UsedStrDay => day.used);

  return used.flatMap((day, i) => {
    const previous = used[i - 1];

    if (previous === undefined || Temporal.PlainDate.compare(day.day, from) < 0) {
      return [];
    }

    return Object.entries(day.settings).flatMap(([setting, value]): SettingsChangeRow[] => {
      const before = previous.settings[setting] ?? null;

      return before === value
        ? []
        : [{ night: day.day, setting, old_value: before, new_value: value }];
    });
  });
}
