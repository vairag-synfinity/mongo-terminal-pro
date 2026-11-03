import { useEffect } from 'react';
import { useUi } from '../context.js';

/** Registers a focused text field so global single-key shortcuts (?, W, q) are suppressed. */
export function useInputFocus(focused: boolean): void {
  const { acquire } = useUi().inputFocus;
  useEffect(() => {
    if (!focused) return;
    return acquire();
  }, [focused, acquire]);
}
