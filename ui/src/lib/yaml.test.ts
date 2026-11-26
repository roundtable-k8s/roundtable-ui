import { describe, it, expect } from 'vitest'
import { keyLess, toYaml } from './yaml'
// Recorded from sigs.k8s.io/yaml.Marshal (the gateway's manifest encoder,
// roundtable 7c2bfd4) for strings that each need a different scalar style.
import scalarsJson from './__fixtures__/schedule-manifests/scalars.json?raw'
import scalarsYaml from './__fixtures__/schedule-manifests/scalars.yaml?raw'

describe('toYaml', () => {
  it('quotes, folds and escapes scalars the way sigs.k8s.io/yaml does', () => {
    expect(toYaml(JSON.parse(scalarsJson))).toBe(scalarsYaml)
  })

  it('writes nested mappings and sequences like yaml.v2', () => {
    expect(toYaml({
      spec: { b: [1, 'two', { name: 'x', input: 'y' }, [], {}], a: null, c: true },
      empty: {},
      list: [['nested', 'seq']],
    })).toBe([
      'empty: {}',
      'list:',
      '- - nested',
      '  - seq',
      'spec:',
      '  a: null',
      '  b:',
      '  - 1',
      '  - two',
      '  - input: "y"',
      '    name: x',
      '  - []',
      '  - {}',
      '  c: true',
      '',
    ].join('\n'))
  })

  it('folds a long plain scalar at 80 columns, indented under its key', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const out = toYaml({ spec: { task: words } })
    const lines = out.split('\n')
    expect(lines[1].startsWith('  task: word0 ')).toBe(true)
    expect(lines[2].startsWith('    word')).toBe(true)
    expect(out.replace(/\n {4}/g, ' ')).toBe(`spec:\n  task: ${words}\n`)
  })

  it('writes multi-line strings as literal blocks with the right chomping', () => {
    expect(toYaml({ a: 'one\ntwo', b: 'one\n', c: 'one\n\n', d: ' lead\nx' })).toBe(
      'a: |-\n  one\n  two\nb: |\n  one\nc: |+\n  one\n\nd: |2-\n   lead\n  x\n',
    )
  })

  it('uses a complex key for keys over 128 bytes', () => {
    const k = 'k'.repeat(129)
    expect(toYaml({ [k]: 'v' })).toBe(`? ${k}\n: v\n`)
  })

  it('leaves out undefined members', () => {
    expect(toYaml({ a: undefined, b: 1 })).toBe('b: 1\n')
  })

  it('sorts keys like yaml.v2: digits by value, non-letters before letters', () => {
    const keys = ['b', 'a10', 'a2', 'B', '_x', 'a']
    expect([...keys].sort((x, y) => (keyLess(x, y) ? -1 : keyLess(y, x) ? 1 : 0))).toEqual(['_x', 'B', 'a', 'a2', 'a10', 'b'])
  })
})
