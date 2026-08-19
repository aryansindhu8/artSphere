const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const HARVARD_API_KEY = process.env.HARVARD_API_KEY;

app.use(express.static(path.join(__dirname, 'public')));

// ─── Fetch Helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Fetches a URL and parses JSON robustly.
 *  - Reads the body as text first so we can detect HTML / rate-limit pages.
 *  - Retries on 429/5xx and on non-JSON responses with exponential backoff.
 *  - Throws a tagged error so callers can return a friendly status code.
 */
async function safeFetchJson(url, opts = {}, { retries = 2, backoffMs = 600, timeoutMs = 10000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const text = await res.text();

      // Detect rate-limit / CDN HTML pages
      const looksLikeHtml = /^\s*</.test(text);
      const isRateLimited = res.status === 429 || res.status === 503 || res.status === 502;

      if (!res.ok || looksLikeHtml) {
        if (attempt < retries && (isRateLimited || looksLikeHtml)) {
          await sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
        const err = new Error(`Upstream returned ${res.status}${looksLikeHtml ? ' (HTML)' : ''}`);
        err.status = isRateLimited || looksLikeHtml ? 503 : res.status;
        err.upstreamUrl = url;
        throw err;
      }

      try {
        return JSON.parse(text);
      } catch (parseErr) {
        if (attempt < retries) {
          await sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
        const err = new Error('Upstream returned invalid JSON');
        err.status = 502;
        err.upstreamUrl = url;
        throw err;
      }
    } catch (e) {
      if (e.status) throw e;
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }
      const err = new Error(`Network error: ${e.message}`);
      err.status = 503;
      err.upstreamUrl = url;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Simple TTL cache (in-memory) ────────────────────────────────────────────

const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}
function cacheSet(key, value, ttlMs = 5 * 60 * 1000) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

/**
 * Run async tasks in small concurrent batches rather than all at once.
 * Helps avoid tripping the Met CDN's rate limiter on a burst of 10 parallel
 * /objects/{id} calls per page change.
 */
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Normalize Helpers ───────────────────────────────────────────────────────

function normalizeMet(obj) {
  return {
    id: String(obj.objectID),
    source: 'met',
    title: obj.title || 'Untitled',
    artist: obj.artistDisplayName || 'Unknown Artist',
    date: obj.objectDate || '',
    medium: obj.medium || '',
    dimensions: obj.dimensions || '',
    department: obj.department || '',
    imageUrl: obj.primaryImageSmall || obj.primaryImage || null,
    museum: 'The Metropolitan Museum of Art',
    objectUrl: obj.objectURL || `https://www.metmuseum.org/art/collection/search/${obj.objectID}`
  };
}

function normalizeHarvard(obj) {
  const person = obj.people && obj.people[0];
  const image = obj.images && obj.images[0];
  return {
    id: String(obj.objectid),
    source: 'harvard',
    title: obj.title || 'Untitled',
    artist: person ? person.displayname : 'Unknown Artist',
    date: obj.dated || '',
    medium: obj.technique || obj.medium || '',
    dimensions: obj.dimensions || '',
    department: obj.department || obj.classification || '',
    imageUrl: image ? image.baseimageurl : null,
    museum: 'Harvard Art Museums',
    objectUrl: obj.url || `https://harvardartmuseums.org/collections/object/${obj.objectid}`
  };
}

// ─── Route: Search ───────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  try {
    const { q, page = 1, source = 'both', hasImage } = req.query;
    if (!q) return res.status(400).json({ error: 'Query is required' });

    const pageNum = parseInt(page);
    const pageSize = 16;

    // When both museums are selected, split the page in half so the combined
    // result set never exceeds pageSize. When only one source is selected, that
    // source gets the full page size.
    const isBoth = source === 'both';
    const metPageSize = isBoth ? Math.ceil(pageSize / 2) : pageSize;          // 8 if both, else 16
    const harvardPageSize = isBoth ? Math.floor(pageSize / 2) : pageSize;     // 8 if both, else 16

    let results = [];
    let metTotal = 0;
    let harvardTotal = 0;

    // Track what we tried vs. what actually succeeded — so we can tell the
    // difference between "the API has nothing" and "the API is rate-limiting us".
    let attemptedItems = 0;
    let failedItems = 0;
    let upstreamErrored = false;

    // ── Met Museum ──
    if (source === 'met' || source === 'both') {
      const wantsImage = hasImage === 'true';

      // Cache the full ID list per query — avoids hammering the search endpoint on each page change.
      // The cache key includes hasImage so the Met-side pre-filter is honored consistently.
      const metCacheKey = `met:search:${q}:hasImage=${wantsImage}`;
      let allIds = cacheGet(metCacheKey);
      if (!allIds) {
        const metHasImageParam = wantsImage ? '&hasImages=true' : '';
        const metSearchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?q=${encodeURIComponent(q)}${metHasImageParam}`;
        const metSearchData = await safeFetchJson(metSearchUrl);
        allIds = metSearchData.objectIDs || [];
        cacheSet(metCacheKey, allIds);
      }

      // Helper: fetch a single object, with cache + concurrency controls.
      const fetchMetObject = async (id) => {
        const objKey = `met:obj:${id}`;
        const cached = cacheGet(objKey);
        if (cached) return cached;
        try {
          const obj = await safeFetchJson(
            `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
            {},
            { retries: 2, backoffMs: 500 }
          );
          cacheSet(objKey, obj, 30 * 60 * 1000); // 30 min for individual objects
          return obj;
        } catch (e) {
          failedItems++;
          if (e.status === 503 || e.status === 502) upstreamErrored = true;
          return null;
        }
      };

      // When the user wants images only, the Met API's hasImages=true filter is mostly
      // reliable but not perfect — some returned IDs still resolve to objects without a
      // primaryImage. Over-fetch IDs (1.5x) so we can keep filling the page after filtering.
      const start = (pageNum - 1) * metPageSize;
      const overFetchSize = wantsImage ? Math.ceil(metPageSize * 1.5) : metPageSize;
      const pageIds = allIds.slice(start, start + overFetchSize);
      attemptedItems += pageIds.length;

      const metObjects = await mapWithConcurrency(pageIds, 4, fetchMetObject);

      const metResults = metObjects
        .filter(obj => obj && obj.objectID)
        .map(normalizeMet)
        // Post-filter using the normalized imageUrl (covers both primaryImageSmall
        // and primaryImage), then slice down to the desired page size.
        .filter(item => !wantsImage || item.imageUrl)
        .slice(0, metPageSize);

      results = results.concat(metResults);
      metTotal = allIds.length;
    }

    // ── Harvard ──
    if (source === 'harvard' || source === 'both') {
      try {
        const harvardUrl = `https://api.harvardartmuseums.org/object?keyword=${encodeURIComponent(q)}&apikey=${HARVARD_API_KEY}&size=${harvardPageSize}&page=${pageNum}${hasImage === 'true' ? '&hasimage=1' : ''}`;
        const harvardData = await safeFetchJson(harvardUrl);
        const harvardResults = (harvardData.records || []).map(normalizeHarvard);

        results = results.concat(harvardResults);
        harvardTotal = harvardData.info ? harvardData.info.totalrecords : 0;
      } catch (e) {
        if (e.status === 503 || e.status === 502) upstreamErrored = true;
        // If Met succeeded, we can still return its results; otherwise fall through to the error path below.
      }
    }

    const total = metTotal + harvardTotal;

    // If we attempted to load N items but got back nothing AND upstream errors
    // happened, surface a real 503 so the client can show a retry button — instead
    // of falsely telling the user "No artworks found".
    if (attemptedItems > 0 && results.length === 0 && upstreamErrored) {
      const err = new Error('All upstream item fetches failed (likely rate-limited)');
      err.status = 503;
      throw err;
    }

    // Total pages: when each source paginates independently with its own page size,
    // the number of usable pages is the max of the two. (After one source runs out,
    // the other still has pages to show.)
    const metPagesUsed = metTotal && (source === 'met' || source === 'both')
      ? Math.ceil(metTotal / metPageSize) : 0;
    const harvardPagesUsed = harvardTotal && (source === 'harvard' || source === 'both')
      ? Math.ceil(harvardTotal / harvardPageSize) : 0;
    const totalPages = Math.max(metPagesUsed, harvardPagesUsed, 1);

    res.json({ results, total, page: pageNum, totalPages });
  } catch (err) {
    console.error('Search error:', err.message || err);
    const status = err.status || 500;
    const message = status === 503
      ? 'The museum API is temporarily unavailable or rate-limiting us. Please wait a few seconds and try again.'
      : 'Search failed';
    res.status(status).json({ error: message, retryable: status === 503 });
  }
});

