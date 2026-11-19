import type { ReactNode } from 'react';

/** On phones the app fills the screen; the browser version (web-frame.web.tsx) frames it. */
export function WebFrame({ children }: { children: ReactNode }) {
  return children;
}
