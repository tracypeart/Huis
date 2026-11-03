/**
 * Starting points for common claims: the elements attorneys usually have to
 * prove. They are a convenience, not legal advice — every element list must
 * be checked against the controlling law for the Matter, and attorneys can
 * edit, add or remove elements, or build a claim from scratch.
 */
export interface ClaimTemplate { key: string; title: string; kind: "claim" | "defense"; source: string; elements: { label: string; details: string }[] }

export const CLAIM_TEMPLATES: ClaimTemplate[] = [
  {
    key: "fmla_retaliation", kind: "claim", title: "FMLA retaliation",
    source: "29 U.S.C. § 2615(a)(2); e.g. Metzler v. Fed. Home Loan Bank of Topeka, 464 F.3d 1164 (10th Cir. 2006)",
    elements: [
      { label: "Protected activity", details: "The employee engaged in activity protected by the FMLA (for example, requested or took FMLA leave)." },
      { label: "Adverse action", details: "The employer took an action that a reasonable employee would have found materially adverse." },
      { label: "Causal connection", details: "There is a causal connection between the protected activity and the adverse action (timing, statements, departures from policy)." },
    ],
  },
  {
    key: "fmla_interference", kind: "claim", title: "FMLA interference",
    source: "29 U.S.C. § 2615(a)(1); e.g. Metzler v. Fed. Home Loan Bank of Topeka, 464 F.3d 1164 (10th Cir. 2006)",
    elements: [
      { label: "Entitled to FMLA leave", details: "The employee was entitled to FMLA leave (eligible employee, covered employer, qualifying reason, notice)." },
      { label: "Interference", details: "An action by the employer interfered with the employee's right to take FMLA leave or to be restored afterwards." },
      { label: "Related to FMLA rights", details: "The employer's action was related to the exercise or attempted exercise of FMLA rights." },
    ],
  },
  {
    key: "title_vii_retaliation", kind: "claim", title: "Title VII retaliation",
    source: "42 U.S.C. § 2000e-3(a); Burlington N. & Santa Fe Ry. v. White, 548 U.S. 53 (2006); Univ. of Tex. Sw. Med. Ctr. v. Nassar, 570 U.S. 338 (2013)",
    elements: [
      { label: "Protected opposition or participation", details: "The employee opposed discrimination made unlawful by Title VII, or took part in a Title VII proceeding." },
      { label: "Materially adverse action", details: "The employer's action might well have dissuaded a reasonable worker from making or supporting a charge of discrimination." },
      { label: "Causal connection", details: "The protected activity was a but-for cause of the adverse action." },
    ],
  },
  {
    key: "ada_discrimination", kind: "claim", title: "ADA disability discrimination",
    source: "42 U.S.C. § 12112",
    elements: [
      { label: "Disability", details: "The employee is disabled within the meaning of the ADA." },
      { label: "Qualified", details: "The employee could perform the essential functions of the job, with or without reasonable accommodation." },
      { label: "Discrimination because of disability", details: "The employer took adverse action against the employee because of the disability." },
    ],
  },
  {
    key: "breach_of_contract_ut", kind: "claim", title: "Breach of contract (Utah)",
    source: "e.g. America West Bank Members, L.C. v. State, 2014 UT 49",
    elements: [
      { label: "A contract", details: "A contract existed between the parties." },
      { label: "Performance", details: "The party seeking recovery performed its obligations." },
      { label: "Breach", details: "The other party breached the contract." },
      { label: "Damages", details: "The breach caused damages." },
    ],
  },
  {
    key: "wrongful_termination_public_policy_ut", kind: "claim", title: "Wrongful termination in violation of public policy (Utah)",
    source: "e.g. Ryan v. Dan's Food Stores, Inc., 972 P.2d 395 (Utah 1998); Touchard v. La-Z-Boy Inc., 2006 UT 71",
    elements: [
      { label: "Termination", details: "The employer terminated the employee." },
      { label: "Clear and substantial public policy", details: "A clear and substantial public policy existed." },
      { label: "Conduct implicating the policy", details: "The employee's conduct brought the policy into play." },
      { label: "Causation", details: "The discharge and the conduct bringing the policy into play are causally connected." },
    ],
  },
];

export const TEMPLATE_NOTE = "A starting point, not legal advice: check every element against the controlling law for this Matter.";
