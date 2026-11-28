import { Tag } from 'lucide-react'

export function SkillsSection({ skills }: { skills: string[] }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Tag className="w-4 h-4" />
        Skills ({skills.length})
      </h3>
      <div className="flex flex-wrap gap-2">
        {skills.map((skill, i) => (
          <span
            key={skill}
            className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs border ${
              i % 2 === 0
                ? 'bg-blue-500/10 text-blue-300 border-blue-500/20'
                : 'bg-purple-500/10 text-purple-300 border-purple-500/20'
            }`}
          >
            {skill}
          </span>
        ))}
      </div>
    </div>
  )
}