// ─── Route: Artwork Detail ────────────────────────────────────────────────────

app.get('/api/artwork/:source/:id', async (req, res) => {
  try {
    const { source, id } = req.params;

    if (source === 'met') {
      const objKey = `met:obj:${id}`;
      let obj = cacheGet(objKey);
      if (!obj) {
        obj = await safeFetchJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
        cacheSet(objKey, obj, 30 * 60 * 1000);
      }
      return res.json(normalizeMet(obj));
    }

    if (source === 'harvard') {
      const obj = await safeFetchJson(`https://api.harvardartmuseums.org/object/${id}?apikey=${HARVARD_API_KEY}`);
      return res.json(normalizeHarvard(obj));
    }

    res.status(400).json({ error: 'Invalid source' });
  } catch (err) {
    console.error('Artwork detail error:', err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: status === 503 ? 'The museum API is temporarily unavailable. Please try again.' : 'Failed to fetch artwork' });
  }
});

// ─── Route: Artist Biography (Wikipedia) ─────────────────────────────────────

app.get('/api/artist/:name', async (req, res) => {
  try {
    const name = encodeURIComponent(req.params.name);
    const cacheKey = `wiki:${name}`;
    let wikiData = cacheGet(cacheKey);
    if (!wikiData) {
      wikiData = await safeFetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${name}`);
      cacheSet(cacheKey, wikiData, 60 * 60 * 1000);
    }
    res.json({
      extract: wikiData.extract || 'No biography available.',
      thumbnail: wikiData.thumbnail ? wikiData.thumbnail.source : null,
      content_urls: wikiData.content_urls || null
    });
  } catch (err) {
    console.error('Artist bio error:', err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: 'Failed to fetch biography' });
  }
});

// ─── Route: Related Works by Artist ──────────────────────────────────────────

app.get('/api/artist/:name/works', async (req, res) => {
  try {
    const artistName = req.params.name;
    let results = [];

    // Met — reuse cached search IDs if we already fetched them
    try {
      const metCacheKey = `met:search:${artistName}:hasImage=true`;
      let allIds = cacheGet(metCacheKey);
      if (!allIds) {
        const metSearchData = await safeFetchJson(`https://collectionapi.metmuseum.org/public/collection/v1/search?q=${encodeURIComponent(artistName)}&hasImages=true`);
        allIds = metSearchData.objectIDs || [];
        cacheSet(metCacheKey, allIds);
      }
      // Fetch a wider buffer (12) so that after the client filters out the
      // currently-viewed artwork and any items without images, we still have
      // at least 8 to display.
      const ids = allIds.slice(0, 12);
      const metObjects = await mapWithConcurrency(ids, 3, async (id) => {
        const objKey = `met:obj:${id}`;
        const cached = cacheGet(objKey);
        if (cached) return cached;
        try {
          const obj = await safeFetchJson(
            `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
            {},
            { retries: 1, backoffMs: 400 }
          );
          cacheSet(objKey, obj, 30 * 60 * 1000);
          return obj;
        } catch {
          return null;
        }
      });
      results = results.concat(metObjects.filter(o => o && o.objectID).map(normalizeMet));
    } catch (metErr) {
      // Don't fail the whole endpoint if Met is rate-limited — just skip it
      console.warn('Met related works skipped:', metErr.message);
    }

    // Harvard
    try {
      const harvardData = await safeFetchJson(`https://api.harvardartmuseums.org/object?keyword=${encodeURIComponent(artistName)}&apikey=${HARVARD_API_KEY}&size=12`);
      results = results.concat((harvardData.records || []).map(normalizeHarvard));
    } catch (harvardErr) {
      console.warn('Harvard related works skipped:', harvardErr.message);
    }

    res.json({ results });
  } catch (err) {
    console.error('Related works error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch related works' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));