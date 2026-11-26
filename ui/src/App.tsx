import { useState, useEffect, lazy, Suspense } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { Swords, Shield, Scroll, GitGraph, BookOpen, Link2, TreePine, Menu, X, LayoutDashboard, Target, DollarSign, Crown, Network, Activity, Inbox, Skull, MessageSquare, Zap, CalendarClock } from 'lucide-react'
import { ToastProvider, useToast } from './components/Toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useWebSocket, WebSocketProvider } from './hooks/useWebSocket'
import { useTaskNotifications } from './hooks/useTaskNotifications'
import { useTableFilter } from './hooks/useTableFilter'
import { useTables } from './hooks/useTables'
import { TableSelect } from './components/ui'
import { useOpenDeadLetters } from './hooks/useOpenDeadLetters'

const FleetPage = lazy(() => import('./pages/Fleet').then(m => ({ default: m.FleetPage })))
const TasksPage = lazy(() => import('./pages/Tasks').then(m => ({ default: m.TasksPage })))
const BriefingsPage = lazy(() => import('./pages/Briefings').then(m => ({ default: m.BriefingsPage })))
const LivePage = lazy(() => import('./pages/Live').then(m => ({ default: m.LivePage })))
const TriggersPage = lazy(() => import('./pages/Triggers').then(m => ({ default: m.TriggersPage })))
const SchedulesPage = lazy(() => import('./pages/Schedules').then(m => ({ default: m.SchedulesPage })))
const TriggerDetailPage = lazy(() => import('./pages/Triggers').then(m => ({ default: m.TriggerDetailPage })))
const ScheduleDetailPage = lazy(() => import('./pages/ScheduleDetail').then(m => ({ default: m.ScheduleDetailPage })))
const ChainsPage = lazy(() => import('./pages/Chains').then(m => ({ default: m.ChainsPage })))
const SessionsPage = lazy(() => import('./pages/Sessions').then(m => ({ default: m.SessionsPage })))
const DashboardPage = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.DashboardPage })))
const MissionsPage = lazy(() => import('./pages/Missions').then(m => ({ default: m.MissionsPage })))
const CostDashboardPage = lazy(() => import('./pages/CostDashboard').then(m => ({ default: m.CostDashboardPage })))
const ArchitecturePage = lazy(() => import('./pages/Architecture').then(m => ({ default: m.ArchitecturePage })))
const RunningPage = lazy(() => import('./pages/Running').then(m => ({ default: m.RunningPage })))
const QueuesPage = lazy(() => import('./pages/Queues').then(m => ({ default: m.QueuesPage })))
const FailedTasksPage = lazy(() => import('./pages/FailedTasks').then(m => ({ default: m.FailedTasksPage })))
const ChatPage = lazy(() => import('./pages/Chat').then(m => ({ default: m.ChatPage })))
const RoundTablesPage = lazy(() => import('./pages/RoundTables').then(m => ({ default: m.RoundTablesPage })))

function PageLoading() {
  return <div className="text-gray-400 p-4" role="status">Loading…</div>
}

function NotificationWatcher() {
  const { events } = useWebSocket()
  const { addToast } = useToast()
  useTaskNotifications(events, addToast)
  return null
}

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Command Center' },
  { path: '/fleet', icon: Shield, label: 'Fleet' },
  { path: '/running', icon: Activity, label: 'Running' },
  { path: '/missions', icon: Target, label: 'Missions' },
  { path: '/roundtables', icon: Crown, label: 'Round Tables' },
  { path: '/chat', icon: MessageSquare, label: 'Chat' },
  { path: '/quests', icon: Scroll, label: 'Dispatch' },
  { path: '/queues', icon: Inbox, label: 'Queues' },
  { path: '/failed', icon: Skull, label: 'Failed & lost' },
  { path: '/flow', icon: GitGraph, label: 'Message Flow' },
  { path: '/chains', icon: Link2, label: 'Chains' },
  { path: '/triggers', icon: Zap, label: 'Triggers' },
  { path: '/schedules', icon: CalendarClock, label: 'Schedules' },
  { path: '/costs', icon: DollarSign, label: 'Cost Details' },
  { path: '/sessions', icon: TreePine, label: 'Sessions' },
  { path: '/architecture', icon: Network, label: 'Architecture' },
  { path: '/chronicles', icon: BookOpen, label: 'Chronicles' },
]

export default function App() {
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { table, setTable } = useTableFilter()
  const tables = useTables()
  const openDeadLetters = useOpenDeadLetters(table)

  // Close sidebar on navigation (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  return (
    <WebSocketProvider>
    <ToastProvider>
    <div className="flex h-screen">
      <NotificationWatcher />

      {/* Mobile header (#58) */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-roundtable-slate border-b border-roundtable-steel px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Swords className="w-6 h-6 text-roundtable-gold" />
          <span className="text-sm font-bold text-roundtable-gold">Round Table</span>
        </div>
        <button onClick={() => setSidebarOpen(o => !o)} className="text-gray-400 p-1">
          {sidebarOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* Sidebar backdrop (mobile) */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <nav className={`fixed md:relative z-40 h-full w-64 bg-roundtable-slate border-r border-roundtable-steel flex flex-col transition-transform duration-200 ${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
      }`}>
        <div className="p-6 border-b border-roundtable-steel hidden md:block">
          <div className="flex items-center gap-3">
            <Swords className="w-8 h-8 text-roundtable-gold" />
            <div>
              <h1 className="text-lg font-bold text-roundtable-gold">⚔️ The Round Table</h1>
              <p className="text-xs text-gray-400">Observability & Traceability</p>
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 space-y-1 mt-14 md:mt-0">
          {navItems.map(({ path, icon: Icon, label }) => {
            const active = location.pathname === path
            return (
              <Link
                key={path}
                to={table ? `${path}?table=${encodeURIComponent(table)}` : path}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                  active
                    ? 'bg-roundtable-gold/10 text-roundtable-gold border border-roundtable-gold/20'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-roundtable-steel/50'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium">{label}</span>
                {path === '/failed' && openDeadLetters > 0 && (
                  <span className="ml-auto px-2 py-0.5 rounded-full text-xs bg-red-500/20 text-red-400" aria-label={`${openDeadLetters} open`}>
                    {openDeadLetters}
                  </span>
                )}
              </Link>
            )
          })}
        </div>

        <div className="p-4 border-t border-roundtable-steel">
          <p className="text-xs text-gray-500 text-center">
            ⚔️ Round Table v1.0.0
          </p>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-4 md:p-8 mt-14 md:mt-0">
        <ErrorBoundary>
          <div className="flex justify-end mb-4 empty:hidden">
            <TableSelect tables={tables} value={table} onChange={setTable} />
          </div>
          <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/running" element={<RunningPage />} />
            <Route path="/missions" element={<MissionsPage />} />
            <Route path="/roundtables" element={<RoundTablesPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/quests" element={<TasksPage />} />
            <Route path="/queues" element={<QueuesPage />} />
            <Route path="/failed" element={<FailedTasksPage />} />
            <Route path="/flow" element={<LivePage />} />
            <Route path="/chronicles" element={<BriefingsPage />} />
            <Route path="/chains" element={<ChainsPage />} />
            <Route path="/triggers" element={<TriggersPage />} />
            <Route path="/triggers/:namespace/:name" element={<TriggerDetailPage />} />
            <Route path="/schedules/:namespace/:name" element={<ScheduleDetailPage />} />
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/costs" element={<CostDashboardPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/architecture" element={<ArchitecturePage />} />
          </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
    </ToastProvider>
    </WebSocketProvider>
  )
}
