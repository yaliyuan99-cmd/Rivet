import { describe, expect, it } from 'vitest';
import { decodeUtf8Strict, displayRow, firstInvalidUtf8Offset, MAX_UPLOAD_BYTES, parseCsv, scanSensitiveText, validateDatasetFile } from '../../server/lib/csv.ts';

const enc = new TextEncoder();
const csv = (text: string, filename = 'sources.csv') => validateDatasetFile({ bytes: enc.encode(text), filename });
const HEADER = 'source_id,observation,provenance\n';
const codes = (result: { receipt: { failures?: { code: string }[] } }) => (result.receipt.failures ?? []).map((failure) => failure.code);
const messages = (result: { receipt: { failures?: { message: string }[] } }) => (result.receipt.failures ?? []).map((failure) => failure.message).join(' | ');

describe('the CSV parser', () => {
  it('reads quoted fields, embedded commas and embedded newlines', () => {
    const { rows, problems } = parseCsv('a,b\n"one, two","line 1\nline 2"\n');
    expect(problems).toEqual([]);
    expect(rows.map((row) => row.cells)).toEqual([
      ['a', 'b'],
      ['one, two', 'line 1\nline 2'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"say ""hi"" now"\n').rows[1]?.cells).toEqual(['say "hi" now']);
  });

  it('strips a byte order mark', () => {
    expect(parseCsv('﻿a,b\n1,2').rows[0]?.cells).toEqual(['a', 'b']);
  });

  it('handles CRLF, bare CR and a missing final newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4').rows.map((row) => row.cells)).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseCsv('a\r1\r2\r').rows.map((row) => row.cells)).toEqual([['a'], ['1'], ['2']]);
  });

  it('keeps CRLF inside a quoted field exactly', () => {
    expect(parseCsv('a\n"x\r\ny"\n').rows[1]?.cells).toEqual(['x\r\ny']);
  });

  it('skips blank lines but keeps a line of commas', () => {
    expect(parseCsv('a,b\n\n1,2\n\n,\n').rows.map((row) => row.cells)).toEqual([['a', 'b'], ['1', '2'], ['', '']]);
  });

  it('keeps an empty last field', () => {
    expect(parseCsv('a,b\n1,').rows[1]?.cells).toEqual(['1', '']);
  });

  it('counts physical lines across a multi-line record', () => {
    const { rows } = parseCsv('a,b\n"x\ny\nz",2\n3,4\n');
    expect(rows.map((row) => row.line)).toEqual([1, 2, 5]);
  });

  it('reports a quote that never closes', () => {
    const { problems } = parseCsv('a,b\n1,"open\n2,3\n');
    expect(problems[0]).toMatchObject({ code: 'unterminated_quote', line: 2 });
  });

  it('reports a stray quote and text after a closing quote', () => {
    const { problems } = parseCsv('a,b\n1,x"y\n"p"q,3\n');
    expect(problems.map((problem) => problem.code)).toEqual(['stray_quote', 'text_after_quote']);
  });

  it('handles a large file quickly and correctly', () => {
    const row = 'E,"a, quoted ""cell""",plain text value\n';
    const text = `x,y,z\n${row.repeat(200_000)}`;
    const started = Date.now();
    const { rows, problems } = parseCsv(text);
    expect(rows.length).toBe(200_001);
    expect(problems).toEqual([]);
    expect(rows[200_000]?.cells[1]).toBe('a, quoted "cell"');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('UTF-8', () => {
  it('accepts valid multi-byte text', () => {
    const decoded = decodeUtf8Strict(enc.encode('0.25 → 1.00 µg/mL 3.1× 𝛼'));
    expect(decoded).toEqual({ ok: true, text: '0.25 → 1.00 µg/mL 3.1× 𝛼' });
  });

  it('names the offset and line of a bad byte', () => {
    const decoded = decodeUtf8Strict(Uint8Array.from([...enc.encode('abc\ndef,'), 0xff, 0x41]));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.message).toBe('This file is not valid UTF-8: the byte at offset 8 (line 2) cannot be decoded. Save it as UTF-8 and upload it again.');
  });

  it('refuses Latin-1 bytes, UTF-16 and NUL bytes', () => {
    const latin1 = decodeUtf8Strict(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2c]));
    expect(latin1.ok).toBe(false);
    const utf16 = decodeUtf8Strict(Uint8Array.from([0xff, 0xfe, 0x61, 0x00]));
    expect(utf16).toEqual({ ok: false, message: 'This file is encoded as UTF-16. Save it as UTF-8 and upload it again.' });
    const nul = decodeUtf8Strict(Uint8Array.from([0x61, 0x00, 0x62]));
    expect(nul.ok).toBe(false);
  });

  it('agrees with the fatal TextDecoder on overlong forms, surrogates and truncation', () => {
    const bad = [
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
      [0x80],
    ];
    for (const sequence of bad) {
      const bytes = Uint8Array.from([0x41, ...sequence]);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
      expect(firstInvalidUtf8Offset(bytes)).toBe(1);
    }
    expect(firstInvalidUtf8Offset(enc.encode('€ 𝛼 ok'))).toBe(-1);
  });
});

