import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';

/** ISO-8601 duration (e.g. "PT3M42S") → seconds. */
function iso8601ToSec(iso?: string): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, h, mi, s] = m;
  return Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(s || 0);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#33;': '!',
};
function decodeHtml(s: string): string {
  return (s || '').replace(/&amp;|&#39;|&quot;|&lt;|&gt;|&#33;/g, (m) => ENTITIES[m] || m);
}

/**
 * GET /api/crm/youtube/search?q=...
 * Proxies YouTube Data API v3 so the API key never reaches the browser.
 * search.list (100 units) + one videos.list (1 unit) for durations.
 */
const search = asyncHandler(async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json(new ApiResponse(200, { results: [] }, 'Empty query'));

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new ApiError(500, 'YouTube API key is not configured on the server (set YOUTUBE_API_KEY).');

  // Bias toward embeddable music videos that are allowed to play OFF youtube.com
  // (videoSyndicated) — this removes most "can't be embedded" playback errors.
  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video` +
    `&videoEmbeddable=true&videoSyndicated=true&videoCategoryId=10&maxResults=15&q=${encodeURIComponent(q)}&key=${key}`;

  let sJson: any;
  try {
    const sRes = await fetch(searchUrl);
    sJson = await sRes.json();
  } catch {
    throw new ApiError(502, 'Could not reach YouTube.');
  }
  if (sJson.error) {
    // Quota exhaustion, key issues, etc.
    throw new ApiError(502, sJson.error?.message || 'YouTube search failed.');
  }

  const ids: string[] = (sJson.items || []).map((i: any) => i.id?.videoId).filter(Boolean);
  const durMap: Record<string, number> = {};
  if (ids.length) {
    try {
      const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.join(',')}&key=${key}`;
      const vRes = await fetch(vUrl);
      const vJson: any = await vRes.json();
      for (const v of vJson.items || []) durMap[v.id] = iso8601ToSec(v.contentDetails?.duration);
    } catch {
      /* durations are non-critical */
    }
  }

  const results = (sJson.items || [])
    .filter((i: any) => i.id?.videoId)
    .map((i: any) => ({
      videoId: i.id.videoId,
      title: decodeHtml(i.snippet?.title || ''),
      channel: decodeHtml(i.snippet?.channelTitle || ''),
      thumbnail: i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url || '',
      durationSec: durMap[i.id.videoId] || 0,
    }));

  res.json(new ApiResponse(200, { results }, 'ok'));
});

export default { search };