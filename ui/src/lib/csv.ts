/**
 * CSV rows for spreadsheets (RFC 4180: CRLF line ends, quoted cells).
 * Text cells come from untrusted event data, so a text cell that starts with
 * a formula character (= + - @, tab or CR) gets a leading apostrophe and is
 * read as text. Numbers are written as plain decimals and never prefixed.
 */

const FORMULA_START = /^[=+\-@\t\r]/

/** One cell as CSV text, quoted when it holds a comma, quote or line break. */
export function csvCell(value: string | number): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows joined with CRLF. Every row is written as is; empty rows are blank lines. */
export function toCsv(rows: (string | number)[][]): string {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n')
}
