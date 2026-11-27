import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { Swords, Shield, Scroll, GitGraph, BookOpen, Link2, TreePine, Menu, X, LayoutDashboard, Target, DollarSign, Crown, Network, Activity, Inbox, Skull, MessageSquare, Zap, CalendarClock, Search, Moon } from 'lucide-react'
import { ToastProvider, useToast } from './components/Toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useWebSocket, WebSocketProvider } from './hooks/useWebSocket'
import { useTaskNotifications } from './hooks/useTaskNotifications'
import { useTitleBadge, badgedTitle } from './hooks/useTitleBadge'
import { useTableFilter } from './hooks/useTableFilter'
import { useTables } from './hooks/useTables'
import { TableSelect, EmptyState } from './components/ui'
import { useHealth } from './hooks/useHealth'
import { useVersion } from './hooks/useVersion'
import { CommandPalette } from './components/CommandPalette'
import { useOpenDeadLetters, deadLetterBadge } from './hooks/useOpenDeadLetters'

const FleetPage = lazy(() => import('./pages/Fleet').then(m => ({ default: m.FleetPage })))
const TasksPage = lazy(() => import('./pages/Tasks').then(m => ({ default: m.TasksPage })))
const BriefingsPage = lazy(() => import('./pages/Briefings').then(m => ({ default: m.BriefingsPage })))
const LivePage = lazy(() => import('./pages/Live').then(m => ({ default: m.LivePage })))
const TriggersPage = lazy(() => import('./pages/Triggers').then(m => ({ default: m.TriggersPage })))
const SchedulesPage = lazy(() => import('./pages/Schedules').then(m => ({ default: m.SchedulesPage })))
const ScheduleFormPage = lazy(() => import('./pages/ScheduleForm').then(m => ({ default: m.ScheduleFormPage })))
const TriggerDetailPage = lazy(() => import('./pages/Triggers').then(m => ({ default: m.TriggerDetailPage })))
const MissionDetailPage = lazy(() => import('./pages/MissionDetail').then(m => ({ default: m.MissionDetailPage })))
const ScheduleDetailPage = lazy(() => import('./pages/ScheduleDetail').then(m => ({ default: m.ScheduleDetailPage })))
const ChainsPage = lazy(() => import('./pages/Chains').then(m => ({ default: m.ChainsPage })))
const SessionsPage = lazy(() => import('./pages/Sessions').then(m => ({ default: m.SessionsPage })))
const DashboardPage = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.DashboardPage })))
const MissionsPage = lazy(() => import('./pages/Missions').then(m => ({ default: m.MissionsPage })))
const CostDashboardPage = lazy(() => import('./pages/CostDashboard').then(m => ({ default: m.CostDashboardPage })))
const ArchitecturePage = lazy(() => import('./pages/Architecture').then(m => ({ default: m.ArchitecturePage })))
const RunningPage = lazy(() => import('./pages/Running').then(m => ({ default: m.RunningPage })))
const OvernightPage = lazy(() => import('./pages/Overnight').then(m => ({ default: m.OvernightPage })))
const QueuesPage = lazy(() => import('./pages/Queues').then(m => ({ default: m.QueuesPage })))
const FailedTasksPage = lazy(() => import('./pages/FailedTasks').then(m => ({ default: m.FailedTasksPage })))
const ChatPage = lazy(() => import('./pages/Chat').then(m => ({ default: m.ChatPage })))
const RoundTablesPage = lazy(() => import('./pages/RoundTables').then(m => ({ default: m.RoundTablesPage })))

function PageLoading() {
  return <div className="text-gray-400 p-4" role="status">Loading…</div>
}

const APP_TITLE = 'Round Table'

function NotificationWatcher() {
  const { events } = useWebSocket()
  const { addToast } = useToast()
  useTaskNotifications(events, addToast)
  return null
}

/** Sets the document title, prefixed with the count of background results (#516). */
function TabTitle({ label }: { label: string }) {
  const { events } = useWebSocket()
  const badge = useTitleBadge(events)
  const base = `${label} - ${APP_TITLE}`
  useEffect(() => { document.title = badgedTitle(badge, base) }, [badge, base])
  return null
}

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Command Center' },
  { path: '/fleet', icon: Shield, label: 'Fleet' },
  { path: '/running', icon: Activity, label: 'Running' },
  { path: '/overnight', icon: Moon, label: 'Overnight' },
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

function isActivePath(pathname: string, path: string) {
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/')
}

