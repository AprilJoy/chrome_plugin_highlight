import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load() {
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(new URL('../src/lib/content.js', import.meta.url), 'utf8'), context);
  return context.CONTENT;
}

test('source routing accepts watch, shorts, live, embed, B站分P and X status', () => {
  const c = load();
  for (const url of [
    'https://www.youtube.com/watch?v=abc123XYZ00',
    'https://www.youtube.com/shorts/abc123XYZ00',
    'https://www.youtube.com/live/abc123XYZ00',
    'https://www.youtube.com/embed/abc123XYZ00',
  ]) assert.equal(c.detectSource(url).videoId, 'abc123XYZ00');
  assert.equal(c.detectSource('https://www.bilibili.com/video/BV1BbKw6XEWq?p=2').page, 2);
  assert.equal(c.detectSource('https://x.com/name/status/123456').source, 'x');
  assert.equal(c.detectSource('https://example.com/news').source, 'article');
});

test('normalizes subtitle time units and text posts without fake timestamps', () => {
  const c = load();
  const bili = c.createContent({ source: 'bilibili', url: 'https://www.bilibili.com/video/BV1BbKw6XEWq', title: '片', transcriptKind: 'ai', segments: [{ startMs: 1250, endMs: 2600, text: '你好' }] });
  assert.match(bili.text, /\[00:01\] 你好/);
  const post = c.createContent({ source: 'x', url: 'https://x.com/a/status/1', title: '帖', transcriptKind: 'text', segments: [{ startMs: 0, endMs: 0, text: '正文' }] });
  assert.equal(post.text, '正文');
});

test('chunks under 80,000 rendered chars even when segment boundaries would make too many chunks', () => {
  const c = load();
  const segments = Array.from({ length: 18 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, text: '字'.repeat(3900) }));
  const doc = c.createContent({ source: 'youtube', url: 'https://youtube.com/watch?v=abc123XYZ00', title: '长片', transcriptKind: 'manual', segments });
  const chunks = c.chunkText(doc.text);
  assert.ok(chunks.length <= 16);
  assert.ok(chunks.every((chunk) => chunk.length <= 5000));
  assert.equal(chunks.join(''), doc.text);
  assert.throws(() => c.chunkText('字'.repeat(80001)), /过长/);
  assert.equal(c.chunkText('字'.repeat(80000)).join('').length, 80000);
  assert.throws(() => c.createContent({ source: 'youtube', url: 'https://youtube.com', title: '空', segments: [] }), /没有可总结/);
});
