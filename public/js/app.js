// ─── State ────────────────────────────────────────────────────────────────────

let currentPage = 1;
let currentQuery = '';
let currentSource = 'both';
let currentHasImage = false;
let totalPages = 1;
let currentArtwork = null;

// ─── View Switching ───────────────────────────────────────────────────────────

function showView(view) {
  const views = {
    search: document.getElementById('search-view'),
    detail: document.getElementById('detail-view'),
    favorites: document.getElementById('favorites-view')
  };

  // Hide all views and clear any animation classes from a previous transition.
  Object.values(views).forEach(el => {
    el.style.display = 'none';
    el.classList.remove('view-fade-in');
  });

  // Show the selected view.
  const target = views[view];
  if (target) {
    target.style.display = '';
    // Force a reflow so the browser registers the display change before we
    // add the animation class — without this, the keyframes wouldn't replay
    // when navigating back to a view we've already shown before.
    void target.offsetWidth;
    target.classList.add('view-fade-in');
    // Scroll back to the top of the page so the user always lands on the
    // header of the new view, not somewhere mid-scroll from the previous one.
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // Update navbar active tab — when in detail view, neither tab is active.
  const navSearch = document.getElementById('nav-search');
  const navFavorites = document.getElementById('nav-favorites');
  navSearch.classList.toggle('active', view === 'search');
  navFavorites.classList.toggle('active', view === 'favorites');
}

// ─── Favorites Count Badge ────────────────────────────────────────────────────

function updateFavoritesBadge() {
  const count = getFavorites().length;
  const badge = document.getElementById('favorites-badge');
  badge.textContent = count;
  badge.classList.toggle('d-none', count === 0);
}

// ─── Image Helpers ────────────────────────────────────────────────────────────

function renderCardImage(artwork) {
  if (artwork.imageUrl) {
    return `
      <div class="card-img-wrapper">
        <img
          src="${artwork.imageUrl}"
          class="card-img-top"
          alt="${artwork.title}"
          onerror="this.parentElement.innerHTML='<div class=&quot;no-image-placeholder&quot;>No Image Available</div>'"
        >
      </div>
    `;
  }
  return `
    <div class="card-img-wrapper">
      <div class="no-image-placeholder">No Image Available</div>
    </div>
  `;
}

// ─── Skeleton Loaders ─────────────────────────────────────────────────────────

function showSkeletons(count = 16) {
  const grid = document.getElementById('results-grid');
  // Match the real card layout: 280px image area, then a card body with
  // a 2-line title, artist line, and date line — same heights as the
  // populated card so the layout doesn't jump when results arrive.
  grid.innerHTML = Array(count).fill(`
    <div class="col">
      <div class="card h-100 skeleton-card">
        <div class="skeleton skeleton-img"></div>
        <div class="card-body">
          <div class="skeleton skeleton-line skeleton-line--title mb-2"></div>
          <div class="skeleton skeleton-line skeleton-line--title-2 mb-3"></div>
          <div class="skeleton skeleton-line skeleton-line--artist mb-2"></div>
          <div class="skeleton skeleton-line skeleton-line--date"></div>
        </div>
      </div>
    </div>
  `).join('');
}

// ─── Render Results ───────────────────────────────────────────────────────────

function renderResults(data) {
  const grid = document.getElementById('results-grid');
  grid.innerHTML = '';

  const resultsCount = document.getElementById('results-count');

  if (data.results.length === 0) {
    // Hide results count and pagination
    resultsCount.textContent = '';
    resultsCount.style.display = 'none';
    const pagination = document.getElementById('pagination');
    pagination.classList.add('d-none');
    pagination.classList.remove('d-flex');

    // Show centered empty state with palette emoji
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎨</div>
        <p class="empty-state-text">No artworks found. Try a different search term.</p>
      </div>
    `;
    return;
  }

  // Show results count for non-empty results
  resultsCount.style.display = '';
  resultsCount.textContent = `${data.total} results found`;

  data.results.forEach(artwork => {
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `
      <div class="card h-100 position-relative">
        <span class="source-badge badge-${artwork.source}">
          ${artwork.source.toUpperCase()}
        </span>
        ${renderCardImage(artwork)}
        <div class="card-body">
          <h6 class="card-title">${artwork.title}</h6>
          <p class="card-text text-muted">${artwork.artist}</p>
          <p class="card-text"><small class="text-muted">${artwork.date}</small></p>
        </div>
      </div>
    `;
    col.addEventListener('click', () => openDetail(artwork.source, artwork.id, artwork));
    grid.appendChild(col);
  });

  // Show pagination
  const pagination = document.getElementById('pagination');
  pagination.classList.remove('d-none');
  pagination.classList.add('d-flex');
  updatePagination(data.page, data.totalPages);
  totalPages = data.totalPages;
  currentPage = data.page;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function updatePagination(page, total) {
  document.getElementById('page-indicator').textContent = `Page ${page} of ${total}`;
  const prev = document.getElementById('prev-btn');
  const next = document.getElementById('next-btn');
  prev.disabled = page <= 1;
  next.disabled = page >= total;
  prev.classList.toggle('disabled', page <= 1);
  next.classList.toggle('disabled', page >= total);
}

// ─── Search ───────────────────────────────────────────────────────────────────

async function performSearch(page = 1) {
  const query = document.getElementById('search-input').value.trim();

  if (!query) {
    document.getElementById('search-error').style.display = '';
    return;
  }
  document.getElementById('search-error').style.display = 'none';

  currentQuery = query;
  currentSource = document.getElementById('source-filter').value;
  currentHasImage = document.getElementById('has-image-filter').checked;
  currentPage = page;

  showSkeletons();

  try {
    const data = await searchArtworks(currentQuery, currentPage, currentSource, currentHasImage);
    renderResults(data);
  } catch (err) {
    // Aborted requests happen when the user clicks Next/Prev rapidly — just bail.
    if (err && err.name === 'AbortError') return;

    document.getElementById('results-count').style.display = 'none';
    const pagination = document.getElementById('pagination');
    pagination.classList.add('d-none');
    pagination.classList.remove('d-flex');

    const message = (err && err.message) || 'Something went wrong. Please try again.';
    const retryHtml = err && err.retryable
      ? '<button class="btn btn-primary mt-3" id="retry-search-btn">Retry</button>'
      : '';

    document.getElementById('results-grid').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <p class="empty-state-text">${message}</p>
        ${retryHtml}
      </div>
    `;

    const retryBtn = document.getElementById('retry-search-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => performSearch(currentPage));
    }
  }
}

// ─── Detail View ──────────────────────────────────────────────────────────────

// Each openDetail call gets a unique id. If a later call comes in before this
// one's network request completes, the older response is dropped — preventing
// stale title/artist/tabs from flashing in.
let detailRequestId = 0;

/**
 * Replace a tab element with a fresh clone to drop ALL previously-attached
 * `shown.bs.tab` listeners. Without this, multiple openDetail calls leave
 * stale handlers attached, which is why bio / related / map sometimes
 * showed data from an earlier artwork.
 */
function resetTabListeners(href) {
  const el = document.querySelector(`[href="${href}"]`);
  if (!el) return el;
  const fresh = el.cloneNode(true);
  el.parentNode.replaceChild(fresh, el);
  return fresh;
}

async function openDetail(source, id, partialArtwork = null) {
  const myRequestId = ++detailRequestId;
  showView('detail');

  // ── Immediate loading state ──
  // Show "Loading..." for the main title and clear all overview fields so the
  // user never sees a flash of the previously-opened artwork.
  document.getElementById('detail-title').textContent = 'Loading...';
  document.getElementById('detail-artist').textContent =
    partialArtwork && partialArtwork.artist ? partialArtwork.artist : '';
  document.getElementById('detail-date').textContent = '';
  document.getElementById('detail-medium').textContent = '';
  document.getElementById('detail-dimensions').textContent = '';
  document.getElementById('detail-department').textContent = '';
  document.getElementById('detail-museum').textContent = '';
  document.getElementById('detail-museum-link').style.display = 'none';

  // Image area — show what we already know from the search result, or a
  // title placeholder while we wait for the full artwork details.
  const detailImg = document.getElementById('detail-image');
  const detailImgWrapper = document.getElementById('detail-image-wrapper');
  detailImgWrapper.classList.remove('detail-image-wrapper--no-image');
  detailImgWrapper.querySelector('.detail-title-placeholder')?.remove();

  const renderTitlePlaceholderText = (text) => {
    detailImg.style.display = 'none';
    detailImgWrapper.classList.add('detail-image-wrapper--no-image');
    if (!detailImgWrapper.querySelector('.detail-title-placeholder')) {
      const placeholder = document.createElement('div');
      placeholder.className = 'detail-title-placeholder';
      placeholder.textContent = text;
      detailImgWrapper.appendChild(placeholder);
    }
  };

  if (partialArtwork && partialArtwork.imageUrl) {
    detailImg.src = partialArtwork.imageUrl;
    detailImg.alt = partialArtwork.title || '';
    detailImg.style.display = '';
    detailImg.onerror = () => renderTitlePlaceholderText(partialArtwork.title || 'Untitled');
  } else if (partialArtwork && partialArtwork.title) {
    renderTitlePlaceholderText(partialArtwork.title);
  } else {
    detailImg.style.display = 'none';
    detailImg.removeAttribute('src');
  }

  // Update the Add/Remove from Favorites button based on whether this artwork
  // (identified by source + id) is already saved. We can do this immediately
  // — no need to wait for the full artwork response — so the button shows the
  // correct state during loading instead of always saying "Add to Favorites".
  const favStub = (partialArtwork && partialArtwork.title)
    ? partialArtwork
    : { id, source, title: '', artist: '', imageUrl: null };
  updateFavBtn(favStub);
  document.getElementById('fav-btn').onclick = () => toggleFavorite(favStub);

  // Reset tabs back to Overview AND wipe any handlers from a previous
  // openDetail call so they can't fire on this artwork's tab clicks.
  const bioTab = resetTabListeners('#tab-biography');
  const relatedTab = resetTabListeners('#tab-related');
  const mapTab = resetTabListeners('#tab-map');
  const firstTab = document.querySelector('#detail-tabs .nav-link');
  if (firstTab) {
    new bootstrap.Tab(firstTab).show();
  }

  // Clear tab content
  document.getElementById('bio-content').innerHTML = '<div class="text-muted">Loading biography...</div>';
  document.getElementById('related-content').innerHTML = '<div class="text-muted">Loading related works...</div>';

  try {
    const artwork = await getArtworkDetail(source, id);

    // If a newer openDetail was called while we were waiting, drop this response.
    if (myRequestId !== detailRequestId) return;

    currentArtwork = artwork;

    // ── Update image with the full artwork (in case partial didn't have one) ──
    detailImgWrapper.classList.remove('detail-image-wrapper--no-image');
    detailImgWrapper.querySelector('.detail-title-placeholder')?.remove();

    const renderTitlePlaceholder = () => {
      detailImg.style.display = 'none';
      detailImgWrapper.classList.add('detail-image-wrapper--no-image');
      if (!detailImgWrapper.querySelector('.detail-title-placeholder')) {
        const placeholder = document.createElement('div');
        placeholder.className = 'detail-title-placeholder';
        placeholder.textContent = artwork.title || 'Untitled';
        detailImgWrapper.appendChild(placeholder);
      }
    };

    if (artwork.imageUrl) {
      detailImg.src = artwork.imageUrl;
      detailImg.alt = artwork.title;
      detailImg.style.display = '';
      detailImg.onerror = () => renderTitlePlaceholder();
    } else {
      renderTitlePlaceholder();
    }

    // ── Title and artist on the right column ──
    document.getElementById('detail-title').textContent = artwork.title;
    document.getElementById('detail-artist').textContent = artwork.artist;

    // ── Overview tab fields ──
    document.getElementById('detail-date').textContent = artwork.date || '—';
    document.getElementById('detail-medium').textContent = artwork.medium || '—';
    document.getElementById('detail-dimensions').textContent = artwork.dimensions || '—';
    document.getElementById('detail-department').textContent = artwork.department || '—';
    document.getElementById('detail-museum').textContent = artwork.museum;

    const museumLink = document.getElementById('detail-museum-link');
    if (artwork.objectUrl) {
      museumLink.href = artwork.objectUrl;
      museumLink.style.display = '';
    } else {
      museumLink.style.display = 'none';
    }

    // ── Favorites button ──
    updateFavBtn(artwork);
    document.getElementById('fav-btn').onclick = () => toggleFavorite(artwork);

    // ── Biography Tab — load when tab is clicked.
    //    Uses the freshly-cloned bioTab from the top of openDetail, so any
    //    handlers from a previous artwork have already been wiped out.
    const bioHandler = async () => {
      // Bail if user navigated to another artwork while we were waiting.
      if (myRequestId !== detailRequestId) return;
      try {
        const bio = await getArtistBio(artwork.artist);
        if (myRequestId !== detailRequestId) return;
        const wikiUrl = bio.content_urls && bio.content_urls.desktop ? bio.content_urls.desktop.page : null;
        document.getElementById('bio-content').innerHTML = `
          <div class="bio-header d-flex align-items-start gap-3 mb-3">
            ${bio.thumbnail ? `<img src="${bio.thumbnail}" alt="${artwork.artist}" class="bio-thumbnail">` : ''}
            <div>
              <h4 class="mb-2">${artwork.artist}</h4>
              ${wikiUrl ? `<a href="${wikiUrl}" target="_blank" rel="noopener" class="btn btn-outline-secondary btn-sm">View on Wikipedia</a>` : ''}
            </div>
          </div>
          <p class="bio-extract">${bio.extract}</p>
        `;
      } catch {
        if (myRequestId !== detailRequestId) return;
        document.getElementById('bio-content').innerHTML =
          '<p class="text-muted">No biography available.</p>';
      }
      bioTab.removeEventListener('shown.bs.tab', bioHandler);
    };
    bioTab.addEventListener('shown.bs.tab', bioHandler);

    // ── Related Works Tab ──
    const relatedHandler = async () => {
      if (myRequestId !== detailRequestId) return;
      try {
        const data = await getRelatedWorks(artwork.artist);
        if (myRequestId !== detailRequestId) return;
        const relatedItems = data.results
          .filter(w => w.imageUrl)
          // Don't include the artwork the user is currently viewing.
          .filter(w => !(w.source === artwork.source && String(w.id) === String(artwork.id)))
          .slice(0, 8);
        if (relatedItems.length === 0) {
          document.getElementById('related-content').innerHTML =
            '<p class="text-muted">No related works found.</p>';
        } else {
          document.getElementById('related-content').innerHTML = `
            <div class="row row-cols-4 g-2 g-md-3">
              ${relatedItems.map(w => `
                <div class="col">
                  <div
                    class="related-thumb"
                    role="button"
                    tabindex="0"
                    data-source="${w.source}"
                    data-id="${w.id}"
                    data-title="${(w.title || '').replace(/"/g, '&quot;')}"
                    data-image-url="${(w.imageUrl || '').replace(/"/g, '&quot;')}"
                    data-artist="${(w.artist || '').replace(/"/g, '&quot;')}"
                    title="${(w.title || '').replace(/"/g, '&quot;')}"
                  >
                    <img src="${w.imageUrl}" alt="${w.title}">
                  </div>
                </div>
              `).join('')}
            </div>
          `;
          // Native browser tooltip (via the `title` attribute on each thumb)
          // — it follows the cursor position instead of anchoring to the
          // element, matches the macOS system style (light gray, black text,
          // no arrow), and has a built-in hover delay before showing.
          // No JS init needed.
          const thumbs = document.querySelectorAll('#related-content .related-thumb');
          thumbs.forEach(el => {
            const partial = {
              title: el.dataset.title,
              imageUrl: el.dataset.imageUrl,
              artist: el.dataset.artist || artwork.artist
            };
            el.addEventListener('click', () => {
              openDetail(el.dataset.source, el.dataset.id, partial);
            });
            el.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openDetail(el.dataset.source, el.dataset.id, partial);
              }
            });
          });
        }
      } catch {
        if (myRequestId !== detailRequestId) return;
        document.getElementById('related-content').innerHTML =
          '<p class="text-muted">Could not load related works.</p>';
      }
      relatedTab.removeEventListener('shown.bs.tab', relatedHandler);
    };
    relatedTab.addEventListener('shown.bs.tab', relatedHandler);

    // ── Map Tab — initialize Leaflet when tab is clicked ──
    const mapHandler = () => {
      if (myRequestId !== detailRequestId) return;
      document.getElementById('map-museum-name').textContent = artwork.museum;
      document.getElementById('map-museum-address').textContent = getMuseumAddress(artwork.museum);
      initMap(artwork.museum);
      setTimeout(() => mapInstance && mapInstance.invalidateSize(), 200);
      mapTab.removeEventListener('shown.bs.tab', mapHandler);
    };
    mapTab.addEventListener('shown.bs.tab', mapHandler);

  } catch (err) {
    console.error('Detail error:', err);
  }
}

