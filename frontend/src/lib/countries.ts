/** ISO codes of countries that have universities in the open directories. */
export const WORLD_COUNTRIES =
  "AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FO FR GA GB GD GE GF GH GL GM GN GP GQ GR GT GU GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MD ME MG MK ML MM MN MO MR MS MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NU NZ OM PA PE PF PG PH PK PL PR PS PT PY QA RE RO RS RU RW SA SC SD SE SG SI SK SL SM SN SO SR SS SV SY SZ TC TD TG TH TJ TM TN TR TT TW TZ UA UG US UY UZ VA VC VE VG VN WS XK YE ZA ZM ZW".split(" ");

const names = new Intl.DisplayNames(["en"], { type: "region" });
const OVERRIDES: Record<string, string> = { KR: "South Korea", KP: "North Korea", CZ: "Czech Republic", TR: "Türkiye", XK: "Kosovo" };

export function countryLabel(code: string): string {
  return OVERRIDES[code] ?? names.of(code) ?? code;
}
