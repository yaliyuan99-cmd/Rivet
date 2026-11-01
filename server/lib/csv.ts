import { createHash } from 'node:crypto';
import type { DatasetFormat, DatasetReceipt, ReceiptFailure, SensitiveFlag, SensitiveKind } from '../../shared/types/datasets.ts';
import type { Storage } from './storage.ts';

/** Real upload validation: CSV and JSONL parsing, strict UTF-8, PDF magic bytes, duplicate and sensitive-data checks. */

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const REQUIRED_COLUMNS = ['source_id', 'observation', 'provenance'];

export type DatasetRecord = Record<string, string>;

/* ---------- CSV (RFC 4180, plus BOM, bare CR and blank lines) ---------- */

export interface CsvProblem {
  code: 'unterminated_quote' | 'stray_quote' | 'text_after_quote';
  /** 1-based physical line where the problem starts. */
  line: number;
  message: string;
}

export interface CsvRow {
  cells: string[];
  /** 1-based physical line where the row starts. A row can span lines. */
  line: number;
}

const COMMA = 44;
const LF = 10;
const CR = 13;
const QUOTE = 34;

function countLineBreaks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === LF || (code === CR && text.charCodeAt(i + 1) !== LF)) count += 1;
  }
  return count;
}

export function parseCsv(input: string): { rows: CsvRow[]; problems: CsvProblem[] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: CsvRow[] = [];
  const problems: CsvProblem[] = [];
  const length = text.length;
  let i = 0;
  let line = 1;
  let cells: string[] = [];
  let rowLine = 1;
  let rowQuoted = false;

  const finishRow = () => {
    // A completely empty line is not a record; a line of commas is, and is checked as one.
    if (cells.length > 1 || cells[0] !== '' || rowQuoted) rows.push({ cells, line: rowLine });
    cells = [];
    rowQuoted = false;
  };

  while (i < length) {
    if (text.charCodeAt(i) === QUOTE) {
      rowQuoted = true;
      const startLine = line;
      let value = '';
      let cursor = i + 1;
      let closed = false;
      for (;;) {
        const quote = text.indexOf('"', cursor);
        if (quote === -1) {
          value += text.slice(cursor);
          line += countLineBreaks(text.slice(cursor));
          problems.push({ code: 'unterminated_quote', line: startLine, message: `Line ${startLine}: a quoted field is never closed.` });
          i = length;
          break;
        }
        const piece = text.slice(cursor, quote);
        value += piece;
        line += countLineBreaks(piece);
        if (text.charCodeAt(quote + 1) === QUOTE) {
          value += '"';
          cursor = quote + 2;
          continue;
        }
        closed = true;
        i = quote + 1;
        break;
      }
      if (closed && i < length) {
        const next = text.charCodeAt(i);
        if (next !== COMMA && next !== LF && next !== CR) {
          problems.push({ code: 'text_after_quote', line, message: `Line ${line}: text follows the closing quote of a field. Put the whole field inside the quotes.` });
          let end = i;
          while (end < length) {
            const code = text.charCodeAt(end);
            if (code === COMMA || code === LF || code === CR) break;
            end += 1;
          }
          value += text.slice(i, end);
          i = end;
        }
      }
      cells.push(value);
    } else {
      let end = i;
      let stray = false;
      while (end < length) {
        const code = text.charCodeAt(end);
        if (code === COMMA || code === LF || code === CR) break;
        if (code === QUOTE) stray = true;
        end += 1;
      }
      if (stray) problems.push({ code: 'stray_quote', line, message: `Line ${line}: a quote appears inside an unquoted field. Quote the field and double the inner quote.` });
      cells.push(text.slice(i, end));
      i = end;
    }

    if (i >= length) break;
    const code = text.charCodeAt(i);
    if (code === COMMA) {
      i += 1;
      // A comma at the very end of the file means one more empty field.
      if (i === length) cells.push('');
      continue;
    }
    i += code === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    line += 1;
    finishRow();
    rowLine = line;
  }
  if (cells.length) finishRow();
  return { rows, problems };
}

