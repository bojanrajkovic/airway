# Waveforms

The waveform viewer and how it reads windows of signal data.

The viewer and the window reader aren't built yet. `@airway/contract/api/waveform` already defines what the two waveform procedures take and return.

## Procedures

| Procedure | Takes | Returns |
|---|---|---|
| `waveform.window` | `{night, from, to, buckets}` | `WaveformData`: each signal's values over the window, and the events that overlap it |
| `waveform.night` | `{night}` | `WaveformOverview`: the whole-night strip, with sessions, the time ranges that have recordings, and events |

The viewer sets `buckets` to the plot's width in pixels, up to 4,000. It calls `waveform.window` again on each zoom or pan.

## Signals

The viewer plots four signals, which `WaveformData` holds in `lanes`. Flow and pressure come from BRP files, sampled at 25 Hz. Leak and flow limitation come from PLD files, sampled every 2 s. The server returns each signal in its stored unit, split into one piece per recording file. A gap between files separates two pieces, so the plotted line breaks at the gap.

A piece's values are evenly spaced from its start time. When a bucket holds more than two samples, each point is the bucket's lowest and highest value (`kind: "range"`). When a bucket holds two samples or fewer, the points are the raw samples (`kind: "samples"`), so zooming in far enough shows single breaths.
