# Scoring

How airway computes and labels its numbers.

## Rule sets

AASM scores children and adults with different rules. `ruleSetFor(night, profile)` in `@airway/contract/profile` picks one per night from the patient's birth date:

- **pediatric** before the night of the 18th birthday, and **adult** from that night on;
- with `AIRWAY_ADULT_RULES_FROM_13=true`, adult from the night of the 13th birthday instead, as AASM allows for ages 13 to 17.

A 29 February birthday counts from 28 February in other years.

Nothing else in scoring is built yet.

## derived_version

Every change to how airway derives its tables raises `derived_version`, and gets an entry here: the version, what changed, and which numbers move.

| Version | What changed |
|---|---|
| 1 | The first tables: the machine's `STR.edf` statistics and events, sessions and segments, 2 s samples, and breaths. [Data model](data-model.md#derived-tables) lists them |
