/** Each night uses one of these rule sets. AASM scores children and adults differently. */
export const RULE_SETS = ["pediatric", "adult"] as const;
export type RuleSet = (typeof RULE_SETS)[number];

export type PatientProfile = {
  /** Shown in the app's header and in the MCP instructions. */
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

  return Temporal.PlainDate.compare(night, adultFrom) >= 0 ? "adult" : "pediatric";
}
