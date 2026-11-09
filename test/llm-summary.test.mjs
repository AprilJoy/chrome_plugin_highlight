import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('long transcript summaries include the first and last chunks instead of a 4000-char prefix', async () => {
  const calls = [];
  const prompts = [];
  const context = vm.createContext({ URL, URLSearchParams, setTimeout, fetch: async (_url, options) => {
    const request = JSON.parse(options.body);
    const text = request.messages.at(-1).content;
    calls.push(text);
    prompts.push(request.messages[0].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: `摘要${calls.length}`, keywords: ['视频'] }) } }] }) };
  } });
  for (const file of ['content.js', 'llm.js']) vm.runInContext(fs.readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), context);
  const source = `[00:00] 开头${'甲'.repeat(6500)}\n[10:00] 结尾${'乙'.repeat(6500)}`;
  const result = await context.summarizeContent({ provider: 'deepseek', apiKey: 'fake' }, { title: '长视频', text: source, source: 'youtube' });
  assert.ok(calls.length >= 4);
  assert.ok(calls.some((text) => text.includes('开头')));
  assert.ok(calls.some((text) => text.includes('结尾')));
  assert.ok(calls.some((text) => text.includes('时间位置：10:00')));
  assert.ok(calls.slice(0, -1).every((text) => text.includes('时间位置：')));
  assert.ok(prompts.slice(0, -1).every((prompt) => prompt.includes('事实要点')));
  assert.ok(!prompts.at(-1).includes('事实要点'));
  assert.ok(result.summary);
});

test('an oversized intermediate note retries only that chunk with a stricter prompt', async () => {
  const requests = [];
  const context = vm.createContext({ URL, URLSearchParams, setTimeout, fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const summary = requests.length === 1 ? '长'.repeat(351) : '简短笔记';
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary, keywords: [] }) } }] }) };
  } });
  for (const file of ['content.js', 'llm.js']) vm.runInContext(fs.readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), context);
  const document = { title: '长片', source: 'youtube', transcriptKind: 'manual', text: `[00:00] ${'字'.repeat(5200)}\n[02:00] ${'文'.repeat(5200)}` };
  const result = await context.summarizeContent({ provider: 'deepseek', apiKey: 'fake' }, document);
  assert.ok(result.summary);
  assert.equal(requests.filter((item) => item.messages[0].content.includes('字数必须严格')).length, 1);
});

test('verbose notes from two model attempts still reach the final summary intact', async () => {
  const requests = [];
  const note = `${'事实'.repeat(260)}尾部关键事实`;
  const context = vm.createContext({ URL, URLSearchParams, setTimeout, fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const isNote = body.messages[0].content.includes('中间笔记');
    const summary = isNote ? note : '最终摘要';
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary, keywords: [] }) } }] }) };
  } });
  for (const file of ['content.js', 'llm.js']) vm.runInContext(fs.readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), context);
  const document = { title: '长片', source: 'youtube', transcriptKind: 'manual', text: `[00:00] ${'字'.repeat(65000)}` };
  const result = await context.summarizeContent({ provider: 'deepseek', apiKey: 'fake' }, document);
  assert.equal(result.summary, '最终摘要');
  assert.ok(requests.filter((item) => item.messages[0].content.includes('中间笔记')).length > 14);
  assert.ok(requests.at(-1).messages[1].content.includes('尾部关键事实'));
});

test('summary preferences reach the final prompt for short and chunked content', async () => {
  const prompts = [];
  const context = vm.createContext({ URL, URLSearchParams, setTimeout, fetch: async (_url, options) => {
    const request = JSON.parse(options.body);
    prompts.push(request.messages[0].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '摘要', keywords: [] }) } }] }) };
  } });
  for (const file of ['content.js', 'llm.js']) vm.runInContext(fs.readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), context);
  const config = { provider: 'deepseek', apiKey: 'fake' };
  for (const text of ['短内容', '字'.repeat(13000)]) {
    prompts.length = 0;
    await context.summarizeContent(config, { title: '测试', source: 'article', text }, { complexity: 'concise', language: 'en' });
    const final = prompts.at(-1);
    assert.match(final, /English/);
    assert.match(final, /约 50/);
    assert.match(final, /减少层级/);
    assert.match(final, /■ Summary:/);
    assert.match(final, /■ Suggestion:/);
    assert.ok(prompts.slice(0, -1).every((prompt) => prompt.includes('中间笔记') && !prompt.includes('English')));
  }
  await context.summarizeContent(config, { title: '默认', source: 'article', text: '短内容' });
  assert.match(prompts.at(-1), /约 100 字/);
  assert.match(prompts.at(-1), /简体中文/);
  await context.summarizeContent(config, { title: '详细', source: 'article', text: '短内容' }, { complexity: 'detailed' });
  assert.match(prompts.at(-1), /约 250–300 字/);
  assert.match(prompts.at(-1), /更多层级/);
});
