// Stops files with something private in them (addresses, local paths, keys) from going public. The patterns live
// outside the repo, in ~/.img2img/private-patterns.json ([{ "pattern", "flags", "what" }], IMG2IMG_PRIVATE_PATTERNS
// overrides the path), because listing them would publish the very things they guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATTERNS_FILE = process.env.IMG2IMG_PRIVATE_PATTERNS || path.join(os.homedir(), '.img2img', 'private-patterns.json');

// The patterns as [RegExp, what], or null when there's no patterns file
export function loadPrivatePatterns() {
  if (!fs.existsSync(PATTERNS_FILE)) return null;
  return JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8')).map(({ pattern, flags, what }) => [new RegExp(pattern, flags), what]);
}

// "file:line: what" for each text file (Buffer or string contents) containing a pattern
export function findPrivate(files, patterns) {
  const problems = [];
  for (const { name, content } of files) {
    if (Buffer.isBuffer(content) && content.includes(0)) continue; // binary (icons)
    const text = content.toString('utf8');
    for (const [pattern, what] of patterns) {
      const match = text.match(pattern);
      if (match) problems.push(`${name}:${text.slice(0, match.index).split('\n').length}: ${what}`);
    }
  }
  return problems;
}

export { PATTERNS_FILE };
