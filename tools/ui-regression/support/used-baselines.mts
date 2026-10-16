import fs from 'node:fs';
import path from 'node:path';
import { buildDir } from './env.mts';

/** Each compared baseline leaves a marker here, so a run can tell which approved pictures still have a test. */
export const usedBaselinesDir = path.join(buildDir, 'used-baselines');

export function markBaselineUsed(name: string) {
  fs.mkdirSync(usedBaselinesDir, { recursive: true });
  fs.writeFileSync(path.join(usedBaselinesDir, name), '');
}