describe('CSV validation', () => {
  it('passes a good file and writes the receipt', () => {
    const result = csv(`${HEADER}E01,"MIC, shifted",Authored fixture\nE02,qPCR,Authored fixture\n`);
    expect(result.receipt).toMatchObject({
      format: 'csv',
      encoding: 'UTF-8',
      requiredColumns: { missing: [], passed: 3, total: 3 },
      recordsParsed: 2,
      duplicateSourceIds: 0,
      missingSourceIds: 0,
      sensitiveData: { flags: [], note: 'No flags' },
      synthetic: true,
      failures: [],
      passed: true,
    });
    expect(result.records[0]).toEqual({ source_id: 'E01', observation: 'MIC, shifted', provenance: 'Authored fixture' });
  });

  it('names exactly which required columns are missing', () => {
    const result = csv('source_id,notes\nE01,x\n');
    expect(result.receipt.passed).toBe(false);
    expect(result.receipt.requiredColumns).toMatchObject({ missing: ['observation', 'provenance'], passed: 1, total: 3 });
    expect(messages(result)).toContain('Missing required columns: observation, provenance.');
  });

  it('matches column names regardless of case and surrounding spaces', () => {
    expect(csv(' Source_ID , OBSERVATION,provenance\nE01,x,y\n').receipt.passed).toBe(true);
  });

  it('hints when the file is not comma-delimited', () => {
    expect(messages(csv('source_id;observation;provenance\nE01;x;y\n'))).toContain('use commas');
  });

  it('reports duplicate source IDs with their rows', () => {
    const result = csv(`${HEADER}E01,a,b\nE02,c,d\nE01,e,f\nE01,g,h\n`);
    expect(result.receipt.passed).toBe(false);
    expect(result.receipt.duplicateSourceIds).toBe(2);
    expect(messages(result)).toContain('1 duplicate source ID: E01 (rows 2, 4, 5).');
  });

  it('does not repeat a sensitive value when it reports a duplicate', () => {
    const result = csv(`${HEADER}maya@helixlab.example,a,b\nmaya@helixlab.example,c,d\n`);
    expect(messages(result)).toContain('a flagged value (rows 2, 3)');
    expect(JSON.stringify(result.receipt)).not.toContain('maya@helixlab.example');
  });

  it('reports missing source IDs, observations and provenance with their rows', () => {
    const result = csv(`${HEADER},a,b\n   ,c,d\nE03,,f\nE04,g,\n`);
    expect(result.receipt.missingSourceIds).toBe(2);
    expect(codes(result)).toEqual(['missing_source_ids', 'missing_observation', 'missing_provenance']);
    expect(messages(result)).toContain('2 records have no source ID: rows 2, 3.');
    expect(messages(result)).toContain('1 record has no observation: row 4.');
  });

  it('refuses a row with the wrong number of columns', () => {
    const result = csv(`${HEADER}E01,a\nE02,b,c,d\n`);
    expect(codes(result)).toContain('column_count');
    expect(messages(result)).toContain('The header has 3 columns, but row 2 has 2, row 3 has 4.');
  });

  it('refuses repeated and empty column names', () => {
    expect(codes(csv('source_id,observation,provenance,x,X\nE01,a,b,c,d\n'))).toContain('duplicate_columns');
    expect(codes(csv('source_id,observation,provenance,\nE01,a,b,c\n'))).toContain('empty_column_name');
  });

  it('refuses a header with no records, and an empty file', () => {
    expect(codes(csv(HEADER))).toContain('no_records');
    expect(codes(csv(''))).toEqual(['empty_file']);
    expect(codes(csv('\n\n'))).toEqual(['no_header']);
  });

  it('reports quoting problems', () => {
    expect(codes(csv(`${HEADER}E01,"never closed,b\n`))).toContain('unterminated_quote');
  });

  it('refuses invalid UTF-8 without reading further', () => {
    const result = validateDatasetFile({ bytes: Uint8Array.from([...enc.encode(HEADER), 0x45, 0x30, 0x31, 0x2c, 0xe9, 0x2c, 0x62, 0x0a]), filename: 'latin.csv' });
    expect(result.receipt.encoding).toBe('Not UTF-8');
    expect(codes(result)).toEqual(['not_utf8']);
    expect(result.records).toEqual([]);
  });

  it('marks a file synthetic only when every record says so', () => {
    expect(csv(`${HEADER}E01,a,Authored fixture\nE02,b,Synthetic demo\n`).receipt.synthetic).toBe(true);
    expect(csv(`${HEADER}E01,a,Authored fixture\nE02,b,Bench notebook 7\n`).receipt.synthetic).toBe(false);
  });
});

