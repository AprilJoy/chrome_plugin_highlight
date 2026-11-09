// Extract only the current X/Twitter post, excluding replies and suggestions.
(function () {
  function postProbe(postId) {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const article = articles.find((node) => Array.from(node.querySelectorAll('a[href*="/status/"]')).some((link) => {
      try { return new URL(link.href).pathname.match(/\/status\/(\d+)/)?.[1] === postId && !!link.querySelector('time'); }
      catch (_) { return false; }
    })) || articles.find((node) => node.querySelector(`a[href*="/status/${postId}"]`));
    if (!article) return null;
    const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || '';
    const hasMedia = !!article.querySelector('video, [data-testid="videoPlayer"], [data-testid="tweetPhoto"]');
    return { text, title: text.slice(0, 100) || document.title, hasMedia };
  }

  async function extract(info, probe, apiKey = '') {
    const post = await probe(postProbe, info.postId);
    if (!post) throw new Error('无法读取当前 X 帖子，请确认已登录且帖子可访问');
    if (post.text?.trim()) {
      return globalThis.CONTENT.createContent({
        source: 'x', url: info.url, title: post.title || info.url,
        transcriptKind: 'text', segments: [{ startMs: 0, endMs: 0, text: post.text }],
      });
    }
    if (!post.hasMedia) throw new Error('当前 X 帖子没有可总结的正文');
    if (!apiKey || !globalThis.SUPADATA) throw new Error('纯视频 X 帖子需配置 Supadata API Key 才能读取已有字幕');
    const transcript = await globalThis.SUPADATA.fetchTranscript(info.url, apiKey);
    return globalThis.CONTENT.createContent({
      source: 'x', url: info.url, title: post.title || info.url,
      language: transcript.language, transcriptKind: 'caption', segments: transcript.segments,
    });
  }

  globalThis.XPOST = { postProbe, extract };
})();
