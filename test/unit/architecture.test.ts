import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the shape of the code, not its behaviour: dependencies run one way, so a call
// like "apply promo -> quote -> apply promo" cannot be written by accident.

const SRC = resolve(import.meta.dirname, '../../src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Local imports of a file, as paths relative to src/ with no extension. Imports of packages are ignored. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+'(\.[^']+)'|import\s+'(\.[^']+)'/g)].map((m) => m[1] ?? m[2]!);
  return specs.map((s) => relative(SRC, resolve(dirname(file), s)).replace(/\\/g, '/').replace(/\.js$/, ''));
}

const files = filesUnder(SRC);
const name = (file: string) => relative(SRC, file).replace(/\\/g, '/').replace(/\.ts$/, '');
const graph = new Map(files.map((f) => [name(f), importsOf(f)]));

describe('no module depends on itself, directly or through others', () => {
  it('has no import cycles anywhere in src/', () => {
    const visiting: string[] = [];
    const done = new Set<string>();
    const cycles: string[] = [];
    const visit = (node: string): void => {
      if (done.has(node)) return;
      const at = visiting.indexOf(node);
      if (at !== -1) return void cycles.push([...visiting.slice(at), node].join(' -> '));
      visiting.push(node);
      for (const next of graph.get(node) ?? []) visit(next);
      visiting.pop();
      done.add(node);
    };
    for (const node of graph.keys()) visit(node);
    expect(cycles).toEqual([]);
  });

  it('every import points at a file that exists', () => {
    const missing = [...graph].flatMap(([from, tos]) => tos.filter((to) => !graph.has(to)).map((to) => `${from} -> ${to}`));
    expect(missing).toEqual([]);
  });
});

describe('the pricing core depends on nothing but itself', () => {
  // Allowed imports for each module. Anything else fails, so layers can only point downward.
  const allowed: Record<string, string[]> = {
    'core/money': [],
    'core/order': ['core/money'],
    'core/menu': ['core/money'],
    // the three stages: none of them may know about another stage, or about the engine
    'core/lines': ['core/menu', 'core/money', 'core/order'],
    'core/promos': ['core/money', 'core/order'],
    'core/totals': ['core/money', 'core/order'],
    // the engine conducts the stages
    'core/pricing': ['core/menu', 'core/money', 'core/order', 'core/lines', 'core/promos', 'core/totals'],
    // comparing a claim to a result sits above the engine
    'core/claims': ['core/money', 'core/pricing'],
  };

  it('has an explicit rule for every module in src/core', () => {
    const coreModules = [...graph.keys()].filter((n) => n.startsWith('core/')).sort();
    expect(coreModules).toEqual(Object.keys(allowed).sort());
  });

  it.each(Object.entries(allowed))('%s imports only %j', (module, permitted) => {
    expect([...new Set(graph.get(module))].sort()).toEqual(expect.arrayContaining([]));
    const unexpected = (graph.get(module) ?? []).filter((dep) => !permitted.includes(dep));
    expect(unexpected).toEqual([]);
  });

  it('never reaches into the service, the builder or node-only code', () => {
    const reaching = [...graph].filter(([from, tos]) => from.startsWith('core/') && tos.some((t) => !t.startsWith('core/')));
    expect(reaching).toEqual([]);
    for (const file of files.filter((f) => name(f).startsWith('core/'))) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/from\s+'node:/);
    }
  });
});

describe('the service is layered: routes sit on top and nothing calls back up into them', () => {
  it('only app.ts imports a routes module', () => {
    const importers = [...graph].flatMap(([from, tos]) => tos.filter((t) => t.endsWith('/routes')).map(() => from));
    expect([...new Set(importers)]).toEqual(['service/app']);
  });

  it('the pricing, quote, place and update logic does not know HTTP exists', () => {
    for (const [from, tos] of graph) {
      if (from.startsWith('core/') || from === 'service/quote/service' || /^service\/orders\/(place|update|write)$/.test(from)) {
        expect(tos.filter((t) => /fastify|http|routes/.test(t)), from).toEqual([]);
        expect(readFileSync(join(SRC, `${from}.ts`), 'utf8'), from).not.toMatch(/from\s+'fastify'/);
      }
    }
  });

  it('a quote reads the stored snapshot and can never rebuild prices from the live menu', () => {
    // Prices are locked to what the customer was shown (D23). If the quote could reach the code
    // that resolves today's prices, a price change between menu load and quote would leak in.
    const quoteDeps = graph.get('service/quote/service') ?? [];
    expect(quoteDeps).toContain('service/menu/snapshots');
    expect(quoteDeps).not.toContain('service/menu/repo');
    const text = readFileSync(join(SRC, 'service/quote/service.ts'), 'utf8');
    expect(text).not.toMatch(/getActiveMenu|getOrCreateSnapshot/);
  });

  it('the data layer never imports the quote service', () => {
    for (const [from, tos] of graph) {
      if (/^service\/(menu|promos|orders)\/(repo|snapshots)$/.test(from)) {
        expect(tos.filter((t) => t.startsWith('service/quote')), from).toEqual([]);
      }
    }
  });
});
