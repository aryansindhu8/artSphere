// ─── API calls to the Express backend ────────────────────────────────────────

// Track the latest search request so we can cancel earlier ones when the user
// clicks Prev/Next quickly. Stale responses arriving late won't overwrite the
// current view.
let activeSearchController = null;

async function searchArtworks(query, page = 1, source = 'both', hasImage = false) {
  // Cancel any previous in-flight search
  if (activeSearchController) activeSearchController.abort();
  activeSearchController = new AbortController();
  const signal = activeSearchController.signal;

  const params = new URLSearchParams({ q: query, page, source, hasImage });
  let res;
  try {
    res = await fetch(`/api/search?${params}`, { signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const aborted = new Error('Aborted');
      aborted.name = 'AbortError';
      throw aborted;
    }
    throw new Error('Network error. Please check your connection.');
  }

  // Try to surface the server's friendly message if there was an error
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const err = new Error((body && body.error) || 'Search failed');
    err.status = res.status;
    err.retryable = !!(body && body.retryable);
    throw err;
  }
  return body;
}

async function getArtworkDetail(source, id) {
  const res = await fetch(`/api/artwork/${source}/${id}`);
  if (!res.ok) throw new Error('Failed to fetch artwork');
  return res.json();
}

async function getArtistBio(name) {
  const res = await fetch(`/api/artist/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error('Failed to fetch biography');
  return res.json();
}

async function getRelatedWorks(name) {
  const res = await fetch(`/api/artist/${encodeURIComponent(name)}/works`);
  if (!res.ok) throw new Error('Failed to fetch related works');
  return res.json();
}