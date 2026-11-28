import { Component, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /** When any value changes (for example the route path), a tripped boundary clears and renders its children again. */
  resetKeys?: readonly unknown[]
}
interface State { hasError: boolean; error: Error | null }

function keysChanged(prev: readonly unknown[] = [], next: readonly unknown[] = []): boolean {
  return prev.length !== next.length || next.some((k, i) => !Object.is(k, prev[i]))
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info)
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ hasError: false, error: null })
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div role="alert" className="flex flex-col items-center justify-center min-h-[50vh] text-center p-8">
          <AlertTriangle className="w-16 h-16 text-yellow-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Something went wrong</h2>
          <p className="text-gray-400 mb-4 max-w-md">{this.state.error?.message || 'An unexpected error occurred'}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a
              href="/"
              className="px-4 py-2 border border-gray-600 text-gray-200 rounded-lg hover:bg-white/5 transition-colors"
            >
              Back to Command Center
            </a>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
              className="flex items-center gap-2 px-4 py-2 bg-roundtable-gold/20 border border-roundtable-gold/30 text-roundtable-gold rounded-lg hover:bg-roundtable-gold/30 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
