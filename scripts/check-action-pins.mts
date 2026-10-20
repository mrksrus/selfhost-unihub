// Checks that every pinned GitHub Action in .github/workflows/ names the
// commit its version comment says: `uses: owner/repo@<sha> # vX.Y.Z` must
// match the upstream tag vX.Y.Z (annotated tags are followed to their commit).
//
//   node scripts/check-action-pins.mts
//
// Uses the GitHub CLI (`gh api`), so it needs `gh` signed in or GH_TOKEN set.
// Run it when a workflow or a Dependabot action update changes a pin.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const workflows = path.join(root, '.github/workflows');
const PIN = /uses:\s*([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]{40})\s*#\s*(v[\w.-]+)/;
const LOOSE = /uses:\s*([\w.-]+\/[\w.-]+)[^@\s]*@(\S+)/;

const api = (endpoint: string) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
const commitOf = (repo: string, tag: string) => {
  let object = api(`repos/${repo}/git/ref/tags/${tag}`).object;
  while (object.type === 'tag') object = api(`repos/${repo}/git/tags/${object.sha}`).object;
  return object.sha as string;
};

const pins = new Map<string, { repo: string; sha: string; tag: string; places: string[] }>();
const problems: string[] = [];
for (const file of fs.readdirSync(workflows).filter(name => /\.ya?ml$/.test(name))) {
  fs.readFileSync(path.join(workflows, file), 'utf8').split('\n').forEach((line, index) => {
    const place = `${file}:${index + 1}`;
    const pin = PIN.exec(line);
    if (pin) {
      const [, repo, sha, tag] = pin;
      const key = `${repo}@${sha}#${tag}`;
      if (!pins.has(key)) pins.set(key, { repo, sha, tag, places: [] });
      pins.get(key)!.places.push(place);
      return;
    }
    const loose = LOOSE.exec(line);
    // Local actions (./...) and docker:// images are not tag pins.
    if (loose && !line.includes('uses: ./') && !line.includes('docker://')) problems.push(`${place}: ${loose[1]}@${loose[2]} is not pinned as <sha> # <version>`);
  });
}

for (const { repo, sha, tag, places } of pins.values()) {
  let upstream: string;
  try { upstream = commitOf(repo, tag); } catch (error) {
    problems.push(`${repo} ${tag}: could not read the upstream tag (${(error as Error).message.split('\n')[0]}) [${places.join(', ')}]`);
    continue;
  }
  if (upstream === sha) console.log(`ok  ${repo} ${tag} ${sha}`);
  else problems.push(`${repo} ${tag}: pinned ${sha}, the tag is ${upstream} [${places.join(', ')}]`);
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
console.log(`${pins.size} pinned actions match their tags.`);