/* ---------- Strict UTF-8 ---------- */

/** The byte offset of the first invalid sequence, or -1. Same rules as TextDecoder's fatal mode. */
export function firstInvalidUtf8Offset(bytes: Uint8Array): number {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const a = bytes[i]!;
    if (a < 0x80) {
      i += 1;
      continue;
    }
    let need = 0;
    let low = 0x80;
    let high = 0xbf;
    if (a >= 0xc2 && a <= 0xdf) need = 1;
    else if (a >= 0xe0 && a <= 0xef) {
      need = 2;
      if (a === 0xe0) low = 0xa0;
      if (a === 0xed) high = 0x9f;
    } else if (a >= 0xf0 && a <= 0xf4) {
      need = 3;
      if (a === 0xf0) low = 0x90;
      if (a === 0xf4) high = 0x8f;
    } else return i;
    for (let k = 1; k <= need; k += 1) {
      const next = bytes[i + k];
      if (next === undefined || next < low || next > high) return i;
      low = 0x80;
      high = 0xbf;
    }
    i += need + 1;
  }
  return -1;
}

function lineOfOffset(bytes: Uint8Array, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (bytes[i] === LF) line += 1;
  return line;
}

export type DecodeResult = { ok: true; text: string } | { ok: false; message: string };

export function decodeUtf8Strict(bytes: Uint8Array): DecodeResult {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { ok: false, message: 'This file is encoded as UTF-16. Save it as UTF-8 and upload it again.' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const nul = text.indexOf('\u0000');
    if (nul !== -1) return { ok: false, message: `This file contains a NUL byte at character ${nul.toLocaleString('en-US')}, so it is not a text file.` };
    return { ok: true, text };
  } catch {
    const offset = firstInvalidUtf8Offset(bytes);
    return { ok: false, message: `This file is not valid UTF-8: the byte at offset ${offset.toLocaleString('en-US')} (line ${lineOfOffset(bytes, offset).toLocaleString('en-US')}) cannot be decoded. Save it as UTF-8 and upload it again.` };
  }
}

