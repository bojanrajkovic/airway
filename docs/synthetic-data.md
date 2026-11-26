# Synthetic data

This page explains how airway generates the synthetic SD-card data for tests, screenshots, and local development. Every value, date, serial, and name here is invented.

## The AirSense 10's signals

`@airway/edf/airsense` lists every EDF file type that the AirSense 10 writes, with each signal as the file's header declares it. The EDF writer uses the list, and ingest's reader will use it too, so writing and reading follow one description of the format.

| File | Format | Record | What it holds |
|---|---|---|---|
| BRP | EDF | 60 s | 25 Hz flow and pressure |
| PLD | EDF | 60 s | Nine 2 s signals: pressures, leak, breathing rate, tidal volume, minute ventilation, snore, flow limitation |
| SAD | EDF | 60 s | Pulse and SpO2 at 1 Hz, all missing without a sensor |
| EVE | EDF+D | 0 s | The machine's events, one annotation per record |
| CSL | EDF+D | 0 s | Cheyne-Stokes periods |
| STR | EDF | 1 day | The daily summary: 81 signals, one record per day |

For each signal the list gives:
- the label, and the unit (empty when the header leaves it blank)
- the physical range, kept as the header's text because the machine writes some as `0.00` and others as `0`
- the digital range, which is the int16 range stored in the file
- the samples per record
- where the values go: a `samples` or `nights` column, a named setting, or nowhere

`step(signal)` returns the size of one digital step in physical units, such as 0.002 L/s for flow. Every data record ends with a `Crc16` signal, which holds the CRC-16/CCITT-FALSE of the record's other bytes in little-endian order. The writer computes that CRC for every record it writes.

These details are the same on every AirSense 10. They come from the headers of real files and describe only the format.

## Synthetic nights

`syntheticNights({ seed, nights, start, patient, zone, cases })` in `@airway/synthetic/model` builds the nights that every other function on this page writes from. It returns the nights and their zone in a neverthrow `Result`, or an error when a named edge case can't be built, such as a DST case in a zone without daylight saving time. The same options always produce the same nights. All randomness comes from d3-random distributions that share one seeded generator.

```ts
const model = syntheticNights({ seed: 7, nights: 30 });

if (model.isErr()) {
  throw new Error(`can't build the nights: ${model.error.kind}`);
}

