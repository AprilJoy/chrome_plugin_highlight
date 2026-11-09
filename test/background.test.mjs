import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('GENERATE routes an X status to the post adapter and returns its record type', async () => {
  let listener;
  let tabQuery;
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, Uint8Array, setTimeout, fetch: async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: '{"summary":"帖子摘要","keywords":["关键词"]}' } }] }),
  }) });
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    sidePanel: { setPanelBehavior: async () => {} },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    storage: { local: { get: async () => ({ config: { llm: { provider: 'deepseek', apiKey: 'fake' } } }) } },
    tabs: { query: async (query) => { tabQuery = query; return [{ id: 7, url: 'https://x.com/alice/status/123', title: 'X' }]; } },
    scripting: { executeScript: async ({ func }) => [{ result: func.name === 'postProbe' ? { text: '主帖内容', title: '主帖', hasMedia: false } : { url: 'https://x.com/alice/status/123', title: 'X' } }] },
  };
  context.chrome = chrome;
  context.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(fs.readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), context);
  };
  vm.runInContext(fs.readFileSync(new URL('../src/background.js', import.meta.url), 'utf8'), context);
  const response = await new Promise((resolve) => listener({ type: 'GENERATE', windowId: 1 }, {}, resolve));
  assert.equal(response.ok, true, response.error);
  assert.equal(response.data.recordType, '帖子');
  assert.equal(response.data.content, '主帖内容');
  assert.equal(response.data.summary, '帖子摘要');
  assert.equal(tabQuery.windowId, 1);
  assert.equal(tabQuery.active, true);
});

test('subtitle request uses worker fetch when page injection fails', async () => {
  let received;
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, Uint8Array, fetch: async (url, options) => {
    received = { url, options };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { ok: true } }) };
  } });
  context.chrome = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    sidePanel: { setPanelBehavior: async () => {} },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    scripting: { executeScript: async () => { throw new Error('injection unavailable'); } },
  };
  context.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(fs.readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), context);
  };
  vm.runInContext(fs.readFileSync(new URL('../src/background.js', import.meta.url), 'utf8'), context);
  const result = await context.fetchFromTabOrWorker(7, 'https://api.bilibili.com/x/player/v2', 'json', { credentials: 'include' });
  assert.equal(result.data.ok, true);
  assert.equal(received.options.credentials, 'include');
});
