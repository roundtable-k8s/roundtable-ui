import { Search, X } from 'lucide-react'
import { isSkillFilterActive, type SkillFilter as SkillFilterValue } from '../lib/cards'
import { sanitizeText } from '../lib/untrusted'

interface Props {
  /** Skill tags offered as one-click filters. */
  tags: string[]
  value: SkillFilterValue
  onChange: (next: SkillFilterValue) => void
  /** Knights shown / total, for the result count. */
  shown?: number
  total?: number
}

/** Fleet skill filter (#243): free text over skills, or one skill tag. */
export function SkillFilter({ tags, value, onChange, shown, total }: Props) {
  const active = isSkillFilterActive(value)
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2" role="search" aria-label="Filter knights by skill">
      <div className="relative">
        <Search className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="search"
          aria-label="Filter by skill"
          value={value.text ?? ''}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          placeholder="Filter by skill…"
          className="bg-roundtable-navy border border-roundtable-steel rounded-lg pl-8 pr-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-roundtable-gold/50 focus:outline-none w-56"
        />
      </div>
      {tags.map((tag) => {
        const selected = value.tag === tag
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange({ ...value, tag: selected ? undefined : tag })}
            className={`text-xs px-2 py-1 rounded-full border transition-colors ${
              selected
                ? 'bg-roundtable-gold/20 text-roundtable-gold border-roundtable-gold/40'
                : 'bg-roundtable-slate text-gray-400 border-roundtable-steel hover:text-gray-200'
            }`}
          >
            {sanitizeText(tag)}
          </button>
        )
      })}
      {active && (
        <>
          {shown !== undefined && total !== undefined && (
            <span className="text-xs text-gray-500">{shown} of {total} knights</span>
          )}
          <button
            type="button"
            onClick={() => onChange({})}
            className="text-xs text-gray-400 hover:text-white inline-flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        </>
      )}
    </div>
  )
}
