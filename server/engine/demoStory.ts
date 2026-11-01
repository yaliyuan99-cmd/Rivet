/**
 * The authored BIO-042 outputs and scores. They mirror the seed's RUN-1042 so that re-running the
 * starter prompt reproduces the story; tests/api/evaluation.test.ts fails if the two drift apart.
 * Synthetic content, not real model output.
 */

export interface AuthoredOutput {
  output: string;
  scores: [number, number, number, number];
  notes: [string, string, string, string];
}

export const AUTHORED_OUTPUTS: Record<string, AuthoredOutput> = {
  'aster-3.2': {
    output: 'The fourfold MIC shift is consistent with an efflux contribution [E01]. Increased acrB expression and inhibitor sensitivity support this hypothesis [E02, E03]. These observations do not establish AcrAB-TolC as the sole cause. A controlled deletion and complementation experiment would discriminate alternatives.',
    scores: [28, 25, 20, 13],
    notes: ['Plausible, not proven', 'Inhibitor caveat missing', 'Permeability discussed briefly', 'Discriminating follow-up'],
  },
  'meridian-2.1': {
    output: 'The MIC rises from 0.25 to 1.00 µg/mL [E01] and acrB transcript is 3.1× control [E02], which together suggest that efflux contributes to the phenotype. Partial MIC reversal with the inhibitor points the same way [E03]. Reduced permeability could also contribute and has not been excluded. A deletion strain would help confirm the mechanism.',
    scores: [26, 23, 20, 12],
    notes: ['Reasonable link to the MIC shift', 'E03 specificity not questioned', 'Permeability named, not examined', 'Follow-up stated without controls'],
  },
  'lumen-4-mini': {
    output: 'Ciprofloxacin resistance here is probably driven by increased AcrAB-TolC efflux: the MIC increased fourfold [E01], acrB expression is higher [E02], and the inhibitor partly reverses the shift [E03]. Other mechanisms may play a role. Further experiments are recommended.',
    scores: [24, 20, 18, 12],
    notes: ['Leans towards causal language', 'Citations present; limits not stated', 'Alternatives only gestured at', 'No discriminating experiment named'],
  },
};

export const AUTHORED_CONSEQUENTIAL = 'Aster distinguishes a plausible efflux mechanism from a causal claim. Its attribution deduction reflects a missing inhibitor-specificity caveat.';
