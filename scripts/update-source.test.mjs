import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

test('packaged updater is isolated from the official release and policy feeds', () => {
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  const updater = readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8');
  assert.match(builder, /owner:\s*wenkangbr\s*\r?\n\s*repo:\s*sei/);
  assert.doesNotMatch(updater, /https:\/\/dl\.sei\.gg\/updates/);
  assert.doesNotMatch(updater, /https:\/\/sei\.gg\/version(?:-beta)?\.json/);
  assert.match(updater, /https:\/\/github\.com\/wenkangbr\/sei\/releases/);
});
