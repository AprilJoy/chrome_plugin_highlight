import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load(...files) {
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, Uint8Array, setTimeout });
  for (const file of ['content.js', ...files]) {
    vm.runInContext(fs.readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), context);
  }
  return context;
}

test('YouTube selects live player response for current SPA video and parses JSON3', async () => {
  const { YOUTUBE } = load('youtube.js');
  const id = 'abc123XYZ00';
  const track = `https://www.youtube.com/api/timedtext?v=${id}&lang=en`;
  const doc = await YOUTUBE.extract(
    { source: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` },
    async () => ({ videoId: id, title: '当前视频', tracks: [{ baseUrl: track, languageCode: 'en', kind: '' }] }),
    async () => ({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }] })
  );
  assert.equal(doc.title, '当前视频');
  assert.equal(doc.segments[0].text, 'Hello world');
  assert.equal(doc.segments[0].endMs, 3000);
  await assert.rejects(() => YOUTUBE.extract(
    { source: 'youtube', videoId: 'new123XYZ00', url: 'https://www.youtube.com/watch?v=new123XYZ00' },
    async () => ({ videoId: id, tracks: [{ baseUrl: track }] }), async () => ({ events: [] })
  ), /不一致/);
  assert.throws(() => YOUTUBE.validateCaptionUrl('https://evil.example/api/timedtext'), /地址/);
  await assert.rejects(() => YOUTUBE.extract(
    { source: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` },
    async () => ({ videoId: id, title: '超长视频', tracks: [{ baseUrl: track }] }),
    async () => ({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '字'.repeat(80001) }] }] })
  ), /过长/);
});

test('B站 combines v2 other-language track with protobuf ai-zh and chooses ai-zh', async () => {
  const { BILIBILI } = load('bilibili.js');
  const bvid = 'BV1BbKw6XEWq';
  const subtitleUrl = 'https://aisubtitle.hdslb.com/bfs/subtitle/test.json';
  const bytes = (s) => [...new TextEncoder().encode(s)];
  const field = (number, body) => [number * 8 + 2, body.length, ...body];
  const aiTrack = field(3, bytes('ai-zh')).concat(field(4, bytes('中文 AI')), field(5, bytes(subtitleUrl)));
  const proto = new Uint8Array(field(1, field(3, aiTrack)));
  const calls = [];
  const fetcher = async (url, kind, options) => {
    calls.push({ url, kind, options });
    if (url.includes('/x/web-interface/view')) return { code: 0, data: { aid: 1, cid: 2, bvid, title: '视频', pages: [{ cid: 2, part: '第一集' }] } };
    if (url.includes('/x/player/v2')) return { code: 0, data: { subtitle: { subtitles: [{ lan: 'en', subtitle_url: 'https://aisubtitle.hdslb.com/en.json' }] } } };
    if (url.includes('/x/v2/subtitle/web/view')) return proto;
    if (url === subtitleUrl) return { body: [{ from: 1.25, to: 2.5, content: '中文内容' }] };
    throw new Error(`unexpected ${url}`);
  };
  const doc = await BILIBILI.extract({ source: 'bilibili', bvid, page: 1, url: `https://www.bilibili.com/video/${bvid}` }, fetcher);
  assert.equal(doc.language, 'ai-zh');
  assert.equal(doc.segments[0].startMs, 1250);
  assert.ok(calls.some(({ url }) => url.includes('/x/v2/subtitle/web/view')));
  assert.ok(calls.some(({ url }) => url.includes('/x/player/v2')));
  assert.equal(calls.find(({ url }) => url === subtitleUrl).options.credentials, 'omit');
  assert.throws(() => BILIBILI.validateSubtitleUrl('https://evil.example/caption.json'), /地址/);
  assert.throws(() => BILIBILI.parseProtoTracks(new Uint8Array([18, 0])), /格式不受支持/);
  assert.equal(BILIBILI.parseProtoTracks(new Uint8Array([10, 0])).length, 0);
});

test('Supadata uses native mode, polls 202 and synthesizes missing duration', async () => {
  const { SUPADATA } = load('supadata.js');
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { status: 202, ok: true, json: async () => ({ jobId: 'job1' }) };
    return { status: 200, ok: true, json: async () => ({ status: 'completed', lang: 'en', content: [{ offset: 100, text: 'first' }, { offset: 500, duration: 300, text: 'second' }] }) };
  };
  const result = await SUPADATA.fetchTranscript('https://x.com/a/status/1', 'secret', fetcher, async () => {});
  assert.match(calls[0].url, /mode=native/);
  assert.equal(calls[0].options.headers['x-api-key'], 'secret');
  assert.equal(result.segments[0].endMs, 500);
});