describe('JSONL validation', () => {
  const jsonl = (text: string) => validateDatasetFile({ bytes: enc.encode(text), filename: 'sources.jsonl' });

  it('parses objects, stringifies other values and skips blank lines', () => {
    const result = jsonl('{"source_id":"E01","observation":"x","provenance":"demo","n":5,"nested":{"a":1},"none":null}\n\n{"source_id":"E02","observation":"y","provenance":"demo"}\n');
    expect(result.receipt.passed).toBe(true);
    expect(result.receipt.recordsParsed).toBe(2);
    expect(result.records[0]).toEqual({ source_id: 'E01', observation: 'x', provenance: 'demo', n: '5', nested: '{"a":1}', none: '' });
  });

  it('accepts .ndjson and CRLF', () => {
    const result = validateDatasetFile({ bytes: enc.encode('{"source_id":"E01","observation":"x","provenance":"demo"}\r\n'), filename: 'sources.NDJSON' });
    expect(result.receipt).toMatchObject({ format: 'jsonl', passed: true });
  });

  it('names lines that are not JSON or not objects', () => {
    const result = jsonl('{"source_id":"E01","observation":"x","provenance":"demo"}\nnot json\n[1,2]\n3\n');
    expect(result.receipt.passed).toBe(false);
    expect(messages(result)).toContain('1 line is not valid JSON: line 2.');
    expect(messages(result)).toContain('2 lines are not a JSON object: lines 3, 4.');
  });

  it('applies the same column, duplicate and sensitive checks', () => {
    expect(codes(jsonl('{"source_id":"E01"}\n'))).toContain('missing_columns');
    expect(codes(jsonl('{"source_id":"E01","observation":"x","provenance":"p"}\n{"source_id":"E01","observation":"y","provenance":"p"}\n'))).toContain('duplicate_source_ids');
    expect(codes(jsonl('{"source_id":"E01","observation":"mail a@b.co","provenance":"p"}\n'))).toContain('sensitive_email');
  });
});

describe('PDF by magic bytes', () => {
  it('accepts the signature, reads no records and says so', () => {
    const result = validateDatasetFile({ bytes: enc.encode('%PDF-1.7\n%âãÏÓ\nbody'), filename: 'Report.PDF' });
    expect(result.receipt).toMatchObject({ format: 'pdf', encoding: 'PDF 1.7', recordsParsed: 0, passed: true });
    expect(result.receipt.recordsNote).toContain('not parsed');
    expect(result.receipt.requiredColumns.applicable).toBe(false);
    expect(result.receipt.sensitiveData).toMatchObject({ scanned: false });
    expect(result.receipt.sensitiveData.note).toContain('Not scanned');
    expect(result.records).toEqual([]);
  });

  it('refuses a .pdf without the signature', () => {
    expect(codes(validateDatasetFile({ bytes: enc.encode('hello'), filename: 'fake.pdf' }))).toEqual(['not_a_pdf']);
  });

  it('refuses a PDF wearing a .csv name', () => {
    expect(codes(validateDatasetFile({ bytes: enc.encode('%PDF-1.4 x'), filename: 'sneaky.csv' }))).toEqual(['format_mismatch']);
  });
});

describe('formats', () => {
  it('refuses anything else and says what is accepted', () => {
    for (const filename of ['data.xlsx', 'notes.txt', 'noextension']) {
      const result = validateDatasetFile({ bytes: enc.encode('a,b'), filename });
      expect(codes(result)).toEqual(['unsupported_format']);
      expect(messages(result)).toContain('Upload a CSV, JSONL or PDF file.');
    }
  });

  it('sets the limit at 100 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(104_857_600);
  });
});