const { nights, zone } = model.value;
// nights[0].night is 2030-01-07; nights[0].str.get("AHI") is the machine's AHI for it.
// zone is America/Chicago, so the files' device clock runs at -06:00.
```

Each night holds:
- `periods`: the mask-on periods, as UTC instants. Each is one session.
- `segments`: one stretch of recording per BRP file, each a whole number of minutes long. Each segment stores PLD's nine 2 s series, a seed for the segment's 25 Hz detail, and how to write the segment's files. `brp` and `sad` are each a `FileDamage`, and `pldFiles` is `none`, `one` with a `FileDamage`, or `split` at a record. `FileDamage` is `none` or one kind of damage that real cards show: `empty` (a -1 count and no records), `truncated` (cut partway through a record, short of its declared count), `unknown_length` (every record, but a -1 count), or `undercounted` (one more record than its count). Every file of a base night is undamaged. `FileDamage` uses the same names as `checkFileSize`. `checkFileSize` rejects a file written as `truncated` with `reason: truncated`, and reads a file written as `undercounted` with `header: undercounted`.
- `events`: what the machine scores and writes to EVE. Each event has a modeled `duration` in seconds, because the duration shapes the flow and pressure around it. The machine writes a duration of 0 to EVE for hypopneas and arousals.
- `pauses`: gaps in breathing that the flow signal shows. There are three kinds:

  | Kind | Length | In EVE? | What should flag it |
  |---|---|---|---|
  | `machine_apnea` | 10 to 30 s | yes | the machine |
  | `pediatric` | 2 breaths to 10 s | no | only airway's pediatric step |
  | `dip` | under 2 breaths | no | nothing |

- `eventFiles`: the night's EVE files, each with its start time and whether a CSL file accompanies it. A night has one EVE file. It starts 3 to 35 s before the night's first segment, as on the real card, so ingest has to measure onsets from the EVE header's start time. The 3 to 35 s offset comes from a separate generator, seeded alongside the first segment's generator, so every other value stays the same. A night with no segments has an empty list.
- `str`: the night's STR.edf values by label, rounded to each signal's step. `NaN` marks values that the machine writes as -1, such as SpO2 without an oximeter. `strFile` fills in Date, MaskOn, and MaskOff, which depend on the device clock, and the writer adds each record's Crc16.

Unused days are days with no night in the list.

`patient` is `child` (the default) or `adult`. It selects one set of numbers from `@airway/synthetic/patients`: mask-on periods, file gaps, breathing rate, breath size, event and pause rates, leak, and settings. All are invented round numbers. The scoring rules still come from the configured birth date.

Mask-on periods and file gaps differ by patient:

| | Child | Adult |
|---|---|---|
| Mask-on periods | 1 to 10, or 11 to 20 on about 1 night in 6 | 1 to 6 |
| Gap between BRP files in one period | 5 to 120 s, mostly 30 to 90 s | 5 to 90 s |

STR.edf has slots for 10 periods. On a child's night with more than 10, ingest rebuilds the later periods from BRP files, and joins files that are 90 s or less apart into one period. A child's file gaps fall on both sides of 90 s, so those nights also test the cases where ingest joins or splits files wrongly. An adult night fits in the 10 slots and has file gaps under 90 s, so ingest's sessions always match the night's periods.

A break between periods lasts 60 s plus a long-tailed random value. Breaks have a median near 200 s, sometimes reach 25 minutes or more, and last at most 3 hours. On a night with many periods, the breaks shrink so the last mask-off comes by 11:00 on the device clock. Files after the device clock's noon would belong to the next night.

Ordinary variation comes from the seed: about 1 night in 8 is short, about 1 in 10 is bad with four times the events, events sometimes cluster, and leak spikes for a few minutes now and then.

The AHI and its parts are `(600 × events) div minutes` in tenths, and MaskEvents is twice the number of sessions. The model computes the STR medians and leak percentiles from the stored 2 s series, and generates the maxima and pressure statistics at random near that series' values. On the real machine too, the summary's medians and leak percentiles match the 2 s PLD data, but the maxima come from finer data.

## Edge cases

`cases` adds nights, each built around one edge case that ingest must handle. It's `'all'` or a list of names, and defaults to none, so tests get edge cases only when they ask. Each case's first night is the day after the previous night, and each case uses its own generator, seeded from `seed` plus the case's name. The base nights are the same with or without cases. A test that wants one case on its own passes `nights: 0`:

```ts
const { nights, zone } = syntheticNights({
  seed: 7,
  nights: 0,
  cases: ["noon-edge"],
})._unsafeUnwrap();
```

A case generates ordinary nights with `randomNight`, or sets a night's mask-on periods and BRP file times by hand through `nightFromLayout`. With `randomEvents`, `nightFromLayout` adds the model's own events and pauses inside the segments, and `extraEvents` go wherever the case puts them. The model then generates the pauses, 2 s series, and STR.edf values as it does for any night, so they match the layout.

| Case | What it tests |
|---|---|
| `many-periods` | 13 mask-on periods: 10 in STR.edf's slots and 3 derived. Period 5 starts 40 s after period 4, so period 5's file is within 60 s of both slots, and ingest assigns the file to the slot it overlaps most. Period 11's two files are 90 s apart, so ingest joins them. Periods 12 and 13 are 91 s apart, so ingest keeps them separate. Ingest counts an event 45 s before a period as inside that period, and an event 120 s after a period as outside mask-on. |
| `noon-edge` | The first period starts at 11:55 on the device clock, before the night's noon, so STR.edf's slot 0 has a mask-off but no mask-on. Ingest starts that session at noon. |
| `sub-minute-period` | A 30 s period between two others, too short for a BRP file. STR.edf records its mask-on and mask-off in the same minute, so ingest drops it and the night's session count is approximate. |
| `folderless-day` | Six hours of use that only STR.edf records. The night's DATALOG folder is missing, so ingest writes only a `daily_usage` row for the night. |
| `unused-days` | Two nights 3 days apart. STR.edf stores every value of the two days between as -1, except their Date, and `daily_usage` records 0 for both days. |
| `settings-change` | Two nights. The second night's maximum pressure is 1 cmH2O higher, so ingest writes one `settings_changes` row. |
| `ahi-rounding` | 18 hypopneas in 400 minutes. The AHI is exactly 2.7, but floating-point division returns a value just under 2.7. |
| `damaged-files` | One night whose files include a 2-minute stretch with header-only BRP, PLD, and SAD files; a truncated BRP; a BRP with a -1 count; and BRP, PLD, and SAD files holding one more record than they declare. |
| `split-files` | One night with a BRP that has no PLD, a PLD split into two files halfway through its BRP, and three EVE files, the last without a CSL. |
| `fall-back` | A night from 21:00 across the zone's next fall-back, so 01:00 happens twice. |
| `spring-forward` | A night from 21:00 across the zone's next spring-forward, so there's no 02:00. |

`'all'` leaves out `fall-back` and `spring-forward`, because their dates depend on the time zone. A caller must request them by name. Each DST case calls Temporal's `getTimeZoneTransition` to find the zone's next transition after the first night, and returns a `no_dst_transition` error if the zone doesn't observe daylight saving time. Unit tests that bucket or format times request these cases.

## The 25 Hz waveform

`renderBrp(segment, night)` in `@airway/synthetic/signals` generates a segment's 25 Hz flow and pressure when a file needs them. Rendering on demand keeps about 6 MB a night out of the model, and the segment's seed makes every render of a segment identical.

`breaths(segment, night)` lays out the breaths first. Each breath's length follows the 2 s breathing rate at its start, and its volume follows the 2 s tidal volume, shrunk to 40% during a hypopnea. Breathing in takes 40% of a breath. No breath crosses a pause, so each pause lasts exactly as long as the model says. A breath shortened to fit before a pause moves proportionally less air, so its peak stays normal. The model starts every pause and event at least 10 s into its segment, so the first breaths always have room.

Flow is a half sine wave up while breathing in and a half sine wave down while breathing out. The inhale's height is set so the area under it equals the breath's volume. During a pause, flow is uniform noise within ±0.002 L/s. That noise is below the 0.01 L/s threshold that the pediatric step uses to detect a crossing, and below 5% of a child's breath, so the step can't count noise as a breath. Pressure follows the 2 s pressure, and drops to the EPR pressure while breathing out.

## A night's files

`@airway/synthetic/files` turns the model into EDF bytes, one file at a time. Each file comes with its start time on the device's clock, which `cpapData` turns into its file name. The device's clock keeps the zone's winter offset all year, and `toDeviceTime` in `@airway/contract/clock` converts an instant to that clock.

- `nightFiles(night, zone)` writes a BRP, a PLD, and a SAD file for each segment, with the damage that the segment specifies. It also writes an EVE file for each entry in `eventFiles`, and a CSL file for each entry marked as having a CSL file. PLD and SAD files start 1 s after their BRP file, as on the real machine. SAD holds only missing values, as on a machine without an oximeter. Each event goes in the last EVE file that starts at or before it. Each EVE file starts with a "Recording starts" annotation, then lists its events. As on the machine, an event's onset is the time from the file's start to the event's end. `nightFiles` writes each apnea's duration, and a duration of 0 for hypopneas and arousals, because the machine doesn't time them. CSL holds only "Recording starts".
- `strFile(nights, zone)` writes STR.edf with one record per day, from the earliest night to the latest, whatever order the nights come in. A day with no night is unused. Its record holds its Date, and every other value is -1, as on the card. MaskOn and MaskOff hold up to 10 mask-on periods, in minutes since noon on the device's clock; unused slots are -1. A mask-on before the night's noon belongs to the previous day's record, so MaskOn in that period's slot is -1.

The serial, patient, and recording fields hold invented values.

## The CPAP data folder

`cpapData(nights, zone)` in `@airway/synthetic/cpap-data` returns the whole folder as a list of paths and bytes, laid out as on an SD card:

```
Identification.tgt
Identification.crc
STR.edf
DATALOG/
  20300107/                     the night
    20300107_213412_BRP.edf     the file's start on the device clock
    20300107_213412_BRP.crc
    20300107_213413_PLD.edf
    20300107_213413_PLD.crc
    ...
    20300108_013005_BRP.edf     started after midnight, still in the evening's folder
