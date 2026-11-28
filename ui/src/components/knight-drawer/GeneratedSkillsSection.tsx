import { FileCode } from 'lucide-react'
import type { Knight } from '../../hooks/useFleet'
import { sanitizeText } from '../../lib/untrusted'

export function GeneratedSkillsSection({ generatedSkills }: { generatedSkills: NonNullable<Knight['generatedSkills']> }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <FileCode className="w-4 h-4" />
        Generated Skills ({generatedSkills.length})
      </h3>
      <div className="space-y-2">
        {generatedSkills.map((skill) => (
          <details key={skill.name} className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg">
            <summary className="px-3 py-2 cursor-pointer text-xs text-gray-300 hover:text-roundtable-gold transition-colors">
              {skill.name}
            </summary>
            <div className="px-3 pb-3">
              <pre className="text-xs text-gray-400 whitespace-pre-wrap overflow-x-auto max-h-64">
                {sanitizeText(skill.content)}
              </pre>
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}