/* ---------- Sensitive data ---------- */

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/;
const PHONE_INTERNATIONAL = /(?<![\w.+])\+\d[\d\s().-]{6,20}\d(?![\w.])/;
const PHONE_NANP = /(?<![\w.])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/;
const PHONE_TRUNK = /(?<![\w.])0\d{1,4}[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\w.])/;
const SSN = /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\w-])/;
const NINO = /(?<![A-Za-z0-9])(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D](?![A-Za-z0-9])/;
const SIN = /(?<![\w-])\d{3}[- ]\d{3}[- ]\d{3}(?![\w-])/g;
const LABELLED_ID = /\b(?:national (?:id|identity|insurance)|passport|social security|ssn|tax file|tfn|aadhaar|driver'?s licen[cs]e)\b(?:\s{1,4}(?:number|no\.?|#))?\s{0,4}[:#=-]?\s{0,4}(?=[A-Z0-9 -]{0,40}\d)[A-Z0-9][A-Z0-9 -]{4,40}/i;
const MEDICAL_RECORD = /(?<![A-Za-z])(?:MRN|MR#|medical record(?:\s{1,4}(?:number|no\.?|#))?|patient (?:id|identifier|number|no\.?)|chart (?:number|no\.?)|NHS (?:number|no\.?))(?![A-Za-z])\s{0,4}[:#=-]?\s{0,4}(?=[A-Z0-9-]{0,40}\d)[A-Z0-9-]{3,40}/i;

const SENSITIVE_COLUMNS: [RegExp, SensitiveKind][] = [
  [/^(?:e-?mail|e-?mail_address)$/i, 'email'],
  [/^(?:phone|phone_number|telephone|mobile|mobile_number)$/i, 'phone'],
  [/^(?:ssn|national_id|national_insurance_number|passport|passport_number|sin|tax_file_number)$/i, 'national_id'],
  [/^(?:mrn|medical_record|medical_record_number|patient_id|patient_name|date_of_birth|dob)$/i, 'medical_record'],
];

const SENSITIVE_LABELS: Record<SensitiveKind, [string, string]> = {
  email: ['email address', 'email addresses'],
  phone: ['phone number', 'phone numbers'],
  national_id: ['national ID', 'national IDs'],
  medical_record: ['medical record number', 'medical record numbers'],
};

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasInternationalPhone(value: string): boolean {
  const match = PHONE_INTERNATIONAL.exec(value);
  if (!match) return false;
  const digits = match[0].replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15;
}

function hasCheckedSin(value: string): boolean {
  for (const match of value.matchAll(SIN)) {
    if (luhnValid(match[0].replace(/\D/g, ''))) return true;
  }
  return false;
}

/** Looks only around each @, so one enormous cell cannot make the pattern backtrack across megabytes. */
function hasEmail(value: string): boolean {
  let at = value.indexOf('@');
  while (at !== -1) {
    if (EMAIL.test(value.slice(Math.max(0, at - 64), at + 320))) return true;
    at = value.indexOf('@', at + 1);
  }
  return false;
}

/** Which kinds of sensitive data appear in a piece of text. Also used by the release gate. */
export function scanSensitiveText(value: string): SensitiveKind[] {
  const kinds: SensitiveKind[] = [];
  if (hasEmail(value)) kinds.push('email');
  if (/\d/.test(value)) {
    if (hasInternationalPhone(value) || PHONE_NANP.test(value) || PHONE_TRUNK.test(value)) kinds.push('phone');
    if (SSN.test(value) || NINO.test(value) || hasCheckedSin(value) || LABELLED_ID.test(value)) kinds.push('national_id');
    if (MEDICAL_RECORD.test(value)) kinds.push('medical_record');
  }
  return kinds;
}

function scanRecords(records: { record: DatasetRecord; row: number }[], columns: string[]): SensitiveFlag[] {
  const found = new Map<SensitiveKind, { count: number; locations: string[] }>();
  const note = (kind: SensitiveKind, where: string) => {
    let entry = found.get(kind);
    if (!entry) {
      entry = { count: 0, locations: [] };
      found.set(kind, entry);
    }
    entry.count += 1;
    if (entry.locations.length < 5) entry.locations.push(where);
  };
  const columnKinds = columns.flatMap((column) => {
    const hit = SENSITIVE_COLUMNS.find(([pattern]) => pattern.test(column));
    return hit ? [{ column, kind: hit[1] }] : [];
  });
  for (const { record, row } of records) {
    for (const [column, value] of Object.entries(record)) {
      if (!value) continue;
      for (const kind of scanSensitiveText(value)) note(kind, `row ${row}, ${column}`);
    }
    for (const { column, kind } of columnKinds) {
      if (record[column]?.trim() && !scanSensitiveText(record[column] as string).includes(kind)) note(kind, `row ${row}, ${column}`);
    }
  }
  return [...found].map(([kind, entry]) => ({ kind, label: SENSITIVE_LABELS[kind][entry.count === 1 ? 0 : 1], count: entry.count, locations: entry.locations }));
}

/* ---------- Whole-file validation ---------- */

const list = (items: (string | number)[], max = 5) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename);
  return match ? (match[1] as string).toLowerCase() : '';
}

function formatFromExtension(extension: string): DatasetFormat | null {
  if (extension === 'csv') return 'csv';
  if (extension === 'jsonl' || extension === 'ndjson') return 'jsonl';
  if (extension === 'pdf') return 'pdf';
  return null;
}

const startsWithPdfMagic = (bytes: Uint8Array) => bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;

