import type { SignatureStore, SignedThinking, ThoughtBuffer } from '../core/streaming/types';

/**
 * Sessions whose latest signed thinking is kept. A long-running server sees
 * many sessions; the least recently used ones are dropped beyond this.
 */
export const MAX_SIGNATURE_SESSIONS = 500;

export function createSignatureStore(maxEntries: number = MAX_SIGNATURE_SESSIONS): SignatureStore {
  // A Map iterates in insertion order; re-inserting on access keeps it LRU.
  const store = new Map<string, SignedThinking>();

  return {
    get: (key: string) => {
      const value = store.get(key);
      if (value !== undefined) {
        store.delete(key);
        store.set(key, value);
      }
      return value;
    },
    set: (key: string, value: SignedThinking) => {
      store.delete(key);
      store.set(key, value);
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    has: (key: string) => store.has(key),
    delete: (key: string) => {
      store.delete(key);
    },
  };
}

export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();

  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => {
      buffer.set(index, text);
    },
    clear: () => buffer.clear(),
  };
}

export const defaultSignatureStore = createSignatureStore();
