import { CopyButton } from './ui'

/** Raw URLs of the operator repo's quickstart manifests, pinned to main. */
const QUICKSTART_BASE = 'https://raw.githubusercontent.com/roundtable-k8s/roundtable/main/examples/quickstart'
export const FIRST_RUN_COMMAND = `kubectl apply -f ${QUICKSTART_BASE}/roundtable.yaml -f ${QUICKSTART_BASE}/knight.yaml`
export const FIRST_RUN_DOCS = 'https://github.com/roundtable-k8s/roundtable/blob/main/docs/getting-started.md'

/**
 * Shown on an empty fleet (the fleet request succeeded and returned no knights).
 * Explains what a Knight is and how to create the first one. The dashboard
 * does not create knights itself, so this panel only shows instructions.
 */
export function FirstRun() {
  return (
    <section aria-labelledby="first-run-title" className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-5 space-y-4">
      <div>
        <h2 id="first-run-title" className="text-lg font-semibold text-white">No knights yet</h2>
        <p className="text-sm text-gray-400 mt-1">
          A Knight is one long-running agent. It needs a RoundTable (the table it belongs to, with its NATS stream) before it can take tasks.
        </p>
      </div>

      <ol className="list-decimal list-inside text-sm text-gray-300 space-y-1">
        <li>Apply the quickstart manifests to your cluster.</li>
        <li>Wait for the Knight to become Ready (<code className="text-xs">kubectl get knights</code>).</li>
        <li>Refresh this page.</li>
      </ol>

      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate bg-black/30 border border-roundtable-steel rounded px-3 py-2 text-xs text-gray-200" title={FIRST_RUN_COMMAND}>
          {FIRST_RUN_COMMAND}
        </code>
        <CopyButton
          text={FIRST_RUN_COMMAND}
          label="Copy command"
          iconClassName="w-3 h-3"
          className="shrink-0 inline-flex items-center gap-1 text-xs text-roundtable-gold hover:underline px-2 py-2"
        />
      </div>

      <a href={FIRST_RUN_DOCS} target="_blank" rel="noreferrer" className="text-xs text-roundtable-gold hover:underline">
        Getting started guide
      </a>
    </section>
  )
}
