import { Camera } from 'lucide-react'
import type { Knight } from '../../hooks/useFleet'
import { formatAge } from '../../lib/format'
import { sanitizeText } from '../../lib/untrusted'
import { SnapshotButton } from '../SnapshotButton'
import { CopyButton } from '../ui'

function SnapshotCopyButton({ name }: { name: string }) {
  return (
    <CopyButton
      text={name}
      iconOnly
      iconClassName="w-3 h-3"
      resetMs={1500}
      ariaLabel={`Copy snapshot name ${name}`}
      className="text-gray-500 hover:text-roundtable-gold"
    />
  )
}

export function SnapshotsSection({ knight, knightDetail, onDetail }: { knight: Knight; knightDetail: Knight; onDetail: (d: Knight) => void }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Camera className="w-4 h-4" />
        Workspace snapshots ({knightDetail.workspaceSnapshots?.length ?? 0})
        {knightDetail.workspaceSnapshotsCondition && (
          <span className={`text-xs font-normal ${knightDetail.workspaceSnapshotsCondition.status === 'False' ? 'text-amber-400' : 'text-gray-500'}`}>
            WorkspaceSnapshots: {sanitizeText(knightDetail.workspaceSnapshotsCondition.status)}
            {knightDetail.workspaceSnapshotsCondition.reason ? ` (${sanitizeText(knightDetail.workspaceSnapshotsCondition.reason)})` : ''}
          </span>
        )}
        <span className="ml-auto">
          <SnapshotButton name={knight.name} namespace={knight.namespace} knight={knightDetail} onDetail={onDetail} />
        </span>
      </h3>
      {knightDetail.workspaceSnapshotsCondition?.message && (
        <p className={`text-xs mb-2 ${knightDetail.workspaceSnapshotsCondition.status === 'False' ? 'text-amber-300' : 'text-gray-400'} break-words`}>{sanitizeText(knightDetail.workspaceSnapshotsCondition.message)}</p>
      )}
      {(knightDetail.workspaceSnapshots?.length ?? 0) === 0 ? (
        <p className="text-xs text-gray-500 bg-roundtable-slate border border-roundtable-steel/50 rounded-lg px-3 py-2">No snapshots yet</p>
      ) : (<>
      <ul className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg divide-y divide-roundtable-steel/30">
        {knightDetail.workspaceSnapshots!.map((snap) => (
          <li key={snap.name} className="px-3 py-2 flex items-center gap-2 text-xs">
            <span className="font-mono text-gray-200 truncate">{sanitizeText(snap.name)}</span>
            <SnapshotCopyButton name={snap.name} />
            <span className="ml-auto text-gray-500">{formatAge(snap.createdAt)}</span>
            <span className={`px-2 py-0.5 rounded-full border ${snap.readyToUse ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'}`}>
              {snap.readyToUse ? 'Ready' : 'Pending'}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500 mt-2">
        Fork from one with <code className="font-mono">spec.workspace.fromSnapshot</code>
      </p>
      </>)}
    </div>
  )
}
