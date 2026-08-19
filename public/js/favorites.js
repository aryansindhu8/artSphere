// ─── localStorage Favorites Management ───────────────────────────────────────

function getFavorites() {
  return JSON.parse(localStorage.getItem('favorites') || '[]');
}

function addFavorite(artwork) {
  const favs = getFavorites();
  if (!favs.find(f => f.id === artwork.id && f.source === artwork.source)) {
    favs.push(artwork);
    localStorage.setItem('favorites', JSON.stringify(favs));
  }
}

function removeFavorite(id, source) {
  const favs = getFavorites().filter(f => !(f.id === id && f.source === source));
  localStorage.setItem('favorites', JSON.stringify(favs));
}

function isFavorite(id, source) {
  return getFavorites().some(f => f.id === id && f.source === source);
}