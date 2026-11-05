# Scoring

How airway computes and labels its numbers.

## Why airway's numbers can differ from OSCAR's

airway shows the machine's own nightly numbers, read from `STR.edf`: usage, AHI and its parts, and the leak and pressure percentiles. OSCAR recomputes those numbers from the event and signal files, over sessions it builds itself. The two can round, split sessions, and count events differently, so the same night can show different numbers in each.

## derived_version

Every change to how airway derives its tables raises `derived_version`, and gets an entry here: the version, what changed, and which numbers move. No version has shipped yet.