```

- `Identification.tgt` has the card's 16 `#KEY value` lines, each starting with CRLF and ending with LF. `#SRN` is the same serial as in the EDF headers, and `#PNA` is the model. The rest are placeholders.
- Every file in `DATALOG` has a `.crc` file beside it. The `.crc` holds two CRC-32 values, each 4 bytes in little-endian order: one for the file's first 256 bytes and one for the rest. `Identification.crc` is the CRC-32 of the whole `.tgt`. As on the card, `STR.edf` goes without a `.crc`.
- `cpapData` writes a folder only for a night with at least one segment.

## Derived rows

`synthesize(nights, zone, { patient, arrivedAt })` in `@airway/synthetic/synthesize` returns the CPAP data folder and the rows that ingest should derive from it, as one list per derived table. Both come from the same nights, so a test that edits a night gets files and rows that agree. The row types live in `@airway/contract/derived/rows`, and ingest writes the same shapes.

```ts
const { nights, zone } = syntheticNights({ seed: 7, nights: 10 })._unsafeUnwrap();
const result = synthesize(nights, zone, { patient: "child", arrivedAt });

if (result.isErr()) {
  throw new Error(`can't synthesize: ${result.error.kind}`);
}

const { files, rows } = result.value;
// rows.nights[0].ahi_check is "match"; rows.samples holds one row per 2 s.
```

The rows follow ingest's rules:

- `buildSessions` builds the sessions and `assignEvents` assigns each event to a session. Ingest calls the same two functions ([Ingest](ingest.md#sessions)).
- `synthesize` computes event starts as ingest does ([Ingest](ingest.md#events)) and rounds each onset to a whole second, because EVE stores whole seconds.
- The first sample is at the PLD file's start, which is 1 s after the segment's start. The rest follow every 2 s.
- The breath rows are the breaths that the model laid out. `amplitude` is the in-breath's peak flow, and `duration` covers the in-breath and out-breath, so a pause is a gap between breaths.
- `synthesize` reads the header of each file it writes with `readHeader`, as ingest does, and uses the size check that `readHeader` returns. `synthesize` builds segments, samples, and the `segment` column of `files` by the rules in [Ingest](ingest.md#segments), which has a diagram of how BRP and PLD files map to segments.
- `files` lists Identification.tgt, STR.edf, and each BRP, PLD, and EVE file that `checkFileSize` reads or skips, with its size and SHA-256. It also lists Identification.crc and the `.crc` of each BRP, PLD, and EVE file, rejected ones included, because ingest imports `.crc` files by size alone. Ingest skips SAD and CSL files and their `.crc` files.
- `daily_usage` covers every day from the first night to the last, with 0 on a day with no night.
- `settings_changes` comes from the contract's `settingsChanges`, called with every STR.edf day and the first night that has a folder. A change made on a night with no folder is recorded on that night.
- A night with no segments has no folder, so ingest never sees it. Ingest writes only a `daily_usage` row for that night.
- `synthesize` sets every `ctime` and `arrived_at` to `arrivedAt`.

### Ingest's acceptance target

Ingesting `synthesize`'s files must produce its rows. The comparison skips `ctime`, `arrived_at`, and `built_at`, which depend on when the import ran. Ingest finds breaths with its own detector, so breaths are compared within these tolerances, measured with a prototype detector on synthetic nights:

| Measure | Tolerance |
|---|---|
| Breaths per segment | equal, or off by one |
| Start | 0.1 s |
| Volume | 2% |
| Amplitude | 3% |
| Duration | 3% |

## Loading into Postgres

`loadDerived(client, rows, { schema, builtAt })` in `@airway/synthetic/load` puts `synthesize`'s rows in a database, in one transaction. A query engine test can build the nights it needs, edit them, and load them:

```ts
test("counts a night with 12 mask-on periods", async ({ databaseUrl }) => {
  const { nights, zone } = syntheticNights({ seed: 3, nights: 60 })._unsafeUnwrap();
  const busy = nights.filter((night) => night.periods.length > 10);
  const { rows } = synthesize(busy, zone, { patient: "child", arrivedAt })._unsafeUnwrap();
  const client = new pg.Client(databaseUrl);
  await client.connect();

  try {
    await loadDerived(client, rows, { builtAt: arrivedAt });
    // ...query derived.nights
  } finally {
    await client.end();
  }
});
```

`loadDerived` creates the schema with `derivedTables` and COPYs each table, parent tables first. It then builds the indexes and the foreign keys of `samples` and `breaths`, fills `period_percentiles` with the same statement that ingest uses, writes `meta`, and grants SELECT to `airway_reader`. Signal values go in as decimal text rounded to their column's decimals, as ingest writes them, so `leak = 0.4` matches. On an error it rolls back and throws Postgres's error, so the test fails with that error. A 30-night load takes about 3.5 seconds.

## pnpm synth

`pnpm synth` builds the generator into `packages/synthetic/dist/cli.js`, then runs it to write a CPAP data folder to disk, for local development and end-to-end tests:

```sh
pnpm synth --out /tmp/airway-cpap-data [--seed 1] [--nights 10] [--patient child|adult] \
  [--cases all|none|<name>,<name>...] [--time-zone America/Chicago]
