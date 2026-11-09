// YouTube caption extraction. The page probe runs in MAIN world to read the live player.
(function () {
  function playerProbe() {
    const players = [document.querySelector('#movie_player'), document.querySelector('#shorts-player')];
    for (const element of players) {
      const player = element?.getPlayerResponse ? element : element?.querySelector?.('#movie_player');
      if (!player?.getPlayerResponse) continue;
      let response = player.getPlayerResponse();
      if (typeof response === 'string') {
        try { response = JSON.parse(response); } catch (_) { continue; }
      }
      const videoId = response?.videoDetails?.videoId;
      const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (videoId) return { videoId, title: response.videoDetails?.title || document.title, tracks };
    }
    return null;
  }

  function validateCaptionUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('YouTube 字幕地址无效'); }
    if (url.protocol !== 'https:' || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) || url.pathname !== '/api/timedtext') {
      throw new Error('YouTube 字幕地址不受信任');
    }
    url.searchParams.set('fmt', 'json3');
    return url.toString();
  }

  function parseJson3(data) {
    if (!Array.isArray(data?.events)) throw new Error('YouTube 字幕格式不受支持');
    return data.events.map((event) => ({
      startMs: Number(event.tStartMs),
      endMs: Number(event.tStartMs) + Number(event.dDurationMs || 0),
      text: Array.isArray(event.segs) ? event.segs.map((seg) => seg.utf8 || '').join('').replace(/\n/g, ' ') : '',
    })).filter((item) => item.text.trim());
  }

  async function extract(info, probe, fetchJson, apiKey = '') {
    let player;
    for (let attempt = 0; attempt < 2; attempt++) {
      player = await probe(playerProbe);
      if (player?.videoId === info.videoId) break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (player?.videoId !== info.videoId) {
      if (apiKey && globalThis.SUPADATA) return fromSupadata(info, apiKey);
      throw new Error(player?.videoId ? 'YouTube 播放器与当前视频不一致，请稍后重试' : '无法读取当前 YouTube 播放器字幕');
    }
    const tracks = player.tracks || [];
    const sorted = [...tracks].sort((a, b) => (a.kind === 'asr') - (b.kind === 'asr'));
    for (const track of sorted) {
      let segments;
      try {
        const captionUrl = validateCaptionUrl(track.baseUrl);
        const payload = await fetchJson(captionUrl);
        segments = parseJson3(payload);
      } catch (_) {
        // Another available caption track may still work.
        continue;
      }
      if (segments.length) {
        return globalThis.CONTENT.createContent({
          source: 'youtube', url: info.url, title: player.title || info.url,
          language: track.languageCode || '', transcriptKind: track.kind === 'asr' ? 'ai' : 'manual', segments,
        });
      }
    }
    if (apiKey && globalThis.SUPADATA) return fromSupadata(info, apiKey, player.title);
    throw new Error('当前 YouTube 视频没有可读取的字幕');
  }

  async function fromSupadata(info, apiKey, title = '') {
    const transcript = await globalThis.SUPADATA.fetchTranscript(info.url, apiKey);
    return globalThis.CONTENT.createContent({
      source: 'youtube', url: info.url, title: title || info.title || info.url,
      language: transcript.language, transcriptKind: 'caption', segments: transcript.segments,
    });
  }

  globalThis.YOUTUBE = { playerProbe, validateCaptionUrl, parseJson3, extract };
})();