function emptyReceipt(format: DatasetReceipt['format'], encoding: string): DatasetReceipt {
  return {
    format,
    encoding,
    requiredColumns: { expected: REQUIRED_COLUMNS, missing: REQUIRED_COLUMNS, passed: 0, total: REQUIRED_COLUMNS.length },
    recordsParsed: 0,
    duplicateSourceIds: 0,
    missingSourceIds: 0,
    sensitiveData: { flags: [], note: 'Not scanned', scanned: false },
    failures: [],
    passed: false,
  };
}

function failed(receipt: DatasetReceipt, failure: ReceiptFailure): { receipt: DatasetReceipt; records: DatasetRecord[] } {
  return { receipt: { ...receipt, failures: [...(receipt.failures ?? []), failure], passed: false }, records: [] };
}

const SYNTHETIC_PROVENANCE = /\b(?:authored|synthetic|fixtures?|demo)\b/i;

/** Column and record checks shared by CSV and JSONL, once rows have been parsed. */
function checkRecords(base: DatasetReceipt, columns: string[], rows: { record: DatasetRecord; row: number }[], earlier: ReceiptFailure[]): { receipt: DatasetReceipt; records: DatasetRecord[] } {
  const failures = [...earlier];
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  if (missingColumns.length) {
    const hint = columns.length === 1 && /[;\t|]/.test(columns[0] as string) ? ' The file looks delimited by something other than commas; use commas.' : '';
    failures.push({ code: 'missing_columns', message: `Missing required ${missingColumns.length === 1 ? 'column' : 'columns'}: ${missingColumns.join(', ')}.${hint}` });
  }
  if (!rows.length) failures.push({ code: 'no_records', message: 'The file has no records.' });

  const seen = new Map<string, number[]>();
  const missingRows: number[] = [];
  const blanks = new Map<string, number[]>();
  if (columns.includes('source_id')) {
    for (const { record, row } of rows) {
      const id = (record.source_id ?? '').trim();
      if (!id) {
        missingRows.push(row);
        continue;
      }
      const at = seen.get(id);
      if (at) at.push(row);
      else seen.set(id, [row]);
    }
  }
  for (const column of ['observation', 'provenance']) {
    if (!columns.includes(column)) continue;
    const empty = rows.filter(({ record }) => !(record[column] ?? '').trim()).map(({ row }) => row);
    if (empty.length) blanks.set(column, empty);
  }
  const duplicates = [...seen].filter(([, at]) => at.length > 1);
  if (duplicates.length) {
    // The receipt is kept, so an ID that is itself sensitive is not repeated in it.
    const shown = (id: string) => (scanSensitiveText(id).length ? 'a flagged value' : id.length > 40 ? `${id.slice(0, 40)}…` : id);
    const detail = duplicates.slice(0, 5).map(([id, at]) => `${shown(id)} (rows ${list(at)})`).join('; ');
    const more = duplicates.length > 5 ? `; and ${duplicates.length - 5} more` : '';
    failures.push({ code: 'duplicate_source_ids', message: `${plural(duplicates.length, 'duplicate source ID')}: ${detail}${more}.` });
  }
  if (missingRows.length) failures.push({ code: 'missing_source_ids', message: `${plural(missingRows.length, 'record')} ${missingRows.length === 1 ? 'has' : 'have'} no source ID: ${missingRows.length === 1 ? 'row' : 'rows'} ${list(missingRows)}.` });
  for (const [column, at] of blanks) failures.push({ code: `missing_${column}`, message: `${plural(at.length, 'record')} ${at.length === 1 ? 'has' : 'have'} no ${column}: ${at.length === 1 ? 'row' : 'rows'} ${list(at)}.` });

  const flags = scanRecords(rows, columns);
  for (const flag of flags) {
    const where = flag.count > flag.locations.length ? `${flag.locations.join('; ')}; and ${flag.count - flag.locations.length} more` : flag.locations.join('; ');
    failures.push({ code: `sensitive_${flag.kind}`, message: `Sensitive data scan flagged ${flag.count.toLocaleString('en-US')} ${flag.label}: ${where}. Remove ${flag.count === 1 ? 'it' : 'them'} and upload the file again.` });
  }

  const synthetic = rows.length > 0 && rows.every(({ record }) => SYNTHETIC_PROVENANCE.test(record.provenance ?? ''));
  const receipt: DatasetReceipt = {
    ...base,
    columns,
    requiredColumns: { expected: REQUIRED_COLUMNS, missing: missingColumns, passed: REQUIRED_COLUMNS.length - missingColumns.length, total: REQUIRED_COLUMNS.length },
    recordsParsed: rows.length,
    duplicateSourceIds: duplicates.reduce((sum, [, at]) => sum + at.length - 1, 0),
    missingSourceIds: missingRows.length,
    sensitiveData: { flags, note: flags.length ? `${plural(flags.reduce((sum, flag) => sum + flag.count, 0), 'flag')}` : 'No flags', scanned: true },
    synthetic,
    failures,
    passed: failures.length === 0,
  };
  return { receipt, records: rows.map(({ record }) => record) };
}

