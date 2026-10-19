// Checks the static import graph of the API (api/src) and the frontend (src,
// workers), run by `npm run lint` after ESLint:
//
//   node scripts/import-graph.mts
//
// - Fails on a static import cycle. Load order inside a cycle decides which
//   module sees the other half-initialized; a lazy require() is the
//   deliberate way to break one, and those are reported below.
// - Fails when an exception list in eslint.boundaries.js names a file that no
//   longer needs it, or grows past its ceiling: the lists only shrink.
// - Reports the lazy require() edges from routes into services/mail-engine/,
//   so a new one shows in the output of a change.
// Type-only imports are erased at build time and are not edges.
import fs from 'node:fs';
import path from 'node:path';

interface Boundary { ceiling: number; files: string[] }

const root = path.resolve(import.meta.dirname, '..');
const EXTENSIONS = ['.ts', '.tsx', '.cts', '.mts'];
const SPECIFIER = /(?:^|\n)\s*import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+(type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(file, out); }
    else if (EXTENSIONS.some(ext => file.endsWith(ext)) && !file.endsWith('.d.ts')) out.push(file);
  }
  return out;
}

function resolve(from: string, specifier: string, aliasRoot: string) {
  let target: string;
  if (specifier.startsWith('@/')) target = path.join(aliasRoot, specifier.slice(2));
  else if (specifier.startsWith('.')) target = path.resolve(path.dirname(from), specifier);
  else return null;
  const candidates = [target, ...EXTENSIONS.map(ext => target + ext), ...EXTENSIONS.map(ext => path.join(target, `index${ext}`))];
  if (target.endsWith('.js')) candidates.push(...EXTENSIONS.map(ext => target.slice(0, -3) + ext));
  return candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

function graphOf(dirs: string[], aliasRoot: string) {
  const imports = new Map<string, Set<string>>();
  const lazy = new Map<string, Set<string>>();
  for (const file of dirs.flatMap(dir => walk(path.join(root, dir)))) {
    const source = fs.readFileSync(file, 'utf8');
    const staticEdges = new Set<string>(), lazyEdges = new Set<string>();
    for (const match of source.matchAll(SPECIFIER)) {
      if (match[1] || match[6]) continue;
      const specifier = match[2] || match[3] || match[4] || match[5] || match[7];
      const target = resolve(file, specifier, aliasRoot);
      if (!target) continue;
      (match[4] || match[5] ? lazyEdges : staticEdges).add(path.relative(root, target));
    }
    imports.set(path.relative(root, file), staticEdges);
    lazy.set(path.relative(root, file), lazyEdges);
  }
  return { imports, lazy };
}

// Strongly connected components with more than one file (Tarjan).
function cycles(imports: Map<string, Set<string>>) {
  let counter = 0;
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (file: string) => {
    index.set(file, counter); low.set(file, counter); counter++;
    stack.push(file); onStack.add(file);
    for (const next of imports.get(file) || []) {
      if (!imports.has(next)) continue;
      if (!index.has(next)) { visit(next); low.set(file, Math.min(low.get(file)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(file, Math.min(low.get(file)!, index.get(next)!));
    }
    if (low.get(file) === index.get(file)) {
      const component: string[] = [];
      let member: string;
      do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== file);
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const file of imports.keys()) if (!index.has(file)) visit(file);
  return found;
}

const failures: string[] = [];
const api = graphOf(['api/src'], path.join(root, 'api/src'));
const web = graphOf(['src', 'workers'], path.join(root, 'src'));
for (const component of [...cycles(api.imports), ...cycles(web.imports)]) {
  failures.push(`Static import cycle: ${component.join(' -> ')}`);
}

const boundariesPath = '../eslint.boundaries.js';
const { ROUTES_USING_DB, VIEWS_USING_API_CLIENT, API_FILES_USING_CONSOLE } = await import(boundariesPath) as Record<string, Boundary>;
const allImports = new Map([...api.imports, ...web.imports]);
function checkBoundary(name: string, boundary: Boundary, stillNeeded: (file: string) => boolean) {
  if (boundary.files.length > boundary.ceiling) failures.push(`${name} in eslint.boundaries.js grew past its ceiling of ${boundary.ceiling}; follow the rule instead.`);
  for (const file of boundary.files) {
    if (!allImports.has(file)) failures.push(`${name}: ${file} does not exist; remove it from eslint.boundaries.js.`);
    else if (!stillNeeded(file)) failures.push(`${name}: ${file} follows the rule now; remove it from eslint.boundaries.js and lower the ceiling.`);
  }
}
const usesAny = (file: string, targets: readonly string[]) => [...allImports.get(file) || []].some(target => targets.includes(target));
for (const [name, boundary, targets] of [
  ['ROUTES_USING_DB', ROUTES_USING_DB, ['api/src/state.ts']],
  ['VIEWS_USING_API_CLIENT', VIEWS_USING_API_CLIENT, ['src/lib/api.ts']],
] as const) {
  checkBoundary(name, boundary, file => usesAny(file, targets));
}
const CONSOLE_CALL = /\bconsole\.(log|error|warn|info|debug)\(/;
checkBoundary('API_FILES_USING_CONSOLE', API_FILES_USING_CONSOLE, file => CONSOLE_CALL.test(fs.readFileSync(path.join(root, file), 'utf8')));

const engineEdges = [...api.lazy].flatMap(([file, targets]) => file.startsWith('api/src/routes/')
  ? [...targets].filter(target => target.startsWith('api/src/services/mail-engine/')).map(target => `${file} -> ${target}`) : []);
console.log(`Import graph: ${api.imports.size} API and ${web.imports.size} frontend files checked.`);
if (engineEdges.length) console.log(`Lazy requires from routes into the mail engine:\n  ${engineEdges.join('\n  ')}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
