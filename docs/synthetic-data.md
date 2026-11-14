# Synthetic data

How the synthetic SD-card data that tests, screenshots, and local development use is generated. Everything here is invented. No value, date, serial, or name comes from a real night.

## The AirSense 10's signals

`@airway/contract/edf/airsense` lists every EDF file type the AirSense 10 writes, as its headers declare them. The EDF writer uses it, and ingest's reader will too, so writing and reading follow one description of the format.

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

`step(signal)` gives one digital step in physical units, such as 0.002 L/s for flow. Every data record ends with a `Crc16` signal: the CRC-16/CCITT-FALSE of the record's other bytes, little-endian. The writer computes it the same way.

These details are the same on every AirSense 10. They come from the headers of real files and describe only the format.

## Synthetic nights

`syntheticNights({ seed, nights, start, patient, zone })` in `@airway/synthetic/model` builds the nights everything else is written from. The same options always give the same nights. All randomness comes from d3-random distributions drawing on one seeded generator.

```ts
const nights = syntheticNights({ seed: 7, nights: 30 });
// nights[0].night is 2030-01-07; nights[0].str.get("AHI") is the machine's AHI for it.
```

Each night holds:
- `periods`: the mask-on periods, as UTC instants. Each is one session.
- `segments`: the BRP files' stretches, a whole number of minutes each. Each segment stores PLD's nine 2 s series and a seed for its 25 Hz detail.
- `events`: what the machine scores and writes to EVE.
- `pauses`: gaps in breathing the flow signal shows. There are three kinds:

  | Kind | Length | In EVE? | What should flag it |
  |---|---|---|---|
  | `machine_apnea` | 10 to 30 s | yes | the machine |
  | `pediatric` | 2 breaths to 10 s | no | only airway's pediatric step |
  | `dip` | under 2 breaths | no | nothing |

- `str`: the night's STR.edf values by label, rounded to each signal's step. `NaN` marks values the machine writes as -1, such as SpO2 without an oximeter. `strFile` fills in Date, MaskOn, and MaskOff, which depend on the device clock, and the writer adds each record's Crc16.

Unused days are days with no night in the list.

`patient` is `child` (the default) or `adult`, and sets only the numbers in `@airway/synthetic/patients`: mask-on periods, file gaps, rate, breath size, event and pause rates, leak, and settings. All are invented round numbers. The scoring rules still come from the configured birth date.

Mask-on periods and file gaps differ by patient:

| | Child | Adult |
|---|---|---|
| Mask-on periods | 1 to 10, or 11 to 20 on about 1 night in 6 | 1 to 6 |
| Gap between BRP files in one period | 5 to 120 s, mostly 30 to 90 s | 5 to 90 s |

STR.edf has slots for 10 periods, so on a child's longer nights ingest rebuilds the rest from BRP files, joining files 90 s or less apart. A child's file gaps fall on both sides of 90 s, so those nights test the join's mistakes too. Adult nights stay inside the slots and under 90 s, so ingest's sessions always match their periods.

Breaks between periods are 60 s plus a long-tailed draw: a median near 200 s, sometimes 25 minutes or more, at most 3 hours. On a night with many periods, the breaks shrink so the last mask-off comes by 11:00. Files after noon would belong to the next night.

Ordinary variation comes from the seed: about 1 night in 8 is short, about 1 in 10 is bad with four times the events, events sometimes cluster, and leak spikes for a few minutes now and then.

The AHI and its parts are `(600 × events) div minutes` in tenths, and MaskEvents is twice the sessions. The STR medians and leak percentiles are computed from the stored 2 s series. The maxima and pressure statistics are drawn near them instead. That's how the real machine's summary relates to its PLD files: its medians and leak percentiles match the 2 s data, but its maxima come from finer data.

## The 25 Hz waveform

`renderBrp(segment, night)` in `@airway/synthetic/signals` draws a segment's 25 Hz flow and pressure when a file needs them. That saves storing about 6 MB a night in the model, and the segment's seed makes the result the same every time.

`breaths(segment, night)` lays out the breaths first. Each breath's length follows the 2 s breathing rate at its start, and its volume follows the 2 s tidal volume, shrunk to 40% during a hypopnea. Breathing in takes 40% of a breath. No breath crosses a pause, so each pause lasts exactly as long as the model says. A breath shortened to fit before a pause moves proportionally less air, so its peak stays normal. The model starts every pause and event at least 10 s into its segment, so the first breaths always have room.

Flow is a half sine wave up while breathing in and a half sine wave down while breathing out. The inhale's height is set so the area under it equals the breath's volume. During a pause, flow is uniform noise within ±0.002 L/s. That's under the pediatric step's 0.01 L/s crossing threshold and under 5% of a child's breath, so noise can't fake a breath. Pressure follows the 2 s pressure, and drops to the EPR pressure while breathing out.

## A night's files

`@airway/synthetic/files` turns the model into EDF bytes, one file at a time. Each file comes with its start time on the device's clock, which `cpapData` turns into its file name. The device's clock runs on the night's fixed offset from `AIRWAY_CLOCK_OFFSETS` and doesn't change for daylight saving time.

- `nightFiles(night, offsets)` writes a BRP, PLD, and SAD file for each segment, and one EVE and CSL pair for the night. PLD and SAD files start 1 s after their BRP file, as on the real machine. SAD holds only missing values, as it does without an oximeter. EVE starts with a "Recording starts" annotation, then lists each event with its onset at the event's end, which is how the machine writes them. CSL holds only "Recording starts".
- `strFile(nights, offsets)` writes STR.edf with one record per day, from the earliest night to the latest, whatever order the nights come in. A day with no night is unused, and every value in its record is -1. MaskOn and MaskOff hold up to 10 mask-on periods, in minutes since noon on the device's clock; unused slots are -1.

