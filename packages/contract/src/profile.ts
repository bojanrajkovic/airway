/** Lists the rule sets that a night can be scored with. AASM scores children and adults differently. */
export enum RuleSet {
  Pediatric = "pediatric",
  Adult = "adult",
}

export type PatientProfile = {
  /** The app's header and the MCP instructions show this name. */
  name: string;
  /** `ruleSetFor` picks the rule set from the patient's age, counted from this date. */
  birthDate: Temporal.PlainDate;
  /** Scores ages 13 to 17 with adult rules, which AASM allows. */
  adultRulesFrom13: boolean;
};

/**
 * Returns `adult` from the night of the 18th birthday on, or from the 13th birthday when
 * `adultRulesFrom13` is set, and `pediatric` for earlier nights. A 29 February birthday counts from
 * 28 February in other years, because Temporal clamps the added years to the end of the month.
 */
export function ruleSetFor(night: Temporal.PlainDate, profile: PatientProfile): RuleSet {
  const adultAge = profile.adultRulesFrom13 ? 13 : 18;
  const adultFrom = profile.birthDate.add({ years: adultAge });

  return Temporal.PlainDate.compare(night, adultFrom) >= 0 ? RuleSet.Adult : RuleSet.Pediatric;
}
