import { createContext, useContext, useEffect, useRef } from 'react';
import type { MouseEvent } from '../../utils/terminal.js';

export type MouseListener = (event: MouseEvent) => void;

export interface MouseBus {
  enabled: boolean;
  subscribe(listener: MouseListener): () => void;
}

export function createMouseBus(enabled: boolean): MouseBus & { emit(e: MouseEvent): void } {
  const listeners = new Set<MouseListener>();
  return {
    enabled,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(e) {
      // Only the most recently subscribed (top-most, focused) listener receives wheel events.
      const last = [...listeners].pop();
      last?.(e);
    },
  };
}

export const MouseContext = createContext<MouseBus>({ enabled: false, subscribe: () => () => undefined });

/** Calls `onWheel(+1 | -1)` for wheel events while `active`. Keyboard remains the primary input. */
export function useMouseWheel(onWheel: (delta: 1 | -1) => void, active: boolean): void {
  const bus = useContext(MouseContext);
  const handler = useRef(onWheel);
  handler.current = onWheel;
  useEffect(() => {
    if (!bus.enabled || !active) return;
    return bus.subscribe((e) => {
      if (e.kind === 'wheel-up') handler.current(-1);
      else if (e.kind === 'wheel-down') handler.current(1);
    });
  }, [bus, active]);
}
