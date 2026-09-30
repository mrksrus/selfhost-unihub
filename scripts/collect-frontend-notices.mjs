import fs from 'node:fs/promises';
import path from 'node:path';

// Preserve notices from installed production dependencies alongside the bundle.
// Dependency code keeps its own license; the UniHub license does not replace it.
const root = process.cwd();
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const sections = ['Frontend dependency notices\n\nGenerated from the installed packages and package-lock.json.\n'];
for (const [relative, record] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!relative.startsWith('node_modules/') || record.dev) continue;
  const directory = path.join(root, relative);
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const files = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name))
    .map(entry => entry.name).sort();
  sections.push(`\n---\n${pkg.name}@${pkg.version}\nLicense: ${JSON.stringify(pkg.license || record.license || 'See upstream package')}\nSource package: ${record.resolved || pkg.homepage || ''}\n`);
  for (const file of files) sections.push(`\n${file}\n${await fs.readFile(path.join(directory, file), 'utf8')}\n`);
}
await fs.writeFile(path.resolve(process.argv[2] || 'frontend-dependency-notices.txt'), sections.join(''));
