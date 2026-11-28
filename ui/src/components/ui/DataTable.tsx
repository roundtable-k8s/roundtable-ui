import type { ReactNode } from 'react'

export interface DataTableColumn {
  key: string
  header: ReactNode
  align?: 'left' | 'right'
  /** Extra classes for the <th>. */
  className?: string
}

/**
 * The shared frame of a list table: card wrapper, header row, column
 * alignment, accessible name and `scope="col"` headers. Rows stay the
 * caller's own and are passed as children (rendered inside <tbody>).
 */
export function DataTable({ label, columns, density = 'comfortable', describedBy, children }: {
  /** Accessible name of the table (aria-label). */
  label: string
  columns: DataTableColumn[]
  /** comfortable = px-4 py-3, compact = px-3 py-2. */
  density?: 'comfortable' | 'compact'
  /** Id of an element describing the table (aria-describedby). */
  describedBy?: string
  /** The <tr>s. */
  children: ReactNode
}) {
  const pad = density === 'compact' ? 'px-3 py-2' : 'px-4 py-3'
  return (
    <div className="overflow-x-auto bg-roundtable-slate border border-roundtable-steel rounded-xl">
      <table aria-label={label} aria-describedby={describedBy} className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-roundtable-steel">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`${pad} font-medium${c.align === 'right' ? ' text-right' : ''}${c.className ? ` ${c.className}` : ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
