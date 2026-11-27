import { useState } from 'react'
import { useTables } from '../hooks/useTables'
import { validateMissionForm, firstInvalidStep, stepOfField } from '../lib/missionForm'
import { Target, Plus, X, ArrowLeft, Rocket, Brain, Settings } from 'lucide-react'
import { apiPost } from '../lib/api'
import { Modal, ErrorBanner } from '../components/ui'

interface MissionForm {
  name: string
  objective: string
  roundTableRef: string
  costBudgetUSD: string
  ttl: string
  timeout: string
  knights: { name: string; role: string }[]
  metaMission: boolean
  // Advanced options
  successCriteria: string
  briefing: string
  cleanupPolicy: 'Delete' | 'Retain'
  recruitExisting: boolean
  retainResults: boolean
  // Planner options (only for metaMission)
  planner: {
    knightRef: string
    timeout: string
    context: string
    allowSkillGeneration: boolean
    maxChains: string
    maxKnights: string
  }
}

const INITIAL_FORM: MissionForm = {
  name: '',
  objective: '',
  roundTableRef: '',
  costBudgetUSD: '1.00',
  ttl: '3600',
  timeout: '300',
  knights: [{ name: '', role: '' }],
  metaMission: false,
  successCriteria: '',
  briefing: '',
  cleanupPolicy: 'Delete',
  recruitExisting: false,
  retainResults: true,
  planner: {
    knightRef: '',
    timeout: '300',
    context: '',
    allowSkillGeneration: false,
    maxChains: '5',
    maxKnights: '10',
  },
}

interface MissionWizardProps {
  onClose: () => void
  onCreated: () => void
}

