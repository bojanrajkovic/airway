/** Which scoring rules a night uses. AASM scores children and adults differently. */
export const RULE_SETS = ["pediatric", "adult"] as const;
export type RuleSet = (typeof RULE_SETS)[number];

export type PatientProfile = {
  /** Shown in the app's header and in the MCP instructions. */
  name: string;
  /** Picks the rule set. */
  birthDate: Temporal.PlainDate;
  /** AASM lets ages 13 to 17 be scored with adult rules; this turns that on. */
  adultRulesFrom13: boolean;
};

/**
 * The rule set for `night`: adult from the night of the 18th birthday on, or from the 13th with
 * `adultRulesFrom13`, and pediatric before it. A 29 February birthday counts from 28 February in
 * other years, because Temporal clamps the added years to the end of the month.
 */
export function ruleSetFor(night: Temporal.PlainDate, profile: PatientProfile): RuleSet {
  const adultAge = profile.adultRulesFrom13 ? 13 : 18;
  const adultFrom = profile.birthDate.add({ years: adultAge });

  return Temporal.PlainDate.compare(night, adultFrom) >= 0 ? "adult" : "pediatric";
}
