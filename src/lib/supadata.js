// Optional native-caption fallback; never asks Supadata to generate audio transcripts.
(function () {
  async function fetchTranscript(url, apiKey, fetcher = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    if (!apiKey) throw new Error('未配置 Supadata API Key');
    const requestUrl = new URL('https://api.supadata.ai/v1/transcript');
    requestUrl.searchParams.set('url', url);
    requestUrl.searchParams.set('mode', 'native');
    const options = { headers: { 'x-api-key': apiKey } };
    let response = await fetcher(requestUrl.toString(), options);
    if (!response.ok) throw new Error(`Supadata 字幕请求失败 (${response.status})`);
    let payload = await response.json();
    if (response.status === 202 || payload.jobId) {
      const jobId = String(payload.jobId || '');
      if (!/^[\w-]{1,100}$/.test(jobId)) throw new Error('Supadata 返回无效任务编号');
      let finished = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(1000);
        response = await fetcher(`https://api.supadata.ai/v1/transcript/${jobId}`, options);
        if (!response.ok) throw new Error(`Supadata 字幕任务失败 (${response.status})`);
        payload = await response.json();
        if (payload.status === 'failed') throw new Error('Supadata 无法取得已有字幕');
        if (payload.status === 'completed' || (response.status === 200 && Array.isArray(payload.content))) { finished = true; break; }
      }
      if (!finished) throw new Error('Supadata 字幕任务超时');
    }
    if (!Array.isArray(payload.content) || !payload.content.length) throw new Error('Supadata 没有返回已有字幕');
    const segments = payload.content.map((part, index, all) => {
      const startMs = Number(part.offset);
      const duration = Number(part.duration);
      const nextOffset = Number(all[index + 1]?.offset);
      const endMs = Number.isFinite(duration) && duration > 0 ? startMs + duration : Number.isFinite(nextOffset) ? nextOffset : startMs;
      return { startMs, endMs, text: part.text || '' };
    });
    return { language: payload.lang || '', segments };
  }

  globalThis.SUPADATA = { fetchTranscript };
})();