export function MissionWizard({ onClose, onCreated }: MissionWizardProps) {
  const [form, setForm] = useState<MissionForm>({ ...INITIAL_FORM })
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const tables = useTables()
  const errors = validateMissionForm(form)
  const invalidStep = firstInvalidStep(errors)
  const touch = (key: string) => setTouched(t => (t[key] ? t : { ...t, [key]: true }))
  const shown = (key: string) => (touched[key] ? errors[key] : undefined)
  const errId = (key: string) => `wiz-err-${key.replace('.', '-')}`
  /** aria props for a field with a validation message. */
  const aria = (key: string) => shown(key) ? { 'aria-invalid': true as const, 'aria-describedby': errId(key) } : {}
  const fieldError = (k: string) => shown(k)
    ? <p id={errId(k)} className="text-xs text-red-400 mt-1">{errors[k]}</p>
    : null

  const updateField = <K extends keyof MissionForm>(key: K, value: MissionForm[K]) => {
    setForm(f => ({ ...f, [key]: value }))
    touch(key as string)
  }

  const updatePlanner = <K extends keyof MissionForm['planner']>(key: K, value: MissionForm['planner'][K]) => {
    setForm(f => ({ ...f, planner: { ...f.planner, [key]: value } }))
    touch(`planner.${key}`)
  }

  const addKnight = () => {
    setForm(f => ({ ...f, knights: [...f.knights, { name: '', role: '' }] }))
  }

  const removeKnight = (idx: number) => {
    setForm(f => ({ ...f, knights: f.knights.filter((_, i) => i !== idx) }))
  }

  const updateKnight = (idx: number, field: 'name' | 'role', value: string) => {
    touch('knights')
    touch(`knights.${idx}`)
    setForm(f => ({
      ...f,
      knights: f.knights.map((k, i) => i === idx ? { ...k, [field]: value } : k),
    }))
  }

  const handleSubmit = async () => {
    if (invalidStep >= 0) return
    setSubmitting(true)
    setError(null)
    try {
      const body: any = {
        name: form.name,
        objective: form.objective,
        roundTableRef: { name: form.roundTableRef },
        costBudgetUSD: form.costBudgetUSD.trim(),
        ttlSeconds: Number(form.ttl),
        timeoutSeconds: Number(form.timeout),
        knights: form.metaMission ? [] : form.knights.filter(k => k.name.trim()),
        metaMission: form.metaMission,
        successCriteria: form.successCriteria || undefined,
        briefing: form.briefing || undefined,
        cleanupPolicy: form.cleanupPolicy,
        recruitExisting: form.recruitExisting,
        retainResults: form.retainResults,
      }

      // Add planner config if metaMission is enabled
      if (form.metaMission) {
        body.planner = {
          // omitted -> the operator uses the table's planner
          knightRef: form.planner.knightRef.trim() ? { name: form.planner.knightRef.trim() } : undefined,
          timeoutSeconds: Number(form.planner.timeout),
          context: form.planner.context || undefined,
          allowSkillGeneration: form.planner.allowSkillGeneration,
          maxChains: Number(form.planner.maxChains),
          maxKnights: Number(form.planner.maxKnights),
        }
      }

      await apiPost('/api/missions', body)
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create mission')
    } finally {
      setSubmitting(false)
    }
  }

  const steps = [
    { title: 'Basics', valid: !Object.keys(errors).some(k => stepOfField(k) === 0) },
    { title: 'Knights', valid: !Object.keys(errors).some(k => stepOfField(k) === 1) },
    { title: 'Advanced', valid: !Object.keys(errors).some(k => stepOfField(k) === 2) },
    { title: 'Review', valid: true },
  ]

  return (
    <Modal onClose={onClose} closeOnEscape={false} title="Create Mission" icon={<Target className="w-5 h-5 text-roundtable-gold" />}>
        {/* Step indicators */}
        <span id="wiz-blocked-hint" className="sr-only">Fix the earlier step first</span>
        <ol aria-label="Mission steps" className="flex items-center gap-2 px-6 pt-4">
          {steps.map((s, i) => {
            const blocked = invalidStep >= 0 && i > invalidStep
            return (
              <li key={s.title} className="flex-1">
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  disabled={blocked}
                  aria-current={i === step ? 'step' : undefined}
                  title={blocked ? 'Fix the earlier step first' : undefined}
                  aria-describedby={blocked ? 'wiz-blocked-hint' : undefined}
                  className={`w-full text-center text-xs py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    i === step
                      ? 'bg-roundtable-gold/20 text-roundtable-gold border border-roundtable-gold/30'
                      : i < step
                      ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                      : 'bg-roundtable-steel/30 text-gray-500 border border-roundtable-steel'
                  }`}
                >
                  {s.title}
                  {i < steps.length - 1 && (
                    <span className="sr-only"> {s.valid ? (i < step ? '(complete)' : '') : '(has errors)'}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ol>

        {/* Step content */}
        <div className="p-6 space-y-4">
          {step === 0 && (
            <>
              <div>
                <label htmlFor="wiz-mission-name" className="block text-sm text-gray-300 mb-1">Mission Name</label>
                <input id="wiz-mission-name"
                  value={form.name}
                  onChange={e => updateField('name', e.target.value)}
                  onBlur={() => touch('name')}
                  {...aria('name')}
                  placeholder="e.g. code-review-sprint"
                  className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold/50"
                />
                {fieldError('name')}
              </div>
              <div>
                <label htmlFor="wiz-objective" className="block text-sm text-gray-300 mb-1">Objective</label>
                <textarea id="wiz-objective"
                  value={form.objective}
                  onChange={e => updateField('objective', e.target.value)}
                  onBlur={() => touch('objective')}
                  {...aria('objective')}
                  placeholder="Describe the mission objective..."
                  rows={3}
                  className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold/50 resize-none"
                />
                {fieldError('objective')}
              </div>
              <div>
                <label htmlFor="wiz-roundtable-reference" className="block text-sm text-gray-300 mb-1">RoundTable Reference</label>
                {tables.length > 0 ? (
                  <select id="wiz-roundtable-reference"
                    value={form.roundTableRef}
                    onChange={e => updateField('roundTableRef', e.target.value)}
                    className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white focus:outline-none focus:border-roundtable-gold/50"
                  >
                    <option value="">(none)</option>
                    {form.roundTableRef && !tables.includes(form.roundTableRef) && (
                      <option value={form.roundTableRef}>{form.roundTableRef}</option>
                    )}
                    {tables.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                ) : (
                  <input id="wiz-roundtable-reference"
                    value={form.roundTableRef}
                    onChange={e => updateField('roundTableRef', e.target.value)}
                    placeholder="e.g. fleet-a"
                    className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold/50"
                  />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2 p-3 bg-roundtable-navy/50 border border-roundtable-steel rounded-lg">
                  <input
                    type="checkbox"
                    id="metaMission"
                    checked={form.metaMission}
                    onChange={e => updateField('metaMission', e.target.checked)}
                    className="w-4 h-4 rounded border-roundtable-steel bg-roundtable-navy text-indigo-500 focus:ring-indigo-500"
                  />
                  <label htmlFor="metaMission" className="text-sm text-gray-300 flex items-center gap-2">
                    <Brain className="w-4 h-4 text-indigo-400" />
                    Meta-Mission (let planner generate execution plan)
                  </label>
                </div>
                <p className="text-xs text-gray-500 mt-1 ml-6">
                  When enabled, a planner knight will automatically generate chains and knights from your objective.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label htmlFor="wiz-cost-budget" className="block text-sm text-gray-300 mb-1">Cost Budget (USD)</label>
                  <input id="wiz-cost-budget"
                    value={form.costBudgetUSD}
                    onChange={e => updateField('costBudgetUSD', e.target.value)}
                    onBlur={() => touch('costBudgetUSD')}
                    {...aria('costBudgetUSD')}
                    className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white focus:outline-none focus:border-roundtable-gold/50"
                  />
                  {fieldError('costBudgetUSD')}
                </div>
                <div>
                  <label htmlFor="wiz-ttl" className="block text-sm text-gray-300 mb-1">TTL (seconds)</label>
                  <input id="wiz-ttl"
                    type="number"
                    value={form.ttl}
                    onChange={e => updateField('ttl', e.target.value)}
                    onBlur={() => touch('ttl')}
                    {...aria('ttl')}
                    className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white focus:outline-none focus:border-roundtable-gold/50"
                  />
                  {fieldError('ttl')}
                </div>
                <div>
                  <label htmlFor="wiz-timeout" className="block text-sm text-gray-300 mb-1">Timeout (seconds)</label>
                  <input id="wiz-timeout"
                    type="number"
                    value={form.timeout}
                    onChange={e => updateField('timeout', e.target.value)}
                    onBlur={() => touch('timeout')}
                    {...aria('timeout')}
                    className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white focus:outline-none focus:border-roundtable-gold/50"
                  />
                  {fieldError('timeout')}
                </div>
              </div>
            </>
          )}

          {step === 1 && !form.metaMission && (
            <>
              <p className="text-sm text-gray-400">Assign knights to this mission:</p>
              {form.knights.map((knight, idx) => (
                <div key={idx}>
                <div className="flex items-center gap-2">
                  <input
                    value={knight.name}
                    onChange={e => updateKnight(idx, 'name', e.target.value)}
                    aria-label="Knight name"
                    placeholder="Knight name"
                    onBlur={() => { touch('knights'); touch(`knights.${idx}`) }}
                    {...aria(`knights.${idx}`)}
                    {...(shown('knights') ? { 'aria-describedby': [shown(`knights.${idx}`) ? errId(`knights.${idx}`) : '', errId('knights')].filter(Boolean).join(' ') } : {})}
                    className="flex-1 px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold/50"
                  />
                  <input
                    value={knight.role}
                    onChange={e => updateKnight(idx, 'role', e.target.value)}
                    aria-label="Knight role"
                    placeholder="Role (optional)"
                    className="flex-1 px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold/50"
                  />
                  {form.knights.length > 1 && (
                    <button onClick={() => removeKnight(idx)} aria-label="Remove knight" className="text-gray-500 hover:text-red-400">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                  {fieldError(`knights.${idx}`)}
                </div>
              ))}
              {shown('knights') && <p id="wiz-err-knights" className="text-xs text-red-400">{errors.knights}</p>}
              <button
                onClick={addKnight}
                className="flex items-center gap-1 text-sm text-roundtable-gold hover:text-yellow-300"
              >
                <Plus className="w-4 h-4" /> Add Knight
              </button>
            </>
          )}

          {step === 1 && form.metaMission && (
            <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-indigo-400 mb-2">
                <Brain className="w-5 h-5" />
                <span className="font-medium">Meta-mission mode enabled</span>
              </div>
              <p className="text-sm text-gray-400">
                The planner will analyze your objective and generate the necessary knights, skills, and execution chains.
              </p>
            </div>
          )}

          {step === 2 && (
            <>
              <div className="flex items-center gap-2 text-sm text-gray-300 mb-4">
                <Settings className="w-4 h-4 text-roundtable-gold" />
                <h3 className="font-medium">Advanced Options</h3>
              </div>

              {/* Success Criteria */}
              <div>
                <label htmlFor="wiz-success-criteria" className="block text-sm text-gray-300 mb-1">Success Criteria (optional)</label>
                <textarea id="wiz-success-criteria"
                  value={form.successCriteria}
                  onChange={e => updateField('successCriteria', e.target.value)}
                  placeholder="Describe how to determine if the mission succeeded..."
                  rows={2}
                  className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold/50 resize-none text-sm"
                />
              </div>

              {/* Briefing */}
              <div>
                <label htmlFor="wiz-briefing" className="block text-sm text-gray-300 mb-1">Briefing (optional)</label>
                <textarea id="wiz-briefing"
                  value={form.briefing}
                  onChange={e => updateField('briefing', e.target.value)}
                  placeholder="Initial context and instructions for mission knights..."
                  rows={3}
                  className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold/50 resize-none text-sm"
                />
              </div>

              {/* Cleanup Policy */}
              <div>
                <label htmlFor="wiz-cleanup-policy" className="block text-sm text-gray-300 mb-1">Cleanup Policy</label>
                <select id="wiz-cleanup-policy"
                  value={form.cleanupPolicy}
                  onChange={e => updateField('cleanupPolicy', e.target.value as 'Delete' | 'Retain')}
                  className="w-full px-3 py-2 bg-roundtable-navy border border-roundtable-steel rounded-lg text-white focus:outline-none focus:border-roundtable-gold/50"
                >
                  <option value="Delete">Delete (remove resources after completion)</option>
                  <option value="Retain">Retain (keep resources for inspection)</option>
                </select>
              </div>

              {/* Checkboxes */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 p-2 bg-roundtable-navy/50 border border-roundtable-steel rounded-lg">
                  <input
                    type="checkbox"
                    id="recruitExisting"
                    checked={form.recruitExisting}
                    onChange={e => updateField('recruitExisting', e.target.checked)}
                    className="w-4 h-4 rounded border-roundtable-steel bg-roundtable-navy"
                  />
                  <label htmlFor="recruitExisting" className="text-sm text-gray-300">
                    Recruit existing knights (allow non-ephemeral knights)
                  </label>
                </div>

                <div className="flex items-center gap-2 p-2 bg-roundtable-navy/50 border border-roundtable-steel rounded-lg">
                  <input
                    type="checkbox"
                    id="retainResults"
                    checked={form.retainResults}
                    onChange={e => updateField('retainResults', e.target.checked)}
                    className="w-4 h-4 rounded border-roundtable-steel bg-roundtable-navy"
                  />
                  <label htmlFor="retainResults" className="text-sm text-gray-300">
                    Retain results (copy to ConfigMap before cleanup)
                  </label>
                </div>
              </div>

              {/* Planner Configuration (only for metaMission) */}
              {form.metaMission && (
                <div className="mt-6 p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-lg space-y-3">
                  <div className="flex items-center gap-2 text-indigo-400 mb-2">
                    <Brain className="w-4 h-4" />
                    <h4 className="text-sm font-medium">Planner Configuration</h4>
                  </div>

                  <div>
                    <label htmlFor="wiz-planner-knight" className="block text-xs text-gray-400 mb-1">Planner Knight (optional)</label>
                    <input id="wiz-planner-knight"
                      value={form.planner.knightRef}
                      onChange={e => updatePlanner('knightRef', e.target.value)}
                      placeholder="table planner (default)"
                      className="w-full px-3 py-2 bg-roundtable-navy border border-indigo-500/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/50 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label htmlFor="wiz-planner-timeout" className="block text-xs text-gray-400 mb-1">Timeout (s)</label>
                      <input id="wiz-planner-timeout"
                        type="number"
                        value={form.planner.timeout}
                        onChange={e => updatePlanner('timeout', e.target.value)}
                        onBlur={() => touch('planner.timeout')}
                        {...aria('planner.timeout')}
                        className="w-full px-3 py-2 bg-roundtable-navy border border-indigo-500/30 rounded-lg text-white focus:outline-none focus:border-indigo-500/50 text-sm"
                      />
                      {fieldError('planner.timeout')}
                    </div>
                    <div>
                      <label htmlFor="wiz-max-chains" className="block text-xs text-gray-400 mb-1">Max Chains</label>
                      <input id="wiz-max-chains"
                        type="number"
                        min="1"
                        max="20"
                        value={form.planner.maxChains}
                        onChange={e => updatePlanner('maxChains', e.target.value)}
                        onBlur={() => touch('planner.maxChains')}
                        {...aria('planner.maxChains')}
                        className="w-full px-3 py-2 bg-roundtable-navy border border-indigo-500/30 rounded-lg text-white focus:outline-none focus:border-indigo-500/50 text-sm"
                      />
                      {fieldError('planner.maxChains')}
                    </div>
                    <div>
                      <label htmlFor="wiz-max-knights" className="block text-xs text-gray-400 mb-1">Max Knights</label>
                      <input id="wiz-max-knights"
                        type="number"
                        min="1"
                        max="50"
                        value={form.planner.maxKnights}
                        onChange={e => updatePlanner('maxKnights', e.target.value)}
                        onBlur={() => touch('planner.maxKnights')}
                        {...aria('planner.maxKnights')}
                        className="w-full px-3 py-2 bg-roundtable-navy border border-indigo-500/30 rounded-lg text-white focus:outline-none focus:border-indigo-500/50 text-sm"
                      />
                      {fieldError('planner.maxKnights')}
                    </div>
                  </div>

                  <div>
                    <label htmlFor="wiz-additional-context" className="block text-xs text-gray-400 mb-1">Additional Context (optional)</label>
                    <textarea id="wiz-additional-context"
                      value={form.planner.context}
                      onChange={e => updatePlanner('context', e.target.value)}
                      placeholder="Extra context for the planner..."
                      rows={2}
                      className="w-full px-3 py-2 bg-roundtable-navy border border-indigo-500/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/50 resize-none text-sm"
                    />
                  </div>

                  <div className="flex items-center gap-2 p-2 bg-roundtable-navy/50 border border-indigo-500/30 rounded">
                    <input
                      type="checkbox"
                      id="allowSkillGeneration"
                      checked={form.planner.allowSkillGeneration}
                      onChange={e => updatePlanner('allowSkillGeneration', e.target.checked)}
                      className="w-4 h-4 rounded border-indigo-500/30 bg-roundtable-navy"
                    />
                    <label htmlFor="allowSkillGeneration" className="text-xs text-gray-300">
                      Allow skill generation (planner can create new skills)
                    </label>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-300">Mission Summary</h3>
              <div className="bg-roundtable-navy rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Name:</span>
                  <span className="text-white">{form.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Objective:</span>
                  <span className="text-white truncate ml-4">{form.objective}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">RoundTable:</span>
                  <span className="text-white">{form.roundTableRef || '(none)'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Budget:</span>
                  <span className="text-roundtable-gold">${form.costBudgetUSD}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Cleanup:</span>
                  <span className="text-white">{form.cleanupPolicy}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Retain Results:</span>
                  <span className="text-white">{form.retainResults ? 'Yes' : 'No'}</span>
                </div>
                {!form.metaMission && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Knights:</span>
                    <span className="text-white">{form.knights.filter(k => k.name.trim()).map(k => k.name).join(', ') || '(none)'}</span>
                  </div>
                )}
                {form.metaMission && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Meta-Mission:</span>
                    <span className="text-indigo-400">Enabled (max {form.planner.maxChains} chains, {form.planner.maxKnights} knights)</span>
                  </div>
                )}
              </div>

              {error && <ErrorBanner>{error}</ErrorBanner>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-roundtable-steel">
          <button
            onClick={() => step > 0 ? setStep(step - 1) : onClose()}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" />
            {step > 0 ? 'Back' : 'Cancel'}
          </button>

          {step < 3 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!steps[step].valid}
              className="px-4 py-2 bg-roundtable-gold/20 border border-roundtable-gold/30 text-roundtable-gold rounded-lg text-sm font-medium hover:bg-roundtable-gold/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting || invalidStep >= 0}
              className="flex items-center gap-2 px-4 py-2 bg-roundtable-gold/20 border border-roundtable-gold/30 text-roundtable-gold rounded-lg text-sm font-medium hover:bg-roundtable-gold/30 disabled:opacity-50"
            >
              <Rocket className="w-4 h-4" />
              {submitting ? 'Dispatching...' : 'Dispatch Mission'}
            </button>
          )}
        </div>
    </Modal>
  )
}