// ─── Favorites Helpers ────────────────────────────────────────────────────────

function updateFavBtn(artwork) {
  const btn = document.getElementById('fav-btn');
  const icon = btn.querySelector('.fav-btn-icon');
  const text = btn.querySelector('.fav-btn-text');
  if (isFavorite(artwork.id, artwork.source)) {
    btn.classList.add('fav-btn--active');
    icon.className = 'fav-btn-icon fa-solid fa-heart';
    text.textContent = 'Remove from Favorites';
  } else {
    btn.classList.remove('fav-btn--active');
    icon.className = 'fav-btn-icon fa-regular fa-heart';
    text.textContent = 'Add to Favorites';
  }
}

function toggleFavorite(artwork) {
  if (isFavorite(artwork.id, artwork.source)) {
    removeFavorite(artwork.id, artwork.source);
  } else {
    addFavorite(artwork);
  }
  updateFavBtn(artwork);
  updateFavoritesBadge();
}

// ─── Render Favorites View ────────────────────────────────────────────────────

function renderFavorites() {
  updateFavoritesBadge();
  const favs = getFavorites();
  const grid = document.getElementById('favorites-grid');
  const msg = document.getElementById('no-favorites-msg');

  if (favs.length === 0) {
    grid.innerHTML = '';
    msg.style.display = '';
    return;
  }

  msg.style.display = 'none';
  grid.innerHTML = favs.map(artwork => `
    <div class="col">
      <div class="card h-100 position-relative favorite-card" data-source="${artwork.source}" data-id="${artwork.id}">
        <span class="source-badge badge-${artwork.source}">
          ${artwork.source.toUpperCase()}
        </span>
        <button
          type="button"
          class="favorite-remove-btn"
          aria-label="Remove from favorites"
          data-source="${artwork.source}"
          data-id="${artwork.id}"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
        ${renderCardImage(artwork)}
        <div class="card-body">
          <h6 class="card-title">${artwork.title}</h6>
          <p class="card-text text-muted">${artwork.artist}</p>
          <p class="card-text"><small class="text-muted">${artwork.date}</small></p>
        </div>
      </div>
    </div>
  `).join('');

  // Wire up: card click → open detail view; X button click → remove favorite.
  document.querySelectorAll('#favorites-grid .favorite-card').forEach(card => {
    card.addEventListener('click', () => {
      // Find the cached artwork data so the loading state has title / image / artist.
      const partial = getFavorites().find(
        f => f.source === card.dataset.source && String(f.id) === String(card.dataset.id)
      );
      openDetail(card.dataset.source, card.dataset.id, partial);
    });
  });
  document.querySelectorAll('#favorites-grid .favorite-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger the card click
      removeFavorite(btn.dataset.id, btn.dataset.source);
      renderFavorites();
    });
  });
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

