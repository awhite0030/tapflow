/* eslint-disable react-refresh/only-export-components --
   The Provider and its consumer hook are one unit; splitting them across two files to satisfy
   Fast Refresh would spread a 19-line module for no reader benefit. */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type ContextValue = {
  node: ReactNode
  setNode: (node: ReactNode) => void
}

const BreadcrumbContext = createContext<ContextValue>({ node: null, setNode: () => {} })

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null)
  const value = useMemo(() => ({ node, setNode }), [node])
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>
}

export function useBreadcrumb() {
  return useContext(BreadcrumbContext)
}