function validateCsv(text: string): { receipt: DatasetReceipt; records: DatasetRecord[] } {
  const base = emptyReceipt('csv', 'UTF-8');
  const { rows, problems } = parseCsv(text);
  if (!rows.length) return failed(base, { code: 'no_header', message: 'The file has no header row.' });
  const failures: ReceiptFailure[] = [];
  const shown = problems.slice(0, 5);
  for (const problem of shown) failures.push({ code: problem.code, message: problem.message });
  if (problems.length > shown.length) failures.push({ code: 'more_quote_problems', message: `${plural(problems.length - shown.length, 'more quoting problem')} after these.` });

  const header = rows[0] as CsvRow;
  const columns = header.cells.map((cell) => cell.trim().toLowerCase());
  const repeated = [...new Set(columns.filter((column, index) => column && columns.indexOf(column) !== index))];
  if (repeated.length) failures.push({ code: 'duplicate_columns', message: `Column names repeat: ${repeated.join(', ')}.` });
  if (columns.some((column) => !column)) failures.push({ code: 'empty_column_name', message: 'The header row has a column with no name.' });

  const wrongWidth: string[] = [];
  const records: { record: DatasetRecord; row: number }[] = [];
  // Spreadsheet numbering: the header is row 1, whatever line a multi-line record starts on.
  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    if (row.cells.length !== columns.length) wrongWidth.push(`row ${rowNumber} has ${row.cells.length}`);
    records.push({ record: Object.fromEntries(columns.map((column, position) => [column, row.cells[position] ?? ''])), row: rowNumber });
  });
  if (wrongWidth.length) failures.push({ code: 'column_count', message: `The header has ${plural(columns.length, 'column')}, but ${list(wrongWidth)}.` });
  return checkRecords(base, columns, records, failures);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function validateJsonl(text: string): { receipt: DatasetReceipt; records: DatasetRecord[] } {
  const base = emptyReceipt('jsonl', 'UTF-8');
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);
  const badLines: number[] = [];
  const notObjects: number[] = [];
  const columns: string[] = [];
  const known = new Set<string>();
  const records: { record: DatasetRecord; row: number }[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      badLines.push(index + 1);
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      notObjects.push(index + 1);
      return;
    }
    const record: DatasetRecord = {};
    for (const [key, cell] of Object.entries(value as Record<string, unknown>)) {
      const column = key.trim().toLowerCase();
      if (!known.has(column)) {
        known.add(column);
        columns.push(column);
      }
      record[column] = cellText(cell);
    }
    records.push({ record, row: index + 1 });
  });
  const failures: ReceiptFailure[] = [];
  if (badLines.length) failures.push({ code: 'invalid_json', message: `${plural(badLines.length, 'line')} ${badLines.length === 1 ? 'is' : 'are'} not valid JSON: ${badLines.length === 1 ? 'line' : 'lines'} ${list(badLines)}.` });
  if (notObjects.length) failures.push({ code: 'not_object', message: `${plural(notObjects.length, 'line')} ${notObjects.length === 1 ? 'is' : 'are'} not a JSON object: ${notObjects.length === 1 ? 'line' : 'lines'} ${list(notObjects)}.` });
  return checkRecords(base, columns, records, failures);
}

