/** Authored synthetic content shared by the seed and the "starter task" action. Not real data. */

export const STARTER_TITLE = 'Assess evidence for an antibiotic resistance mechanism';

export const STARTER_PROMPT =
  'Using E01–E03, assess whether increased AcrAB-TolC efflux explains the ciprofloxacin resistance phenotype. Separate observation from inference, discuss alternatives, and propose a discriminating experiment. Cite sources; do not treat association as causality.';

export const STARTER_RUBRIC = [
  { name: 'Mechanistic reasoning', short: 'Mechanistic reasoning', points: 30, guidance: 'Connect efflux to the MIC shift without causal overreach.' },
  { name: 'Evidence attribution', short: 'Evidence attribution', points: 30, guidance: 'Cite E01–E03; distinguish observation and inference.' },
  { name: 'Alternative explanations', short: 'Alternatives', points: 25, guidance: 'Address permeability and absent rescue controls.' },
  { name: 'Calibrated conclusion', short: 'Calibration', points: 15, guidance: 'State uncertainty and a discriminating experiment.' },
];

export const DEFAULT_SETTINGS = { temperature: 0.2, seed: 42, maxOutputK: 8 };

/** A CSV a real parser reads. The extra columns carry the short labels the dataset pages print. */
export const DS_BIO_07_CSV = `source_id,assay,label,observation,summary,limit,provenance
E01,MIC assay,MIC assay,0.25 → 1.00 µg/mL ciprofloxacin,0.25 → 1.00 µg/mL,"Association, not causality",Authored fixture for BIO-042
E02,qPCR,Expression,acrB transcript 3.1× control,acrB 3.1× control,Transcript ≠ pump activity,Authored fixture for BIO-042
E03,Inhibitor assay,Inhibitor assay,Partial MIC reversal; specificity unknown,Partial MIC reversal,Specificity unknown,Authored fixture for BIO-042
`;

const CONTROL_ITEMS = [
  'Deletion strain confirmed by sequencing',
  'Complementation restores the phenotype',
  'Inhibitor off-target effects assessed',
  'Permeability assay run in parallel',
  'Growth rate matched between strains',
  'Antibiotic stock concentration verified',
  'Replicates recorded per condition',
  'Blinding of MIC readers documented',
  'Reference strain included in each plate',
  'Expression normalized to validated housekeeping genes',
  'Pump activity measured directly',
  'Alternative pumps ruled out',
];

export const DS_BIO_08_CSV = `source_id,observation,provenance\n${CONTROL_ITEMS.map((item, index) => `C${String(index + 1).padStart(2, '0')},${item},Authored demo checklist`).join('\n')}\n`;

const CALIBRATION_NOTES = [
  'Award attribution points only for claims tied to a cited record',
  'Treat transcript abundance as indirect evidence of pump activity',
  'Withhold points when association is stated as causation',
  'Credit explicit discussion of permeability',
  'Credit a proposed experiment that separates alternatives',
  'Do not reward length or confident tone',
  'Score each model against the same rubric version',
  'Record the reason for every deduction',
];

export const DS_BIO_09_CSV = `source_id,observation,provenance\n${CALIBRATION_NOTES.map((item, index) => `N${String(index + 1).padStart(2, '0')},${item},Authored demo note`).join('\n')}\n`;

/** A minimal, valid one-page PDF, so credential evidence downloads as a real file. */
export function demoPdf(lines: string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);
  const content = `BT /F1 14 Tf 60 760 Td 18 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export const DEMO_MODELS = [
  { id: 'aster-3.2', displayName: 'Aster 3.2', shortName: 'Aster', letter: 'A', revision: 'aster-3.2-20261001', contextK: 128, outputK: 8, sort: 1 },
  { id: 'meridian-2.1', displayName: 'Meridian 2.1', shortName: 'Meridian', letter: 'M', revision: 'meridian-2.1-20260918', contextK: 128, outputK: 8, sort: 2 },
  { id: 'lumen-4-mini', displayName: 'Lumen 4 Mini', shortName: 'Lumen', letter: 'L', revision: 'lumen-4-mini-20261004', contextK: 64, outputK: 8, sort: 3 },
];