describe('the sensitive data scan', () => {
  it.each([
    ['maya@helixlab.example', 'email'],
    ['Contact: first.last+tag@sub.example.co.uk today', 'email'],
    ['+61 412 345 678', 'phone'],
    ['+1 (415) 555-0100', 'phone'],
    ['(415) 555-0100', 'phone'],
    ['415.555.0100', 'phone'],
    ['020 7946 0958', 'phone'],
    ['0412 345 678', 'phone'],
    ['123-45-6789', 'national_id'],
    ['AB 12 34 56 C', 'national_id'],
    ['AB123456C', 'national_id'],
    ['046-454-286', 'national_id'],
    ['Passport number X1234567', 'national_id'],
    ['SSN: 078051120', 'national_id'],
    ['MRN: 00123456', 'medical_record'],
    ['mrn 8842', 'medical_record'],
    ['Patient ID: A-99812', 'medical_record'],
    ['Medical record number 442211', 'medical_record'],
    ['NHS number 943 476 5919', 'medical_record'],
  ] as const)('flags %s as %s', (value, kind) => {
    expect(scanSensitiveText(value)).toContain(kind);
  });

  it.each([
    '0.25 → 1.00 µg/mL ciprofloxacin',
    'acrB transcript 3.1× control',
    'Partial MIC reversal; specificity unknown',
    '2026-10-15',
    '192.168.0.1',
    'P01:A01=0.052;P01:A02=0.318;',
    '1000 2000 3000',
    '10.1000/xyz123',
    'The passport of the cell',
    'E01',
    'OD600 0.552 at 16 h',
    'n = 12 replicates',
    '123-456-789',
    'a@b',
    'Patient identifiers were removed',
  ])('does not flag %s', (value) => {
    expect(scanSensitiveText(value)).toEqual([]);
  });

  it('reports flags with row, column and count, and never the value', () => {
    const result = csv(`${HEADER}E01,mail maya@helixlab.example,Authored\nE02,call (415) 555-0100,Authored\nE03,ok,MRN: 00123456\nE04,other@lab.example,Authored\n`);
    expect(result.receipt.passed).toBe(false);
    const flags = result.receipt.sensitiveData.flags;
    expect(flags.find((flag) => flag.kind === 'email')).toEqual({ kind: 'email', label: 'email addresses', count: 2, locations: ['row 2, observation', 'row 5, observation'] });
    expect(flags.find((flag) => flag.kind === 'phone')).toEqual({ kind: 'phone', label: 'phone number', count: 1, locations: ['row 3, observation'] });
    expect(flags.find((flag) => flag.kind === 'medical_record')).toEqual({ kind: 'medical_record', label: 'medical record number', count: 1, locations: ['row 4, provenance'] });
    expect(result.receipt.sensitiveData.note).toBe('4 flags');
    const stored = JSON.stringify(result.receipt);
    expect(stored).not.toContain('maya@helixlab.example');
    expect(stored).not.toContain('555-0100');
    expect(stored).not.toContain('00123456');
  });

  it('flags a sensitive column by name even when its value looks harmless', () => {
    const result = csv('source_id,observation,provenance,patient_id\nE01,a,b,8842\n');
    expect(result.receipt.sensitiveData.flags).toEqual([{ kind: 'medical_record', label: 'medical record number', count: 1, locations: ['row 2, patient_id'] }]);
  });

  it('does not backtrack across an enormous cell', () => {
    const started = Date.now();
    expect(scanSensitiveText(`${'a'.repeat(2_000_000)}@${'b'.repeat(2_000_000)}`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('displayRow', () => {
  it('uses the frame columns where present', () => {
    expect(displayRow({ source_id: 'E01', assay: 'MIC assay', label: 'MIC assay', observation: 'full', summary: '0.25 → 1.00 µg/mL', limit: 'Association, not causality' })).toEqual({ term: 'E01 / MIC assay', detail: '0.25 → 1.00 µg/mL · Association, not causality' });
  });

  it('prefers assay over label, as the frame prints it', () => {
    expect(displayRow({ source_id: 'E02', assay: 'qPCR', label: 'Expression', observation: 'x' }).term).toBe('E02 / qPCR');
  });

  it('falls back to source_id and observation', () => {
    expect(displayRow({ source_id: 'C01', observation: 'Deletion strain confirmed' })).toEqual({ term: 'C01', detail: 'Deletion strain confirmed' });
  });
});