// Search button
document.getElementById('search-btn').addEventListener('click', () => performSearch(1));

// Enter key in search input
document.getElementById('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performSearch(1);
});

// Debounced search-as-you-type
let debounceTimer;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (document.getElementById('search-input').value.trim()) {
      performSearch(1);
    }
  }, 300);
});

// Re-run search automatically when the source dropdown or "Has Image" toggle changes,
// so the user doesn't have to click Search after flipping a filter.
function triggerFilterSearch() {
  if (document.getElementById('search-input').value.trim()) {
    performSearch(1);
  }
}
document.getElementById('source-filter').addEventListener('change', triggerFilterSearch);
document.getElementById('has-image-filter').addEventListener('change', triggerFilterSearch);

// Pagination
document.getElementById('prev-btn').addEventListener('click', () => {
  if (currentPage > 1) performSearch(currentPage - 1);
});
document.getElementById('next-btn').addEventListener('click', () => {
  if (currentPage < totalPages) performSearch(currentPage + 1);
});

// Back button
document.getElementById('back-btn').addEventListener('click', () => showView('search'));

// Navbar — also auto-collapse the hamburger menu after a tap on mobile.
function collapseMobileNav() {
  const menu = document.getElementById('navbar-menu');
  if (menu && menu.classList.contains('show')) {
    bootstrap.Collapse.getOrCreateInstance(menu).hide();
  }
}

document.getElementById('nav-search').addEventListener('click', (e) => {
  e.preventDefault();
  showView('search');
  collapseMobileNav();
});
document.getElementById('nav-favorites').addEventListener('click', (e) => {
  e.preventDefault();
  renderFavorites();
  showView('favorites');
  collapseMobileNav();
});

// ─── Init ────────────────────────────────────────────────────────────────────

// On page load, sync the favorites badge with whatever's in localStorage.
updateFavoritesBadge();