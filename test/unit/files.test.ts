import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pageFile } from '../../src/lib/files.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pizza-files-'));
  file = join(dir, 'page.js');
  writeFileSync(file, 'version one');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pageFile', () => {
  it('without reload, serves the copy read at start-up even after the file changes', () => {
    const serve = pageFile(file, false);
    writeFileSync(file, 'version two');
    expect(serve()).toBe('version one');
  });

  it('with reload, serves what is on disk now, every time (what development needs)', () => {
    const serve = pageFile(file, true);
    expect(serve()).toBe('version one');
    writeFileSync(file, 'version two');
    expect(serve()).toBe('version two');
    writeFileSync(file, 'version three');
    expect(serve()).toBe('version three');
  });

  it.each([false, true])('fails at start-up, not on the first request, if the file is missing (reload=%s)', (reload) => {
    expect(() => pageFile(join(dir, 'missing.html'), reload)).toThrow(/ENOENT/);
  });
});
