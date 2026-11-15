import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Package checks own the module/manifest contract; this guards CSS leaking into DSH.
test('Client CSS stays inside the settings root without global or remote styles', async () => {
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)]
    .map((match) => match[1]!.trim())
    .filter((selector) => !selector.startsWith('@'));
  assert.ok(selectors.length > 0);
  for (const selector of selectors)
    for (const item of selector.split(/,(?![^()]*\))/u))
      assert.match(item.trim(), /^\.dsh-chat-recall(?:\s|:|$)/, item);
  assert.doesNotMatch(css, /@import|@font-face|:root|html\s*\{|body\s*\{|url\(https?:/);
});