export default function App() {
  const version = useVersion()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { table, setTable } = useTableFilter()
  const tables = useTables()
  const openDeadLetters = useOpenDeadLetters(table)
  const deadBadge = deadLetterBadge(openDeadLetters)
  const health = useHealth()
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Ctrl/Cmd+K opens the command palette (#479), unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      setPaletteOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Close sidebar on navigation (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  // Close the mobile sidebar on Escape
  useEffect(() => {
    if (!sidebarOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSidebarOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sidebarOpen])

  // Page title from the nav label; focus <main> on route change (not on first load)
  const mainRef = useRef<HTMLElement>(null)
  const lastPath = useRef(location.pathname)
  const current = navItems.find(n => isActivePath(location.pathname, n.path))
  const pageLabel = current ? current.label : 'Page not found'
  useEffect(() => {
    if (lastPath.current === location.pathname) return
    lastPath.current = location.pathname
    mainRef.current?.focus()
  }, [location.pathname])

  return (
    <WebSocketProvider>
    <ToastProvider>
    <div className="flex h-screen">
      <NotificationWatcher />
      <TabTitle label={pageLabel} />

      <a href="#main" onClick={e => { e.preventDefault(); mainRef.current?.focus() }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:px-4 focus:py-2 focus:rounded focus:bg-roundtable-gold focus:text-black">
        Skip to content
      </a>

      {/* Mobile header (#58) */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-roundtable-slate border-b border-roundtable-steel px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Swords className="w-6 h-6 text-roundtable-gold" />
          <span className="text-sm font-bold text-roundtable-gold">Round Table</span>
        </div>
        <div className="flex items-center gap-2">
        <button type="button" onClick={() => setPaletteOpen(true)} className="text-gray-400 p-1" aria-label="Search">
          <Search className="w-6 h-6" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setSidebarOpen(o => !o)} className="text-gray-400 p-1"
          aria-label={sidebarOpen ? 'Close menu' : 'Open menu'} aria-expanded={sidebarOpen} aria-controls="main-nav">
          {sidebarOpen ? <X className="w-6 h-6" aria-hidden="true" /> : <Menu className="w-6 h-6" aria-hidden="true" />}
        </button>
        </div>
      </div>

      {/* Sidebar backdrop (mobile) */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-40" aria-hidden="true" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <nav id="main-nav" aria-label="Main" className={`fixed md:relative z-40 h-full w-64 bg-roundtable-slate border-r border-roundtable-steel flex flex-col transition-transform duration-200 ${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
      }`}>
        <div className="px-4 pt-4 hidden md:block">
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Search"
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-roundtable-steel bg-roundtable-navy text-sm text-gray-400 hover:text-gray-200">
            <Search className="w-4 h-4" aria-hidden="true" />
            <span>Search</span>
            <kbd className="ml-auto text-xs text-gray-500">Ctrl K</kbd>
          </button>
        </div>
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
            const active = isActivePath(location.pathname, path)
            return (
              <Link
                key={path}
                aria-current={active ? 'page' : undefined}
                to={table ? `${path}?table=${encodeURIComponent(table)}` : path}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                  active
                    ? 'bg-roundtable-gold/10 text-roundtable-gold border border-roundtable-gold/20'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-roundtable-steel/50'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium">{label}</span>
                {path === '/failed' && (openDeadLetters.count > 0 || openDeadLetters.error) && (
                  <span className="ml-auto px-2 py-0.5 rounded-full text-xs bg-red-500/20 text-red-400" aria-label={deadBadge.title} title={deadBadge.title}>
                    {deadBadge.text}
                  </span>
                )}
              </Link>
            )
          })}
        </div>

        <div className="p-4 border-t border-roundtable-steel">
          <p className="text-xs text-gray-500 text-center">
            ⚔️ Round Table
          </p>
          {version?.version && (
            <p className="text-xs text-gray-500 text-center mt-1" data-testid="build-version">
              v{version.version}{version.commit ? ` (${version.commit.slice(0, 7)})` : ''}
            </p>
          )}
        </div>
      </nav>

      {/* Main content */}
      <main id="main" ref={mainRef} tabIndex={-1} className="focus:outline-none flex-1 overflow-auto p-4 md:p-8 mt-14 md:mt-0">
        <ErrorBoundary>
          {health?.kubernetes === 'unavailable' && (
            <div role="alert" className="mb-4 px-4 py-2 rounded border border-yellow-500/30 bg-yellow-500/10 text-sm text-yellow-300">
              Kubernetes unavailable: the dashboard API cannot read cluster state
            </div>
          )}
          <div className="flex justify-end mb-4 empty:hidden">
            <TableSelect tables={tables} value={table} onChange={setTable} />
          </div>
          <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/running" element={<RunningPage />} />
            <Route path="/overnight" element={<OvernightPage />} />
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
            <Route path="/missions/:name" element={<MissionDetailPage />} />
            <Route path="/schedules/:namespace/:name" element={<ScheduleDetailPage />} />
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/schedules/new" element={<ScheduleFormPage />} />
            <Route path="/schedules/:namespace/:name/edit" element={<ScheduleFormPage />} />
            <Route path="/costs" element={<CostDashboardPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/architecture" element={<ArchitecturePage />} />
            <Route path="*" element={
              <div>
                <EmptyState titleAs="h1" title="Page not found" sub="The page you asked for does not exist." />
                <p className="text-center"><Link to={table ? `/?table=${encodeURIComponent(table)}` : '/'} className="text-roundtable-gold underline">Back to Command Center</Link></p>
              </div>
            } />
          </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} pages={navItems} table={table} />}
    </div>
    </ToastProvider>
    </WebSocketProvider>
  )
}
