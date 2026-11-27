import { describe, it, expect } from 'vitest'
import { csvCell, toCsv } from './csv'

describe('toCsv', () => {
  it('joins rows with CRLF', () => {
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('a,b\r\n1,2')
  })

  it('quotes cells with commas, quotes and line breaks', () => {
    expect(toCsv([['x,y', 'say "hi"', 'two\nlines']])).toBe('"x,y","say ""hi""","two\nlines"')
  })

  it('writes numbers as plain decimals, never prefixed', () => {
    expect(csvCell(0.000001)).toBe('0.000001')
    expect(csvCell(-2.5)).toBe('-2.5')
    expect(csvCell(Number.NaN)).toBe('')
  })

  it('neutralises formula-like text cells with a leading apostrophe', () => {
    expect(csvCell('=cmd')).toBe("'=cmd")
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-x')).toBe("'-x")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\tx')).toBe("'\tx")
    expect(csvCell('plain')).toBe('plain')
  })

  it('keeps an empty row as a blank line', () => {
    expect(toCsv([['a'], [], ['b']])).toBe('a\r\n\r\nb')
  })
})
