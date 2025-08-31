import { createContext, useContext, useState } from "react";
import type { ReactNode } from 'react';
export type ReplayData = any;

// Create the context
const ReplayContext = createContext<{
  replay: ReplayData | null;
  setReplay: (data: ReplayData) => void;
}>({
  replay: null,
  setReplay: () => { }
});

// Provider component
export function ReplayProvider({ children }: { children: ReactNode }) {
  const [replay, setReplay] = useState<ReplayData | null>(null);

  return (
    <ReplayContext.Provider value={{ replay, setReplay }}>
      {children}
    </ReplayContext.Provider>
  );
}

// Hook to use the context easily
export function useReplay() {
  return useContext(ReplayContext);
}
