import { readFileSync } from 'node:fs';

/**
 * A page or script the server hands out as it is on disk. The file is read once at start-up either
 * way, so a missing file fails fast rather than on the first request. With `reload` it is read again
 * on every request, which is what development wants: otherwise the running server keeps serving the
 * copy it read when it started, because the dev watcher only restarts for changed modules, not for
 * changed pages (this cost a debugging session once). In production the start-up copy is served.
 */
export function pageFile(path: string, reload: boolean): () => string {
  const atStartup = readFileSync(path, 'utf8');
  return reload ? () => readFileSync(path, 'utf8') : () => atStartup;
}

/** Pages and scripts are never cached by the browser, so a change is seen on the next load. */
export const NO_CACHE = 'no-cache, no-store, must-revalidate';
