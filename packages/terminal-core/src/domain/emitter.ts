import type { Unsubscribe } from '../ports/pty.js';

/** Minimal typed event emitter. A throwing listener never prevents the others from running. */
export class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  on(listener: (event: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listeners are observers; their failures must not affect the session.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
