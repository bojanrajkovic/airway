# Waveforms

The waveform viewer and how it reads windows of signal data.

The viewer and the window reader aren't built yet. The contract already defines what the two waveform procedures take and return, in `@airway/contract/api/waveform`.

## Procedures

| Procedure | Takes | Returns |
|---|---|---|
| `waveform.window` | `{night, from, to, buckets}` | `WaveformData`: each lane's values over the window, and the events that overlap it |
| `waveform.night` | `{night}` | `WaveformOverview`: the whole-night strip, with sessions, the time ranges that have recordings, and events |

The viewer sets `buckets` to the plot's width in pixels, at most 4,000, and asks again on each zoom or pan.

## Lanes

There are four lanes: flow and pressure from BRP at 25 Hz, and leak and flow limitation from PLD at 2 s. Each is in its stored unit and split into pieces, one per recording file. Pieces never join across a gap between files, so the line breaks there.

A piece's values are evenly spaced from its start time. While a bucket holds more than two samples, each point is the bucket's lowest and highest value (`kind: "range"`). When a bucket holds two samples or fewer, the points are the raw samples (`kind: "samples"`), so zooming in reaches single breaths.