The serial, patient, and recording fields hold invented values.

## The CPAP data folder

`cpapData(nights, offsets)` in `@airway/synthetic/cpap-data` returns the whole folder, as an SD card lays it out, as a list of paths and bytes:

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

- `Identification.tgt` has the card's 16 `#KEY value` lines, each starting with CRLF and ending with LF. `#SRN` is the serial the EDF headers name, and `#PNA` is the model. The rest are placeholders.
- Every file in `DATALOG` has a `.crc` beside it: the CRC-32 of the file's first 256 bytes, then of the rest, each 4 bytes little-endian. `Identification.crc` is the CRC-32 of the whole `.tgt`. `STR.edf` has none, as on the card.
- A night with no segments writes no files, so it has no folder.

## Derived rows

`synthesize(nights, offsets, { patient, uploadedAt })` in `@airway/synthetic/synthesize` returns the CPAP data folder together with the rows ingest should derive from it, one list per derived table. Both come from the same nights, so a test that edits a night gets files and rows that agree. The row types live in `@airway/contract/derived/rows`, and ingest writes the same shapes.

```ts
const nights = syntheticNights({ seed: 7, nights: 10 });
const result = synthesize(nights, offsets, { patient: "child", uploadedAt });

if (result.isErr()) {
  throw new Error(`can't synthesize: ${result.error.kind}`);
}

const { files, rows } = result.value;
// rows.nights[0].ahi_check is "match"; rows.samples holds one row per 2 s.
```

The rows follow ingest's rules:

- Sessions come from `buildSessions` and events get their session from `assignEvents`, the functions ingest calls ([Ingest](ingest.md#sessions)).
- An event starts at its EVE onset minus its duration, with the onset rounded to the whole second EVE keeps.
- Samples start at the PLD file's start, 1 s after the segment's, every 2 s.
- Breaths are the model's own. `amplitude` is the in-breath's peak flow, and `duration` covers the in-breath and out-breath, so a pause is a gap between breaths.
- `files` lists Identification.tgt, STR.edf, and each BRP, PLD, and EVE file, with its size and SHA-256. Ingest skips SAD, CSL, and `.crc` files.
- `column_units` has each STR and PLD signal's header unit and decimals. A breath's `amplitude` (L/s) and `inspiratory_volume` (L) come from the 25 Hz flow signal, so they take its decimals.
- `daily_usage` covers every day from the first night to the last, with 0 on a day with no night.
- `settings_changes` has a row for each setting that differs from the previous night's.
- A night with no segments has no folder, so ingest never sees it. It gets only its `daily_usage` row.
- `uploadedAt` fills every `ctime` and `uploaded_at`.

### Ingest's acceptance target

Ingesting `synthesize`'s files must produce its rows. The comparison skips `ctime`, `uploaded_at`, and `built_at`, which depend on when the import ran. Ingest finds breaths with its own detector, so breaths are compared within these tolerances, measured with a prototype detector on synthetic nights:

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
  const busy = syntheticNights({ seed: 3, nights: 60 }).filter((night) => night.periods.length > 10);
  const { rows } = synthesize(busy, offsets, { patient: "child", uploadedAt })._unsafeUnwrap();
  const client = new pg.Client(databaseUrl);
  await client.connect();

  try {
    await loadDerived(client, rows, { builtAt: uploadedAt });
    // ...query derived.nights
  } finally {
    await client.end();
  }
});
```

It creates the schema with `derivedTables`, COPYs each table parents first, then builds the indexes and the `samples` and `breaths` foreign keys, fills `period_percentiles` with the statement ingest uses, stamps `meta`, and grants `airway_reader` SELECT. Signal values go in as decimal text rounded to their column's decimals, as ingest writes them, so `leak = 0.4` matches. On an error it rolls back and throws Postgres's error, so the test fails with it. A 30-night load takes about 3.5 seconds.

## pnpm synth

`pnpm synth` writes a CPAP data folder to disk, for local development and end-to-end tests:

```sh
pnpm synth --out /tmp/airway-cpap-data [--seed 1] [--nights 10] [--patient child|adult]
```

It defaults to 10 child nights from seed 1, including any short or bad nights the model draws. It uses `.env.example`'s clock offsets, so a folder written to `.env.example`'s `AIRWAY_CPAP_DATA_PATH` imports with the example config. `--out` must be missing or empty, so synthetic files never mix with real ones or with an older run.

## Writing EDF files

`@airway/contract/edf/write` writes the bytes of any file type in the list. The synthetic generator uses it to write its files.

- `writeSignals(file, header, values)` takes one `Float64Array` of physical values per label, leaving out `Crc16`. Each value is rounded to the signal's step and clamped to its digital range. `NaN` means "no value" and is written as -1, the machine's marker for missing data. That marker only works where -1 is outside the signal's digital range, as in SAD and STR.edf, so `NaN` for a signal such as flow, where -1 is a real value, is an error.
- `writeAnnotations(file, header, annotations)` writes an EDF+D file with one annotation per record, as the machine does. Each record starts with the timekeeping entry EDF+ requires. An EVE record holds 38 bytes of annotation text, and a longer annotation returns an error.

The header's start time is a `Temporal.PlainDateTime` on the device's clock, which has no zone. Header text fields are padded with spaces by bytes, not characters, because `°C` takes 3 bytes in UTF-8. The record count comes from the data, so a file's size is always its header plus its records.

Both functions return a `Result`. The errors name the signal or field at fault: a missing signal, a signal that doesn't fill a whole number of records, `NaN` where -1 is a real value, signals with different record counts, text too long for its field, or an annotation too long for its record.

The writer's tests read files back with a small reader in `@airway/testing/edf`.
