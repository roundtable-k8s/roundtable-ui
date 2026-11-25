import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useTableFilter } from './useTableFilter'
import { withTable, inTable } from '../lib/tables'

const at = (url: string) => ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
)
const useBoth = () => ({ filter: useTableFilter(), loc: useLocation() })

describe('useTableFilter', () => {
  it('defaults to all tables', () => {
    const { result } = renderHook(() => useTableFilter(), { wrapper: at('/fleet') })
    expect(result.current.table).toBe('')
  })

  it('reads ?table= from the URL', () => {
    const { result } = renderHook(() => useTableFilter(), { wrapper: at('/fleet?table=personal') })
    expect(result.current.table).toBe('personal')
  })

  it('writes the table to the URL, keeps other parameters, and clears it for all', () => {
    const { result } = renderHook(useBoth, { wrapper: at('/running?knight=galahad') })
    act(() => result.current.filter.setTable('roundtable-dev'))
    expect(result.current.filter.table).toBe('roundtable-dev')
    expect(result.current.loc.search).toBe('?knight=galahad&table=roundtable-dev')
    act(() => result.current.filter.setTable(''))
    expect(result.current.filter.table).toBe('')
    expect(result.current.loc.search).toBe('?knight=galahad')
  })
})

describe('table helpers', () => {
  it('withTable leaves the url alone for all tables and appends otherwise', () => {
    expect(withTable('/api/fleet', '')).toBe('/api/fleet')
    expect(withTable('/api/fleet', 'personal')).toBe('/api/fleet?table=personal')
    expect(withTable('/api/chains?limit=500', 'a b')).toBe('/api/chains?limit=500&table=a%20b')
  })

  it('inTable treats a missing table as none', () => {
    expect(inTable('', undefined)).toBe(true)
    expect(inTable('personal', 'personal')).toBe(true)
    expect(inTable('personal', 'roundtable-dev')).toBe(false)
    expect(inTable('none', undefined)).toBe(true)
  })
})
