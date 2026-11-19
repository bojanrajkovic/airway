import type { SettingsChangeRow } from "./rows.ts";
import type { StrDay, UsedStrDay } from "./str.ts";

/**
 * Compares each used day's settings with the previous used day's, and returns a row for each
 * setting that changed. Only days on or after `from` get rows, but the previous used day can be
 * earlier. A day with no DATALOG folder still gets its rows. Unused days are skipped.
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