```

It defaults to 10 child nights from seed 1, including any short or bad nights the model generates, followed by every edge case in `'all'`. `--cases` defaults to `all`, where `syntheticNights` defaults to none, so local development and end-to-end tests always include the edge cases. Pass `none` for plain nights, or a list of case names, which can include the DST cases. `--time-zone` is the zone used for bedtimes, DST nights, and the device clock's offset. It defaults to America/Chicago, the zone in `.env.example`.

It prints the `AIRWAY_TIME_ZONE` that the server must use. With any other zone, the server imports the folder's nights at the wrong times. The `--out` folder must be empty or not exist yet, so synthetic files never mix with real files or with an older run's files.

## Checking a file's size

`checkFileSize({ size, headerBytes, recordBytes, declaredRecords })` in `@airway/edf/size` decides what ingest does with a file by comparing the file's size with the size that its header declares. `readHeader` calls it when it parses a header. `synthesize` reads every file it writes, and ingest reads every file it scans, so the synthetic rows and ingest follow one rule.

| On disk | `verdict` | `header` or `reason` |
|---|---|---|
| exactly the declared records | `read` | `header: matches` |
| whole records under a -1 count, EDF's "unknown" | `read` | `header: unknown_length` |
| more whole records than declared | `read`, every record | `header: undercounted` |
| a header and no records | `skip` | `header: matches` or `unknown_length` |
| fewer records than declared | `reject` | `reason: truncated` |
| a trailing partial record | `reject` | `reason: partial_record` |

A `read` or `skip` verdict includes `records`, the record count computed from the file's size. A file that's short and also ends mid-record is `truncated`.

## Writing EDF files

`@airway/edf/write` writes the bytes of any file type that `@airway/edf/airsense` lists. The synthetic generator uses it to write its files.

- `writeSignals(file, header, values)` takes one `Float64Array` of physical values for every label except `Crc16`. Each value is rounded to the signal's step and clamped to its digital range. `NaN` means "no value" and is written as -1, the machine's marker for missing data. That marker works only where -1 is outside the signal's digital range, as in SAD and STR.edf. For a signal such as flow, where -1 is a real value, `writeSignals` returns an error for `NaN`.
- `writeAnnotations(file, header, annotations)` writes an EDF+D file with one annotation per record, as the machine does. Each record starts with the timekeeping entry EDF+ requires. An EVE record holds 38 bytes of annotation text. `writeAnnotations` returns an error for a longer annotation. It also returns an error for a negative onset, because the machine writes every onset at or after the file's start.

The header's start time is a zoneless `Temporal.PlainDateTime` on the device's clock. The writer pads header text fields with spaces to their length in bytes, because a character can take more than one byte: `°C` takes 3 bytes in UTF-8. The record count comes from the data, so a file's size is always its header plus its records.

Both functions return a `Result`. The errors name the signal or field at fault: a missing signal, a signal that doesn't fill a whole number of records, `NaN` where -1 is a real value, signals with different record counts, text too long for its field, or an annotation too long for its record.

The writer's tests read each file back with `@airway/edf`'s reader. They also check the main header's byte offsets, the stored int16 values, and each record's checksum against the raw bytes. The reader's own tests build their bytes from literal text without the writer.
