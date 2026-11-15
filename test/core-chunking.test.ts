import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNKING_VERSION, chunkText, type ChunkOptions } from '../dist/core/chunking.js';

const size = (text: string) => [...text].length;
function verify(text: string, options?: ChunkOptions) {
  const parts = chunkText(text, options);
  let end = 0;
  for (const part of parts) {
    assert.equal(part.start, end);
    assert.ok(part.end > part.start);
    assert.equal(text.slice(part.start, part.end), part.text);
    assert.ok(size(part.text) <= (options?.target ?? 600) + (options?.minTail ?? 120));
    if (part.end < text.length) {
      const before = text.charCodeAt(part.end - 1),
        after = text.charCodeAt(part.end);
      assert.ok(
        !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff),
        'surrogate pair stays together',
      );
    }
    end = part.end;
  }
  assert.equal(end, text.length);
  assert.equal(parts.map((part) => part.text).join(''), text);
  return parts;
}

test('version is stable and empty text produces no chunks', () => {
  assert.equal(CHUNKING_VERSION, 'paragraph-v1');
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(' \t\r\n'), [{ start: 0, end: 4, text: ' \t\r\n' }]);
});

test('UTF-16 offsets preserve whitespace, CRLF, combining marks and astral points', () => {
  const text = ' \t原文🐳𠮷e\u0301\u200b。\r\n  双空格\n\n下一段“保持原样”！\n'.repeat(80);
  verify(text);
  const astral = verify('🐳'.repeat(601));
  assert.equal(astral.length, 1, 'target is measured in codepoints, not UTF-16 units');
  assert.equal(astral[0].end, 1202);
});

test('nearby paragraph boundary takes priority over closer sentence boundaries', () => {
  const text = '甲'.repeat(480) + '\n\n' + '乙'.repeat(117) + '。' + '丙'.repeat(900);
  const parts = verify(text);
  assert.equal(parts[0].end, 482);
  assert.ok(parts[0].text.endsWith('\n\n'));
});

test('blank-line paragraphs support CRLF and whitespace-only blank lines', () => {
  const text = '甲'.repeat(490) + '\r\n \t\r\n' + '乙'.repeat(1000);
  assert.equal(verify(text)[0].text, '甲'.repeat(490) + '\r\n \t\r\n');
});

test('a single CRLF is a line break, not a blank paragraph', () => {
  const text = '甲'.repeat(300) + '\r\n' + '乙'.repeat(297) + '。' + '丙'.repeat(900);
  assert.equal(verify(text)[0].end, 600);
});

test('sentence closers and single newlines are preferred before a hard cut', () => {
  const sentence = '甲'.repeat(588) + '。” ' + '乙'.repeat(900);
  assert.equal(verify(sentence)[0].end, 591);
  const newline = '甲'.repeat(588) + '\n' + '乙'.repeat(900);
  assert.equal(verify(newline)[0].end, 589);
});

test('long boundary-free text hard cuts without splitting surrogate pairs', () => {
  const text = 'A🐳B𠮷C'.repeat(1000);
  const parts = verify(text, { target: 17, minTail: 3 });
  assert.ok(parts.length > 200);
  assert.ok(parts.slice(0, -1).every((part) => size(part.text) === 17));
});

test('short tails merge without exceeding the maximum chunk size', () => {
  for (const [length, expected] of [
    [607, [607]],
    [1207, [600, 607]],
  ] as const)
    assert.deepEqual(
      verify('甲'.repeat(length)).map((part) => size(part.text)),
      expected,
    );
  const text = '甲'.repeat(718) + '\n\n' + '乙'.repeat(7);
  const parts = verify(text);
  assert.deepEqual(
    parts.map((part) => size(part.text)),
    [600, 127],
  );
});

test('paragraph choice cannot leave a tiny final block or overflow the maximum', () => {
  const text = '甲'.repeat(650) + '\n\n' + '乙'.repeat(77);
  const parts = verify(text);
  assert.ok(parts.every((part) => size(part.text) >= 120));
  for (let length = 1; length <= 80; length++) {
    for (let target = 1; target <= 7; target++) {
      for (const minTail of [0, 1, 3, 12])
        verify('🐳x\n\n。 '.repeat(20).slice(0, length), { target, minTail });
    }
  }
});

test('small requested sizes and all-delimiter text still terminate and cover exactly', () => {
  assert.deepEqual(
    verify('A🐳B', { target: 1, minTail: 0 }).map((part) => part.text),
    ['A', '🐳', 'B'],
  );
  verify('\n'.repeat(2000));
  verify('。'.repeat(2000));
  verify('\r\n \t\r\n'.repeat(400));
});

test('invalid arguments fail rather than silently rewriting text', () => {
  for (const target of [0, -1, 1.2, Infinity, NaN])
    assert.throws(() => chunkText('x', { target }), RangeError);
  for (const minTail of [-1, 1.2, Infinity, NaN])
    assert.throws(() => chunkText('x', { minTail }), RangeError);
  assert.throws(() => chunkText(null as unknown as string), TypeError);
});
