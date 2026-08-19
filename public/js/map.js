// ─── Leaflet Map ──────────────────────────────────────────────────────────────

let mapInstance = null;

const MUSEUM_INFO = {
  'The Metropolitan Museum of Art': {
    coords: [40.7794, -73.9632],
    address: '1000 Fifth Avenue, New York, NY 10028'
  },
  'Harvard Art Museums': {
    coords: [42.3744, -71.1143],
    address: '32 Quincy Street, Cambridge, MA 02138'
  }
};

function getMuseumAddress(museumName) {
  const info = MUSEUM_INFO[museumName];
  return info ? info.address : '';
}

function initMap(museumName) {
  // Destroy existing map instance before reinitializing
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  const info = MUSEUM_INFO[museumName] || MUSEUM_INFO['The Metropolitan Museum of Art'];
  const latlng = info.coords;
  const address = info.address;

  mapInstance = L.map('map').setView(latlng, 15);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(mapInstance);

  L.marker(latlng)
    .addTo(mapInstance)
    .bindPopup(`<strong>${museumName}</strong><br>${address}`)
    .openPopup();
}