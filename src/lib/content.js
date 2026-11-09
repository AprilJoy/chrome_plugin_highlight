// Unified source and transcript representation shared by YouTube, X and Bilibili.
(function () {
  const MAX_TEXT = 80000;
  const CHUNK_SIZE = 5000;

  function detectSource(value) {
    let url;
    try { url = new URL(value); } catch (_) { return { source: 'article' }; }
    const host = url.hostname.toLowerCase();
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
      let videoId = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0] : '';
      if (!videoId && url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
      if (!videoId) videoId = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})(?:\/|$)/)?.[1] || '';
      return videoId && /^[\w-]{11}$/.test(videoId)
        ? { source: 'youtube', videoId }
        : { source: 'article' };
    }
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
      const bvid = url.pathname.match(/^\/video\/(BV[\w]+)/i)?.[1];
      if (bvid) {
        const p = Number(url.searchParams.get('p') || '1');
        return { source: 'bilibili', bvid, page: Number.isInteger(p) && p > 0 ? p : 1 };
      }
    }
    if (host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com') {
      const postId = url.pathname.match(/^\/[^/]+\/status\/(\d+)/)?.[1];
      if (postId) return { source: 'x', postId };
    }
    return { source: 'article' };
  }

  function stamp(ms) {
    const seconds = Math.floor(ms / 1000);
    const s = String(seconds % 60).padStart(2, '0');
    const m = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
    const h = Math.floor(seconds / 3600);
    return h ? `${String(h).padStart(2, '0')}:${m}:${s}` : `${m}:${s}`;
  }

  function createContent({ source, url, title, language = '', transcriptKind = 'text', segments }) {
    if (!Array.isArray(segments)) throw new Error('内容片段格式无效');
    let previous = -1;
    const clean = segments.map((part) => {
      const startMs = Number(part.startMs);
      const endMs = Number(part.endMs);
      const text = String(part.text || '').replace(/\s+/g, ' ').trim();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs || startMs < previous) {
        throw new Error('字幕时间轴无效');
      }
      previous = startMs;
      return { startMs, endMs, text };
    }).filter((part) => part.text);
    if (!clean.length) throw new Error('没有可总结的文字或字幕');
    const timed = transcriptKind !== 'text';
    const text = clean.map((part) => timed ? `[${stamp(part.startMs)}] ${part.text}` : part.text).join('\n');
    if (text.length > MAX_TEXT) throw new Error('内容过长（超过 80000 字），请选较短的视频或帖子');
    return { source, url, title, language, transcriptKind, segments: clean, text };
  }

  function chunkText(text) {
    if (!text || !text.trim()) throw new Error('没有可总结的文字或字幕');
    if (text.length > MAX_TEXT) throw new Error('内容过长（超过 80000 字）');
    if (text.length <= CHUNK_SIZE) return [text];
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const chunks = [];
    let current = '';
    for (const line of lines) {
      if (current && current.length + line.length > CHUNK_SIZE) {
        chunks.push(current);
        current = '';
      }
      if (line.length > CHUNK_SIZE) {
        for (let i = 0; i < line.length; i += CHUNK_SIZE) {
          const slice = line.slice(i, i + CHUNK_SIZE);
          if (current && current.length + slice.length > CHUNK_SIZE) {
            chunks.push(current);
            current = '';
          }
          current += slice;
        }
      } else current += line;
    }
    if (current) chunks.push(current);
    if (chunks.length <= Math.ceil(text.length / CHUNK_SIZE)) return chunks;
    // Dense packing is necessary for many medium-length cues near the hard cap.
    const dense = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) dense.push(text.slice(i, i + CHUNK_SIZE));
    return dense;
  }

  globalThis.CONTENT = { detectSource, createContent, chunkText, MAX_TEXT, CHUNK_SIZE };
})();
