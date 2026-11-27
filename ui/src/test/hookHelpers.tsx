import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'

/** Router wrapper for renderHook: starts at `path` + `search`. */
export const routerWrapper = (path: string) => (search = '') =>
  ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [path + search] }, children)

/** Build a JSON Response for a stubbed fetch. */
export const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init)
