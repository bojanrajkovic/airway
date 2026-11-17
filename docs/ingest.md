# Ingest

How airway reads the CPAP data folder and builds the derived tables.

The importer isn't built yet. The rules it shares with the synthetic data generator are, and this page describes them.

## Reading EDF files

`@airway/edf` reads the card's EDF files. BRP, PLD, SAD, and `STR.edf` are plain EDF. EVE and CSL are EDF+D, and hold annotations.

### Headers

`readHeader(bytes, size)` parses a header and returns `{header, size, warnings}`:

- `header` holds every field ingest uses: the format, the start time on the device clock, the patient and recording fields, the header length, the declared record count, the record length in seconds, and each signal's label, unit, physical and digital ranges, and samples per record.
- `size` is `checkFileSize`'s verdict for the file's size on disk: `read`, `skip`, or `reject`. Only a file whose verdict is `read` can be decoded; `isReadable(file)` checks that.
- `warnings` lists anything the header contradicts without stopping the read. A `startdate_mismatch` means the recording field's `Startdate` names a different day from the header's start date.

`bytes` must hold the whole header, and `size` defaults to `bytes.length`. A scan that reads only headers reads 256 bytes first. If `readHeader` returns `header_too_short`, its `headerBytes` says how many bytes the header takes, 256 for each signal plus 256.

The start date has a two-digit year. As EDF+ specifies, 85 to 99 mean 19xx and the rest mean 20xx.

A field that won't parse returns `bad_field` with the field's name and text.

## Sessions

A session is one mask-on period. `buildSessions` in `@airway/contract/derived/sessions` builds a night's sessions from `STR.edf` and the night's BRP segments:

1. Each used `STR.edf` slot is a session with `source = str`. Its times are the slot's minutes since noon on the device clock, converted with the night's clock offset. A slot 0 with a mask-off but no mask-on starts at noon. A slot whose mask-on and mask-off are the same minute lasted under a minute and makes no session, so that night's count can't match `MaskEvents`.
2. Each BRP segment joins the `str` session it overlaps most, allowing 60 s on either side, because `STR.edf` keeps whole minutes.
3. `STR.edf` has only 10 slots, but `MaskEvents` counts every period. Segments that match no slot join their neighbor when the gap is 90 s or less, and each run becomes a session with `source = derived`.
4. Sessions are numbered from 1 in time order. A night is flagged approximate when its session count differs from `MaskEvents / 2`.

The 90 s join can't be exact: the machine starts new BRP files inside one period, and some gaps between files are longer than some short mask-off breaks. The approximate flag tells the reader when the counts disagree.

`assignEvents` puts each event in the session that contains it, allowing 60 s on either side. An event outside every session goes to the nearest one and is marked `outside_mask_on`, so the sessions' counts add up to the night's total. On a night with no sessions, an event has no session.

## Events

An EVE annotation's onset marks the end of the event, so an event starts at its onset minus its duration.
