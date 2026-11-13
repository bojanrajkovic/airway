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

## Writing EDF files

`@airway/contract/edf/write` writes the bytes of any file type in the list. The synthetic generator uses it to write its files.

- `writeSignals(file, header, values)` takes one `Float64Array` of physical values per label, leaving out `Crc16`. Each value is rounded to the signal's step and clamped to its digital range. `NaN` means "no value" and is written as -1, the machine's marker for missing data. That marker only works where -1 is outside the signal's digital range, as in SAD and STR.edf, so `NaN` for a signal such as flow, where -1 is a real value, is an error.
- `writeAnnotations(file, header, annotations)` writes an EDF+D file with one annotation per record, as the machine does. Each record starts with the timekeeping entry EDF+ requires. An EVE record holds 38 bytes of annotation text, and a longer annotation returns an error.

The header's start time is a `Temporal.PlainDateTime` on the device's clock, which has no zone. Header text fields are padded with spaces by bytes, not characters, because `°C` takes 3 bytes in UTF-8. The record count comes from the data, so a file's size is always its header plus its records.

Both functions return a `Result`. The errors name the signal or field at fault: a missing signal, a signal that doesn't fill a whole number of records, `NaN` where -1 is a real value, signals with different record counts, text too long for its field, or an annotation too long for its record.

The writer's tests read files back with a small reader in `packages/contract/tests/edf/test-reader.ts`.
