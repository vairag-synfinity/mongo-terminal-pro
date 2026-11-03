import { EventEmitter } from 'node:events';
import type { ConnectionProfile, ServerInfo } from '../connection/connection-types.js';

export interface AppEvents {
  'connection:connected': { profile: ConnectionProfile; server: ServerInfo };
  'connection:disconnected': { profileId: string };
  'connection:error': { profileId: string; message: string };
  'permissions:changed': { writeEnabled: boolean };
  'settings:changed': { keys: string[] };
  'metadata:invalidated': { database?: string; collection?: string };
}

/** A small typed wrapper over EventEmitter. */
export class EventManager {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}
