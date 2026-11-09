// Bilibili metadata and existing subtitles only. No media download or ASR.
(function () {
  const API = 'https://api.bilibili.com';

  function readVarint(bytes, cursor) {
    let value = 0;
    let shift = 0;
    while (cursor.index < bytes.length && shift <= 49) {
      const b = bytes[cursor.index++];
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
      shift += 7;
    }
    throw new Error('B站字幕元数据格式不受支持');
  }

  function decodeFields(bytes) {
    const fields = [];
    const cursor = { index: 0 };
    while (cursor.index < bytes.length) {
      const key = readVarint(bytes, cursor);
      const number = Math.floor(key / 8);
      const wire = key % 8;
      if (!number) throw new Error('B站字幕元数据格式不受支持');
      if (wire === 0) fields.push({ number, wire, value: readVarint(bytes, cursor) });
      else if (wire === 1 || wire === 5) {
        const len = wire === 1 ? 8 : 4;
        if (cursor.index + len > bytes.length) throw new Error('B站字幕元数据格式不受支持');
        cursor.index += len;
      } else if (wire === 2) {
        const len = readVarint(bytes, cursor);
        if (cursor.index + len > bytes.length) throw new Error('B站字幕元数据格式不受支持');
        fields.push({ number, wire, bytes: bytes.slice(cursor.index, cursor.index + len) });
        cursor.index += len;
      } else throw new Error('B站字幕元数据格式不受支持');
    }
    return fields;
  }

  function parseProtoTracks(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const data = decodeFields(bytes).find((field) => field.number === 1 && field.wire === 2)?.bytes;
    if (!data) {
      if (bytes.length) throw new Error('B站字幕元数据格式不受支持');
      return [];
    }
    const decoder = new TextDecoder();
    return decodeFields(data).filter((field) => field.number === 3 && field.wire === 2).map((field) => {
      const parts = decodeFields(field.bytes);
      const read = (number) => {
        const item = parts.find((part) => part.number === number && part.wire === 2);
        return item ? decoder.decode(item.bytes) : '';
      };
      return { lan: read(3), lan_doc: read(4), subtitle_url: read(5) };
    }).filter((track) => track.lan && track.subtitle_url);
  }

  function priority(track) {
    const lan = String(track.lan || '').toLowerCase();
    if (/^zh(?:$|-)/.test(lan)) return 0;
    if (/^ai-zh(?:$|-)/.test(lan)) return 1;
    return 2;
  }

  function validateSubtitleUrl(value) {
    let url;
    try { url = new URL(value.startsWith('//') ? `https:${value}` : value); }
    catch (_) { throw new Error('B站字幕地址无效'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'hdslb.com' || host.endsWith('.hdslb.com'))) {
      throw new Error('B站字幕地址不受信任');
    }
    return url.toString();
  }

  function checkApi(data, label) {
    if (!data || data.code !== 0 || !data.data) throw new Error(`${label}失败：${data?.message || '可能需要登录或触发平台限制'}`);
    return data.data;
  }

  async function extract(info, fetcher) {
    const viewUrl = new URL(`${API}/x/web-interface/view`);
    viewUrl.searchParams.set('bvid', info.bvid);
    const view = checkApi(await fetcher(viewUrl.toString(), 'json', { credentials: 'include' }), 'B站视频信息查询');
    const pages = view.pages || [];
    if (info.page < 1 || (pages.length && info.page > pages.length)) throw new Error('B站分 P 编号超出范围');
    const page = pages[info.page - 1] || {};
    const cid = page.cid || view.cid;
    if (!cid) throw new Error('B站视频缺少 cid');
    const playerUrl = new URL(`${API}/x/player/v2`);
    playerUrl.searchParams.set('bvid', info.bvid);
    playerUrl.searchParams.set('cid', String(cid));
    let tracks = [];
    let playerError;
    try {
      const player = checkApi(await fetcher(playerUrl.toString(), 'json', { credentials: 'include' }), 'B站字幕轨道查询');
      tracks = Array.isArray(player.subtitle?.subtitles) ? player.subtitle.subtitles : [];
    } catch (error) { playerError = error; }
    if (!tracks.some((track) => priority(track) < 2)) {
      const protoUrl = new URL(`${API}/x/v2/subtitle/web/view`);
      for (const [key, value] of Object.entries({
        oid: cid, pid: view.aid, context_ext: JSON.stringify({ video_type: 1 }),
        type: 1, cur_production_type: 0, preferred_language: 'ai-zh', playlist_switch: 0,
      })) protoUrl.searchParams.set(key, String(value));
      let fresh;
      try { fresh = parseProtoTracks(await fetcher(protoUrl.toString(), 'bytes', { credentials: 'include' })); }
      catch (error) { throw new Error(`B站字幕轨道查询失败：${playerError ? `${playerError.message}；` : ''}${error.message}`); }
      tracks = [...tracks, ...fresh];
    }
    const selected = [...tracks].filter((track) => track.subtitle_url).sort((a, b) => priority(a) - priority(b))[0];
    if (!selected) throw new Error(`${playerError ? `${playerError.message}；` : ''}当前 B站视频没有已有字幕，请确认播放器字幕菜单及登录状态`);
    const subtitleUrl = validateSubtitleUrl(selected.subtitle_url);
    const subtitle = await fetcher(subtitleUrl, 'json', { credentials: 'omit' });
    if (!Array.isArray(subtitle?.body) || !subtitle.body.length) throw new Error('B站字幕文件为空或格式不受支持');
    const segments = subtitle.body.map((part) => ({
      startMs: Number(part.from) * 1000,
      endMs: Number(part.to) * 1000,
      text: part.content || '',
    }));
    const title = pages.length > 1 && page.part ? `${view.title} - P${info.page} ${page.part}` : view.title || info.bvid;
    return globalThis.CONTENT.createContent({
      source: 'bilibili', url: info.url, title, language: selected.lan,
      transcriptKind: String(selected.lan).startsWith('ai-') ? 'ai' : 'manual', segments,
    });
  }

  globalThis.BILIBILI = { parseProtoTracks, validateSubtitleUrl, extract };
})();