test('X text posts are plain text and do not include other visible posts', async () => {
  const { XPOST } = load('x.js');
  const doc = await XPOST.extract({ source: 'x', postId: '123', url: 'https://x.com/a/status/123' }, async () => ({ text: '主帖正文', title: '主帖正文', hasMedia: false }));
  assert.equal(doc.text, '主帖正文');
  assert.equal(doc.transcriptKind, 'text');
  await assert.rejects(() => XPOST.extract({ source: 'x', postId: '123', url: 'https://x.com/a/status/123' }, async () => ({ text: '', hasMedia: true })), /Supadata/);
});

test('YouTube reports missing captions, prefers manual tracks and retains page title in fallback', async () => {
  const context = load('youtube.js');
  const { YOUTUBE } = context;
  const info = { videoId: 'abc123XYZ00', url: 'https://www.youtube.com/watch?v=abc123XYZ00', title: '页面标题' };
  await assert.rejects(() => YOUTUBE.extract(info, async () => ({ videoId: info.videoId, tracks: [] }), async () => ({})), /没有可读取的字幕/);
  const urls = [];
  const doc = await YOUTUBE.extract(info, async () => ({ videoId: info.videoId, title: '播放器标题', tracks: [
    { baseUrl: 'https://www.youtube.com/api/timedtext?lang=en', kind: 'asr' },
    { baseUrl: 'https://www.youtube.com/api/timedtext?lang=zh', kind: '' },
  ] }), async (url) => { urls.push(url); return { events: [{ tStartMs: 0, segs: [{ utf8: '字幕' }] }] }; });
  assert.equal(doc.transcriptKind, 'manual');
  assert.match(urls[0], /lang=zh/);
  context.SUPADATA = { fetchTranscript: async () => ({ language: 'zh', segments: [{ startMs: 0, endMs: 1000, text: '后备字幕' }] }) };
  const fallback = await YOUTUBE.extract(info, async () => null, async () => ({}), 'fake-key');
  assert.equal(fallback.title, '页面标题');
});

test('B站 falls back after v2 failure and distinguishes no captions and invalid page', async () => {
  const { BILIBILI } = load('bilibili.js');
  const bvid = 'BV1BbKw6XEWq';
  const info = { bvid, page: 1, url: `https://www.bilibili.com/video/${bvid}` };
  const enc = (s) => [...new TextEncoder().encode(s)];
  const field = (number, data) => [number * 8 + 2, data.length, ...data];
  const url = 'https://aisubtitle.hdslb.com/zh.json';
  const proto = new Uint8Array(field(1, field(3, [...field(3, enc('ai-zh')), ...field(5, enc(url))])));
  const fetcher = async (request) => {
    if (request.includes('/x/web-interface/view')) return { code: 0, data: { aid: 1, cid: 2, title: '视频', pages: [{ cid: 2 }] } };
    if (request.includes('/x/player/v2')) return { code: -352, message: '风控' };
    if (request.includes('/x/v2/subtitle/web/view')) return proto;
    if (request === url) return { body: [{ from: 0, to: 1, content: '后备字幕' }] };
  };
  assert.equal((await BILIBILI.extract(info, fetcher)).text.includes('后备字幕'), true);
  await assert.rejects(() => BILIBILI.extract({ ...info, page: 2 }, fetcher), /分 P 编号超出范围/);
  await assert.rejects(() => BILIBILI.extract(info, async (request) => request.includes('/x/v2/subtitle/web/view') ? new Uint8Array() : fetcher(request)), /风控.*没有已有字幕/);
});

test('Supadata reports invalid job, failed job and timeout', async () => {
  const { SUPADATA } = load('supadata.js');
  const start = async () => ({ status: 202, ok: true, json: async () => ({ jobId: 'job1' }) });
  await assert.rejects(() => SUPADATA.fetchTranscript('https://x.com/a/status/1', 'key', async () => ({ status: 202, ok: true, json: async () => ({ jobId: '../bad' }) }), async () => {}), /无效任务编号/);
  for (const [payload, error] of [[{ status: 'failed' }, /无法取得/], [{ status: 'processing' }, /超时/]]) {
    let count = 0;
    await assert.rejects(() => SUPADATA.fetchTranscript('https://x.com/a/status/1', 'key', async () => {
      count++;
      return count === 1 ? start() : { status: 200, ok: true, json: async () => payload };
    }, async () => {}), error);
  }
});