/**
 * Validates an uploaded file. Never throws for bad content: every problem is reported on the
 * receipt, which holds row numbers and columns but none of the file's own values.
 */
export function validateDatasetFile(input: { bytes: Uint8Array; filename: string }): { receipt: DatasetReceipt; records: DatasetRecord[] } {
  const { bytes, filename } = input;
  const extension = extensionOf(filename);
  const format = formatFromExtension(extension);
  const isPdfBytes = startsWithPdfMagic(bytes);

  if (!format) {
    return failed(emptyReceipt('unknown', 'Not checked'), { code: 'unsupported_format', message: `${extension ? `.${extension} files are` : 'A file without an extension is'} not supported. Upload a CSV, JSONL or PDF file.` });
  }
  if (bytes.length === 0) return failed(emptyReceipt(format, 'Not checked'), { code: 'empty_file', message: 'This file is empty.' });

  if (format === 'pdf') {
    if (!isPdfBytes) return failed(emptyReceipt('pdf', 'Not checked'), { code: 'not_a_pdf', message: `This file is named .${extension} but does not start with the %PDF- signature, so it is not a PDF.` });
    const version = new TextDecoder('latin1').decode(bytes.subarray(5, 8));
    return {
      records: [],
      receipt: {
        format: 'pdf',
        encoding: `PDF ${version}`,
        requiredColumns: { expected: REQUIRED_COLUMNS, missing: [], passed: 0, total: REQUIRED_COLUMNS.length, applicable: false },
        recordsParsed: 0,
        recordsNote: 'Records are not parsed from a PDF. Rivet checks the file signature and stores the bytes.',
        duplicateSourceIds: 0,
        missingSourceIds: 0,
        sensitiveData: { flags: [], note: 'Not scanned: PDF text is not read', scanned: false },
        synthetic: false,
        failures: [],
        passed: true,
      },
    };
  }

  if (isPdfBytes) return failed(emptyReceipt(format, 'Not checked'), { code: 'format_mismatch', message: `This file is a PDF but is named .${extension}. Rename it to .pdf and upload it again.` });
  const decoded = decodeUtf8Strict(bytes);
  if (!decoded.ok) return failed(emptyReceipt(format, 'Not UTF-8'), { code: 'not_utf8', message: decoded.message });
  return format === 'csv' ? validateCsv(decoded.text) : validateJsonl(decoded.text);
}

/* ---------- Showing records ---------- */

/** "E01 / MIC assay" and "0.25 → 1.00 µg/mL · Association, not causality", where those columns exist. */
export function displayRow(record: DatasetRecord): { term: string; detail: string } {
  const label = record.assay || record.label;
  const body = record.summary || record.observation || '';
  return {
    term: label ? `${record.source_id} / ${label}` : (record.source_id ?? ''),
    detail: record.limit ? `${body} · ${record.limit}` : body,
  };
}

/* ---------- Dataset versions ---------- */

export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}$/;

function versionParts(version: string): [number, number] {
  const [major, minor] = version.split('.');
  return [Number(major), Number(minor)];
}

export function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor] = versionParts(a);
  const [bMajor, bMinor] = versionParts(b);
  return aMajor - bMajor || aMinor - bMinor;
}

/** 1.0 -> 1.1, 0.2 -> 0.3 */
export function nextVersion(version: string): string {
  const [major, minor] = versionParts(version);
  return `${major}.${minor + 1}`;
}

/** Re-hashes stored bytes as a stream. A missing or unreadable file does not match. */
export async function storedBytesMatch(storage: Storage, sha256: string): Promise<boolean> {
  if (!storage.exists(sha256)) return false;
  try {
    const hash = createHash('sha256');
    for await (const chunk of storage.stream(sha256) as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
    return hash.digest('hex') === sha256;
  } catch {
    return false;
  }
}
