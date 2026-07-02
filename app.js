// ── Safe Auth proxy — prevents "Auth is not defined" errors ──
// Auth is defined later in the file; this proxy queues calls until ready
window.Auth = new Proxy({}, {
  get(_, prop) {
    return (...args) => {
      if (window._AuthReal) return window._AuthReal[prop]?.(...args);
      // Queue the call until Auth is ready
      window._AuthQueue = window._AuthQueue || [];
      window._AuthQueue.push({ prop, args });
    };
  }
});

// ── Early array declarations so Supabase helpers (defined below) can reference them ──
// These are re-declared as const further down, but hoisting with var means they share
// the same global slot and the later const assignments will override the values.
// Using window properties avoids any re-declaration issues across script blocks.
if (!window.listings)   window.listings   = [];
if (!window.myListings) window.myListings = [];
if (!window.lodges)     window.lodges     = [];
if (!window.myLodges)   window.myLodges   = [];
// Make accessible as plain identifiers within this script block
var listings   = window.listings;
var myListings = window.myListings;
var lodges     = window.lodges;
var myLodges   = window.myLodges;
// ── RentaCrib Supabase Config ──
const SUPABASE_URL = 'https://lznwrcgwvecxwqqjsdsi.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6bndyY2d3dmVjeHdxcWpzZHNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MTAzODUsImV4cCI6MjA5NzQ4NjM4NX0.c3t-aRmLxazWvUAnm63FTvcK57suh-F5VQ8aPnQmFWI';
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Fetch + parse JSON with timeout, spanning the FULL request (headers AND body) ──
// Diagnosed via instrumentation: Supabase sometimes answers headers fast but the
// response BODY then stalls mid-download for 30-60s+ (packet loss / flaky mobile
// connection) — not slow code, not payload size. The timeout below has to cover
// res.json() as well as fetch() itself, since that's where the real stall showed up.
// A stalled connection rarely recovers on its own — a brand new connection usually
// succeeds immediately, hence the single retry.
async function fetchJsonWithTimeout(url, options = {}, { timeoutMs = 8000, retries = 1, label = 'fetch' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const _t0 = performance.now();
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) { clearTimeout(timer); return { ok: false, status: res.status, statusText: res.statusText }; }
      const data = await res.json(); // still covered by the same abort signal/timer
      clearTimeout(timer);
      if (attempt > 0) console.log(`⏱️ [${label}] retry succeeded after ${(performance.now() - _t0).toFixed(0)}ms`);
      return { ok: true, status: res.status, data };
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e.name === 'AbortError';
      console.warn(`⏱️ [${label}] attempt ${attempt + 1} ${timedOut ? `stalled past ${timeoutMs}ms timeout` : 'failed'} after ${(performance.now() - _t0).toFixed(0)}ms${attempt < retries ? ' — retrying on a fresh connection' : ' — no retries left'}`);
      if (attempt === retries) return { ok: false, error: e };
    }
  }
}

// ══════════════════════════════════════
//  SUPABASE HELPERS
// ══════════════════════════════════════

// Upload a single photo file to Supabase Storage and return the public URL.
// Returns null on failure so the listing can still save without a photo.
async function uploadPhotoToSupabase(file) {
  if (!file) return null;
  try {
    const ext  = file.name.split('.').pop() || 'jpg';
    const path = `listings/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: upErr } = await db.storage.from('listing-photos').upload(path, file, { upsert: false });
    if (upErr) { console.warn('Photo upload error:', upErr.message); return null; }
    const { data } = db.storage.from('listing-photos').getPublicUrl(path);
    return data?.publicUrl || null;
  } catch(e) { console.warn('Photo upload failed:', e); return null; }
}

// Save a new listing to Supabase
async function saveListingToSupabase(listing) {
  try {
    const locationParts = (listing.location || '').split(',');
    // Location string format is "suburb, city[, ward]" (built by updateLocPill)
    // so parts[0]=suburb, parts[1]=city, parts[2]=ward
    const _suburb = locationParts[0]?.trim() || '';
    const _city   = locationParts[1]?.trim() || '';
    const _ward   = locationParts[2]?.trim() || '';
    const { data, error } = await db.from('properties').insert([{
      title:               listing.title             || '',
      city:                _city,
      suburb:              _suburb,
      ward:                _ward,
      type:                listing.type              || '',
      price:               listing.rent              || 0,
      bedrooms:            listing.rooms             || 1,
      description:         listing.desc              || '',
      whatsapp:            listing.phone             || '',
      call_phone:          listing.callPhone         || listing.phone || '',
      amenities:           JSON.stringify(listing.amenities || []),
      category:            listing.category          || 'tenant',
      role:                listing.role              || 'tenant',
      for_who:             JSON.stringify(listing.forWho || ['Anyone']),
      nearest_university:  listing.nearestUniversity || '',
      students_per_room:   listing.studentsPerRoom   || '',
      hourly_rate:         parseFloat(listing.hourlyRate) || 0,
      day_rate:            parseFloat(listing.dayRate)    || 0,
      day_from:            listing.dayFrom           || '',
      day_to:              listing.dayTo             || '',
      night_rate:          parseFloat(listing.nightRate)  || 0,
      night_from:          listing.nightFrom         || '',
      night_to:            listing.nightTo           || '',
      weekly_rate:         parseFloat(listing.weeklyRate) || 0,
      status:              listing.draft ? 'draft' : 'active',
      owner_code:          listing._ownerCode        || '',
      photo:               listing.photo             || '',
      photos:              JSON.stringify(listing.photoUrls || []),
      views:               0
    }]).select();
    if (error) { console.warn('Supabase save error:', error.message); return null; }
    if (data && data[0]) listing._dbId = data[0].id;
    console.log('✅ Listing saved to Supabase:', data);
    return data;
  } catch(e) { console.warn('Supabase save failed:', e); return null; }
}

// Load landlord's own listings from Supabase by owner_code
async function loadMyListingsFromSupabase(ownerCode) {
  if (!ownerCode) return;
  try {
    const result = await fetchJsonWithTimeout(
      `${SUPABASE_URL}/rest/v1/properties?owner_code=eq.${encodeURIComponent(ownerCode)}&order=created_at.desc&select=id,owner_code,title,suburb,city,ward,type,price,bedrooms,description,whatsapp,call_phone,amenities,for_who,role,category,nearest_university,students_per_room,hourly_rate,day_rate,day_from,day_to,night_rate,night_from,night_to,weekly_rate,photos,created_at,views,status`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
      { timeoutMs: 8000, retries: 1, label: 'myListings' }
    );
    if (!result.ok) { console.warn('Supabase myListings error:', result.status || result.error); return; }
    const data = result.data;
    if (!data || !data.length) return;
    const remoteOwn = data.map(row => ({
      id:                  row.id,
      _dbId:               row.id,
      _remote:             true,
      _ownerCode:          row.owner_code          || ownerCode,
      title:               row.title               || 'Listing',
      location:            [row.suburb, row.city, row.ward].filter(Boolean).join(', '),
      type:                row.type                || 'Full House',
      rent:                row.price               || 0,
      rooms:               row.bedrooms            || 1,
      desc:                row.description         || '',
      phone:               row.whatsapp            || '',
      whatsapp:            row.whatsapp            || '',
      callPhone:           row.call_phone          || row.whatsapp || '',
      amenities:           (() => { try { return JSON.parse(row.amenities || '[]'); } catch(e) { return []; } })(),
      forWho:              (() => { try { return JSON.parse(row.for_who || '["Anyone"]'); } catch(e) { return ['Anyone']; } })(),
      role:                row.role                || 'tenant',
      category:            row.category            || 'tenant',
      nearestUniversity:   row.nearest_university  || '',
      studentsPerRoom:     row.students_per_room   || '',
      hourlyRate:          row.hourly_rate         || '',
      dayRate:             row.day_rate            || '',
      dayFrom:             row.day_from            || '',
      dayTo:               row.day_to              || '',
      nightRate:           row.night_rate          || '',
      nightFrom:           row.night_from          || '',
      nightTo:             row.night_to            || '',
      weeklyRate:          row.weekly_rate         || '',
      photo:               (() => {
        try {
          const urls = JSON.parse(row.photos || '[]');
          if (urls && urls[0]) return urls[0];
        } catch(e) {}
        return (typeof TYPE_PHOTOS !== 'undefined' && TYPE_PHOTOS[row.type])
          ? TYPE_PHOTOS[row.type]
          : 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80&auto=format&fit=crop';
      })(),
      photos:              (() => { try { return JSON.parse(row.photos || '[]'); } catch(e) { return []; } })(),
      listedAt:            new Date(row.created_at).getTime(),
      verified:            false,
      views:               row.views               || 0,
      status:              row.status              || 'active',
    }));
    // Merge into myListings and listings
    const existingIds = new Set(myListings.map(l => l._dbId || l.id));
    remoteOwn.forEach(r => {
      if (!existingIds.has(r._dbId)) {
        myListings.push(r);
        if (!listings.find(x => x._dbId === r._dbId)) listings.unshift(r);
      }
    });
    console.log(`✅ Loaded ${remoteOwn.length} own listings from Supabase`);
  } catch(e) { console.warn('loadMyListings failed:', e); }
}

// Load all listings from Supabase and merge into local array
async function loadListingsFromSupabase() {
  try {
    const result = await fetchJsonWithTimeout(
      `${SUPABASE_URL}/rest/v1/properties?status=eq.active&order=created_at.desc&select=id,title,suburb,city,ward,type,price,bedrooms,description,whatsapp,call_phone,amenities,for_who,role,category,nearest_university,students_per_room,hourly_rate,day_rate,day_from,day_to,night_rate,night_from,night_to,weekly_rate,photos,created_at,views`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
      { timeoutMs: 8000, retries: 1, label: 'listings' }
    );
    if (!result.ok) {
      console.warn('Supabase load error:', result.status || result.error);
      // Fetch failed after retries — don't leave skeleton cards stuck forever.
      // Render whatever's already in memory (localStorage cache restored at
      // page load), and only show the hard error state if we truly have nothing.
      if (document.getElementById('pg-browse')?.classList.contains('active') && typeof filterListings === 'function') filterListings();
      const _eg = document.getElementById('listingsGrid');
      if (_eg && !listings.length) {
        _eg.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:56px 20px;color:var(--text-secondary);font-family:'DM Sans',sans-serif;font-size:14px;"><div style="font-size:32px;margin-bottom:12px;">⚠️</div>Could not load listings. Check your connection and refresh.</div>`;
      }
      return;
    }
    const data = result.data;
    if (!data || !data.length) return;
    // Map Supabase rows → local listing format
    const remoteListings = data.map(row => ({
      id:                  row.id,
      _dbId:               row.id,
      _remote:             true,
      title:               row.title               || 'Listing',
      location:            [row.suburb, row.city, row.ward].filter(Boolean).join(', '),
      type:                row.type                || 'Full House',
      rent:                row.price               || 0,
      rooms:               row.bedrooms            || 1,
      desc:                row.description         || '',
      phone:               row.whatsapp            || '',
      whatsapp:            row.whatsapp            || '',
      callPhone:           row.call_phone          || row.whatsapp || '',
      amenities:           (() => { try { return JSON.parse(row.amenities || '[]'); } catch(e) { return []; } })(),
      forWho:              (() => { try { return JSON.parse(row.for_who || '["Anyone"]'); } catch(e) { return ['Anyone']; } })(),
      role:                row.role                || 'tenant',
      category:            row.category            || 'tenant',
      nearestUniversity:   row.nearest_university  || '',
      studentsPerRoom:     row.students_per_room   || '',
      hourlyRate:          row.hourly_rate         || '',
      dayRate:             row.day_rate            || '',
      dayFrom:             row.day_from            || '',
      dayTo:               row.day_to              || '',
      nightRate:           row.night_rate          || '',
      nightFrom:           row.night_from          || '',
      nightTo:             row.night_to            || '',
      weeklyRate:          row.weekly_rate         || '',
      photo:               (() => {
        try {
          const urls = JSON.parse(row.photos || '[]');
          if (urls && urls[0]) return urls[0];
        } catch(e) {}
        return (typeof TYPE_PHOTOS !== 'undefined' && TYPE_PHOTOS[row.type])
          ? TYPE_PHOTOS[row.type]
          : 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80&auto=format&fit=crop';
      })(),
      photos:              (() => { try { return JSON.parse(row.photos || '[]'); } catch(e) { return []; } })(),
      listedAt:            new Date(row.created_at).getTime(),
      verified:            false,
      views:               row.views               || 0,
    }));
    // Merge into global listings array — avoid duplicates by _dbId
    const existingDbIds = new Set(listings.filter(l=>l._dbId).map(l=>l._dbId));
    remoteListings.forEach(r => { if (!existingDbIds.has(r._dbId)) listings.push(r); });
    console.log(`✅ Loaded ${remoteListings.length} listings from Supabase`);
    // Re-render if browse is currently visible
    if (document.getElementById('pg-browse')?.classList.contains('active')) {
      if (typeof filterListings === 'function') filterListings();
    }
  } catch(e) {
    console.warn('Supabase listings load failed:', e);
    const _eg = document.getElementById('listingsGrid');
    if (_eg && _eg.innerHTML.includes('Loading listings')) {
      _eg.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:56px 20px;color:var(--text-secondary);font-family:'DM Sans',sans-serif;font-size:14px;"><div style="font-size:32px;margin-bottom:12px;">⚠️</div>Could not load listings. Check your connection and refresh.</div>`;
    }
  }
}

// Save an enquiry to Supabase
async function saveEnquiryToSupabase(propertyId, tenantName, tenantPhone, message, extras) {
  // extras is optional: { checkin, checkout, guests, nights, total, special_requests }
  try {
    const { error } = await db.from('enquiries').insert([{
      property_id:      propertyId           || null,
      tenant_name:      tenantName           || '',
      tenant_phone:     tenantPhone          || '',
      message:          message              || '',
      checkin_date:     (extras && extras.checkin)           || null,
      checkout_date:    (extras && extras.checkout)          || null,
      num_guests:       (extras && extras.guests)            ? parseInt(extras.guests) : null,
      num_nights:       (extras && extras.nights)            ? parseInt(extras.nights) : null,
      total_cost:       (extras && extras.total)             ? parseFloat(extras.total) : null,
      special_requests: (extras && extras.special_requests)  || ''
    }]);
    if (error) console.warn('Enquiry save error:', error.message);
    else console.log('✅ Enquiry saved to Supabase');
  } catch(e) { console.warn('Enquiry save failed:', e); }
}

// Delete a listing from Supabase
async function deleteListingFromSupabase(dbId) {
  if (!dbId) return;
  try {
    const { error } = await db.from('properties').delete().eq('id', dbId);
    if (error) console.warn('Supabase delete error:', error.message);
    else console.log('✅ Listing deleted from Supabase');
  } catch(e) { console.warn('Supabase delete failed:', e); }
}

// ══════════════════════════════════════
//  LODGE SUPABASE HELPERS
// ══════════════════════════════════════

// Save a new lodge to Supabase
async function saveLodgeToSupabase(lodge) {
  try {
    const { data, error } = await db.from('lodges').insert([{
      name:           lodge.name            || '',
      location:       lodge.location        || '',
      type:           lodge.type            || '',
      price_per_night: lodge.pricePerNight  || 0,
      hourly_rate:    parseFloat(lodge.hourlyRate) || 0,
      day_rate:       parseInt(lodge.dayRate)      || 0,
      weekly_rate:    parseInt(lodge.weeklyRate)   || 0,
      stars:          lodge.stars           || 4,
      chalets:        lodge.chalets         || 1,
      max_guests:     lodge.maxGuests       || 10,
      description:    lodge.desc            || '',
      whatsapp:       lodge.phone           || '',
      call_phone:     lodge.callPhone       || lodge.phone || '',
      features:       JSON.stringify(lodge.features || []),
      available:      lodge.available !== false,
      owner_code:     lodge._ownerCode      || '',
      status:         'active',
      photos:         JSON.stringify(lodge.photoUrls || []),
      views:          0
    }]).select();
    if (error) { console.warn('Lodge save error:', error.message); return null; }
    if (data && data[0]) lodge._dbId = data[0].id;
    console.log('✅ Lodge saved to Supabase:', data);
    return data;
  } catch(e) { console.warn('Lodge save failed:', e); return null; }
}

// ── Broken image fallback ──
// Called via onerror on every listing/lodge card <img>.
// Swaps to a 1×1 transparent gif so onerror doesn't re-fire,
// then applies .img-broken so CSS shows the placeholder.
// ── XSS sanitiser ──
// Escapes the five HTML-significant characters so user-supplied strings
// are safe to interpolate into innerHTML template literals.
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function onImgError(el) {
  el.onerror = null; // prevent infinite loop
  el.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><rect width="400" height="260" fill="#f1f0e8"/><text x="200" y="118" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#b4b2a9">📷</text><text x="200" y="152" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#888780">No photo available</text></svg>');
  el.classList.add('img-broken');
}

// Load all lodges from Supabase
async function loadLodgesFromSupabase() {
  const _t0 = performance.now();
  console.log(`⏱️ [lodges] fetch started at +${_t0.toFixed(0)}ms since page load`);
  try {
    const result = await fetchJsonWithTimeout(
      `${SUPABASE_URL}/rest/v1/lodges?status=eq.active&order=created_at.desc&select=id,owner_code,name,location,type,price_per_night,hourly_rate,day_rate,weekly_rate,stars,chalets,max_guests,description,whatsapp,call_phone,features,available,photos,created_at,views`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
      { timeoutMs: 8000, retries: 1, label: 'lodges' }
    );
    const _t1 = performance.now();
    if (!result.ok) {
      console.warn('Supabase lodge load error:', result.status || result.error);
      // Fetch failed after retries — don't leave skeleton cards stuck forever.
      // Render whatever's already in memory (localStorage cache restored at
      // page load), and only show the hard error state if we truly have nothing.
      if (typeof filterLodges === 'function') filterLodges();
      const _egf = document.getElementById('lodgeGrid');
      if (_egf && !lodges.length) {
        _egf.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:56px 20px;color:var(--text-secondary);font-family:'DM Sans',sans-serif;font-size:14px;"><div style="font-size:32px;margin-bottom:12px;">⚠️</div>Could not load lodges. Check your connection and refresh.</div>`;
      }
      return;
    }
    console.log(`⏱️ [lodges] fetch+parse complete after ${(_t1 - _t0).toFixed(0)}ms (status ${result.status})`);
    const data = result.data;
    const _t2 = _t1;
    if (!data || !data.length) return;
    // Map Supabase rows → local lodge format
    const remoteLodges = data.map(row => ({
      id:            row.id,
      _dbId:         row.id,
      _remote:       true,
      _ownerCode:    row.owner_code      || '',
      name:          row.name            || 'Lodge',
      location:      row.location        || '',
      type:          row.type            || 'Bush Lodge',
      pricePerNight: row.price_per_night || 0,
      hourlyRate:    row.hourly_rate     || '',
      dayRate:       row.day_rate        || '',
      weeklyRate:    row.weekly_rate     || '',
      stars:         row.stars           || 4,
      chalets:       row.chalets         || 1,
      maxGuests:     row.max_guests      || 10,
      desc:          row.description     || '',
      phone:         row.whatsapp        || '',
      callPhone:     row.call_phone      || row.whatsapp || '',
      features:      (() => { try { return JSON.parse(row.features || '[]'); } catch(e) { return []; } })(),
      available:     row.available !== false,
      photo:         (() => {
        try {
          const urls = JSON.parse(row.photos || '[]');
          if (urls && urls[0]) return urls[0];
        } catch(e) {}
        const LODGE_TYPE_PHOTOS = {
          'Bush Lodge':'https://images.unsplash.com/photo-1489392191049-fc10c97e64b6?w=600&q=80',
          'Lake Lodge':'https://images.unsplash.com/photo-1590523741831-ab7e8b8f9c7f?w=600&q=80',
          'Mountain Retreat':'https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=600&q=80',
          'City Boutique':'https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=600&q=80',
          'Safari Camp':'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=600&q=80',
          'Eco Lodge':'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=600&q=80',
        };
        return LODGE_TYPE_PHOTOS[row.type] || LODGE_TYPE_PHOTOS['Bush Lodge'];
      })(),
      photos:        (() => { try { return JSON.parse(row.photos || '[]'); } catch(e) { return []; } })(),
      listedAt:      new Date(row.created_at).getTime(),
      views:         row.views || 0,
    }));
    // Merge into global lodges array — avoid duplicates by _dbId
    const existingIds = new Set(lodges.filter(l=>l._dbId).map(l=>l._dbId));
    remoteLodges.forEach(r => { if (!existingIds.has(r._dbId)) lodges.push(r); });
    console.log(`✅ Loaded ${remoteLodges.length} lodges from Supabase`);
    // Cache for next visit (used for instant restore on next page load, no expiry)
    try { localStorage.setItem('rc_lodges_cache', JSON.stringify({ data: remoteLodges, ts: Date.now() })); } catch(e) {}
    // Always re-render — filterLodges is safe to call anytime and replaces skeletons
    // whether the user is already on pg-lodges or navigates there later
    if (typeof filterLodges === 'function') filterLodges();
    const _t3 = performance.now();
    console.log(`⏱️ [lodges] TOTAL: ${(_t3 - _t0).toFixed(0)}ms from fetch start to render done (map+render took ${(_t3 - _t2).toFixed(0)}ms)`);
  } catch(e) {
    console.warn(`⏱️ [lodges] FAILED after ${(performance.now() - _t0).toFixed(0)}ms:`, e);
    const _eg = document.getElementById('lodgeGrid');
    if (_eg && !lodges.length) {
      _eg.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:56px 20px;color:var(--text-secondary);font-family:'DM Sans',sans-serif;font-size:14px;"><div style="font-size:32px;margin-bottom:12px;">⚠️</div>Could not load lodges. Check your connection and refresh.</div>`;
    }
  }
}

// Load owner's own lodges from Supabase
async function loadMyLodgesFromSupabase(ownerCode) {
  if (!ownerCode) return;
  try {
    const result = await fetchJsonWithTimeout(
      `${SUPABASE_URL}/rest/v1/lodges?owner_code=eq.${encodeURIComponent(ownerCode)}&order=created_at.desc&select=id,owner_code,name,location,type,price_per_night,hourly_rate,day_rate,weekly_rate,stars,chalets,max_guests,description,whatsapp,call_phone,features,available,status,photos,created_at,views`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
      { timeoutMs: 8000, retries: 1, label: 'myLodges' }
    );
    if (!result.ok) { console.warn('My lodges load error:', result.status || result.error); return; }
    const data = result.data;
    if (!data || !data.length) return;
    const remoteOwn = data.map(row => ({
      id:            row.id,
      _dbId:         row.id,
      _remote:       true,
      _ownerCode:    row.owner_code      || ownerCode,
      name:          row.name            || 'Lodge',
      location:      row.location        || '',
      type:          row.type            || 'Bush Lodge',
      pricePerNight: row.price_per_night || 0,
      hourlyRate:    row.hourly_rate     || '',
      dayRate:       row.day_rate        || '',
      weeklyRate:    row.weekly_rate     || '',
      stars:         row.stars           || 4,
      chalets:       row.chalets         || 1,
      maxGuests:     row.max_guests      || 10,
      desc:          row.description     || '',
      phone:         row.whatsapp        || '',
      callPhone:     row.call_phone      || row.whatsapp || '',
      features:      (() => { try { return JSON.parse(row.features || '[]'); } catch(e) { return []; } })(),
      available:     row.available !== false,
      status:        row.status          || 'active',
      photo:         (() => {
        try {
          const urls = JSON.parse(row.photos || '[]');
          if (urls && urls[0]) return urls[0];
        } catch(e) {}
        const LODGE_TYPE_PHOTOS = {
          'Bush Lodge':'https://images.unsplash.com/photo-1489392191049-fc10c97e64b6?w=600&q=80',
          'Lake Lodge':'https://images.unsplash.com/photo-1590523741831-ab7e8b8f9c7f?w=600&q=80',
          'Mountain Retreat':'https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=600&q=80',
          'City Boutique':'https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=600&q=80',
          'Safari Camp':'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=600&q=80',
          'Eco Lodge':'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=600&q=80',
        };
        return LODGE_TYPE_PHOTOS[row.type] || LODGE_TYPE_PHOTOS['Bush Lodge'];
      })(),
      photos:        (() => { try { return JSON.parse(row.photos || '[]'); } catch(e) { return []; } })(),
      listedAt:      new Date(row.created_at).getTime(),
      views:         row.views || 0,
    }));
    // Merge into myLodges and lodges — avoid duplicates by _dbId
    const existingIds = new Set(myLodges.map(l => l._dbId || l.id));
    remoteOwn.forEach(r => {
      if (!existingIds.has(r._dbId)) {
        myLodges.push(r);
        if (!lodges.find(x => x._dbId === r._dbId)) lodges.push(r);
      }
    });
    console.log(`✅ Loaded ${remoteOwn.length} own lodges from Supabase`);
  } catch(e) { console.warn('My lodges load failed:', e); }
}

// Delete a lodge from Supabase
async function deleteLodgeFromSupabase(dbId) {
  if (!dbId) return;
  try {
    const { error } = await db.from('lodges').delete().eq('id', dbId);
    if (error) console.warn('Lodge delete error:', error.message);
    else console.log('✅ Lodge deleted from Supabase');
  } catch(e) { console.warn('Lodge delete failed:', e); }
}

// Load on page ready
// ── Progress bar helpers ──
function rcProgressShow() {
  const t = document.getElementById('rc-progress-track');
  if (t) { t.classList.remove('done','fade-out'); t.classList.add('visible'); }
}
function rcProgressSet(pct) {
  const b = document.getElementById('rc-progress-bar');
  if (b) b.style.width = pct + '%';
}
function rcProgressDone() {
  const t = document.getElementById('rc-progress-track');
  if (!t) return;
  t.classList.add('done');
  setTimeout(() => t.classList.add('fade-out'), 200);
  setTimeout(() => t.classList.remove('visible','done','fade-out'), 700);
}

// ── Skeleton card HTML ──
function rcSkeletonCard() {
  return `<div class="skel-card">
    <div class="skel-photo"></div>
    <div class="skel-body">
      <div class="skel-line loc"></div>
      <div class="skel-line title-a"></div>
      <div class="skel-line title-b"></div>
      <div class="skel-tags">
        <div class="skel-tag"></div>
        <div class="skel-tag"></div>
        <div class="skel-tag"></div>
      </div>
      <div class="skel-footer">
        <div class="skel-line price"></div>
        <div class="skel-line avail"></div>
      </div>
    </div>
  </div>`;
}

window.addEventListener('DOMContentLoaded', () => {
  // ── Show skeleton cards immediately instead of a spinner ──
  const _lGrid = document.getElementById('listingsGrid');
  if (_lGrid) _lGrid.innerHTML = Array(6).fill(rcSkeletonCard()).join('');
  const _dGrid = document.getElementById('lodgeGrid');
  if (_dGrid) _dGrid.innerHTML = Array(6).fill(rcSkeletonCard()).join('');

  // ── Start progress bar ──
  rcProgressShow();
  rcProgressSet(8);

  // Restore locally saved listings first (instant, no network needed)
  try {
    const stored = JSON.parse(localStorage.getItem('rc_myListings') || '[]');
    if (stored.length) {
      stored.forEach(l => {
        if (!myListings.find(x => x.id === l.id)) myListings.push(l);
        if (!listings.find(x => x.id === l.id)) listings.unshift(l);
      });
    }
  } catch(e) {}
  // Restore locally saved lodges
  try {
    const storedLodges = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
    if (storedLodges.length) {
      storedLodges.forEach(l => {
        if (!myLodges.find(x => x.id === l.id)) myLodges.push(l);
        if (!lodges.find(x => x.id === l.id)) lodges.push(l);
      });
    }
  } catch(e) {}
  // Restore public lodges cache instantly (same pattern as rc_myListings restore above)
  // No freshness check here on purpose — any cached data is shown instantly, then
  // silently replaced once the always-run background fetch below resolves.
  try {
    const _lc = localStorage.getItem('rc_lodges_cache');
    if (_lc) {
      const { data: _lcd } = JSON.parse(_lc);
      if (_lcd && _lcd.length) {
        const _lexIds = new Set(lodges.filter(l=>l._dbId).map(l=>l._dbId));
        _lcd.forEach(r => { if (!_lexIds.has(r._dbId)) lodges.push(r); });
      }
    }
  } catch(e) {}

  rcProgressSet(20);

  // Then load from Supabase (network) — ghost purge runs inside the promise chain
  Promise.all([
    loadListingsFromSupabase().then(() => rcProgressSet(65)),
    loadLodgesFromSupabase().then(() => rcProgressSet(90))
  ]).then(async () => {
  rcProgressSet(100);
  setTimeout(rcProgressDone, 250);
  // ── Ghost purge: runs after BOTH Supabase fetches complete ──
  // (previously used a blind 4s timeout which could fire before data arrived)
  {
    try {
      // --- Purge ghost listings ---
      const storedL = JSON.parse(localStorage.getItem('rc_myListings') || '[]');
      const remoteDbIds = new Set(listings.filter(l => l._dbId).map(l => String(l._dbId)));
      // FIX: same issue as lodges — listings with no _dbId are ghosts if Supabase loaded successfully.
      const supabaseListingsLoaded = listings.filter(l => l._remote).length > 0;
      const cleanL = storedL.filter(l => {
        if (l._dbId) return remoteDbIds.has(String(l._dbId));
        return !supabaseListingsLoaded;
      });
      if (cleanL.length !== storedL.length) {
        localStorage.setItem('rc_myListings', JSON.stringify(cleanL));
        // Remove ghosts from in-memory arrays
        const keepIds = new Set(cleanL.map(l => String(l.id)));
        for (let i = listings.length - 1; i >= 0; i--) {
          if (!keepIds.has(String(listings[i].id)) && !listings[i]._remote) listings.splice(i, 1);
        }
        for (let i = myListings.length - 1; i >= 0; i--) {
          if (!keepIds.has(String(myListings[i].id)) && !myListings[i]._remote) myListings.splice(i, 1);
        }
        console.log(`🧹 Purged ${storedL.length - cleanL.length} ghost listing(s) from localStorage`);
        if (typeof filterListings === 'function') filterListings();
        if (typeof renderDashboard === 'function') renderDashboard(myListings);
      }
    } catch(e) { console.warn('Listing ghost purge failed:', e); }

    try {
      // --- Purge ghost lodges ---
      const storedLodges = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
      const remoteLodgeDbIds = new Set(lodges.filter(l => l._dbId).map(l => String(l._dbId)));
      // FIX: lodges with no _dbId are NOT safe to keep if Supabase loaded successfully (lodges.length > 0).
      // Previously, missing _dbId meant "keep it" — that caused deleted lodges to persist forever
      // in the browser of the user who created them (Supabase had no row, _dbId was never written back).
      // Now: if Supabase returned data, any localStorage lodge with no _dbId is treated as a ghost.
      const supabaseLoaded = lodges.length > 0;
      const cleanLodges = storedLodges.filter(l => {
        if (l._dbId) return remoteLodgeDbIds.has(String(l._dbId)); // must exist in Supabase
        return !supabaseLoaded; // no _dbId + Supabase loaded = ghost; keep only if network failed
      });
      if (cleanLodges.length !== storedLodges.length) {
        localStorage.setItem('rc_myLodges', JSON.stringify(cleanLodges));
        // Remove ghosts from in-memory arrays
        const keepIds = new Set(cleanLodges.map(l => String(l.id)));
        for (let i = lodges.length - 1; i >= 0; i--) {
          if (!keepIds.has(String(lodges[i].id)) && !lodges[i]._remote) lodges.splice(i, 1);
        }
        for (let i = myLodges.length - 1; i >= 0; i--) {
          if (!keepIds.has(String(myLodges[i].id)) && !myLodges[i]._remote) myLodges.splice(i, 1);
        }
        console.log(`🧹 Purged ${storedLodges.length - cleanLodges.length} ghost lodge(s) from localStorage`);
        if (typeof filterLodges === 'function') filterLodges();
      }
    } catch(e) { console.warn('Lodge ghost purge failed:', e); }
  }
  }).catch(e => console.warn('Ghost purge setup failed:', e));
});


// ═══════════════════════════════════════
// MAIN APPLICATION
// ═══════════════════════════════════════
// ══════════════════════════════════════
//  RENTACRIB ENHANCEMENTS MODULE (RC)
//  Handles: state persistence, smart triggers, micro-interactions, feedback loops
// ══════════════════════════════════════
// ── FIX 13: Centralised support WhatsApp number ──
window.SUPPORT_WHATSAPP = '263775863959';

const RC = (() => {
  // ── Storage helpers ──
  const ss = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
  const sg = (k) => { try { return JSON.parse(sessionStorage.getItem(k)); } catch(e){ return null; } };
  const ls = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
  const lg = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } };

  // ── State ──
  let savedFilters = sg('rc_browse_filters') || {};
  let savedScroll = sg('rc_browse_scroll') || 0;
  let viewedTypes = lg('rc_viewed_types') || [];
  let savedWANumber = lg('rc_wa_number') || '';
  let favCount = lg('rc_fav_count') || 0;
  let viewCount = lg('rc_view_count') || 0;
  let phoneVerified = lg('rc_phone_verified') || false;
  let lastLodgeCity = sg('rc_last_lodge_city') || '';
  let isLodgePhoneVerified = lg('rc_phone_verified') || false;
  let toastRichTimer = null;

  // ── Confetti ──
  function launchConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    canvas.style.display = 'block';
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const pieces = [];
    const colors = ['#059669','#F59E0B','#2563EB','#DC2626','#7C3AED','#0EA5E9','#10B981'];
    for (let i = 0; i < 130; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: Math.random() * -canvas.height,
        w: Math.random() * 9 + 5,
        h: Math.random() * 5 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 5 + 2,
        vrot: (Math.random() - 0.5) * 0.2,
        alpha: 1,
      });
    }
    let frame = 0;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.rot += p.vrot; p.vy += 0.08;
        if (frame > 90) p.alpha = Math.max(0, p.alpha - 0.015);
        ctx.save(); ctx.globalAlpha = p.alpha;
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
        ctx.restore();
      });
      frame++;
      if (frame < 140) requestAnimationFrame(draw);
      else { ctx.clearRect(0,0,canvas.width,canvas.height); canvas.style.display='none'; }
    }
    draw();
  }

  // ── Rich toast ──
  function richToast(main, actionLabel, actionFn, duration) {
    clearTimeout(toastRichTimer);
    const el = document.getElementById('toastRich');
    const mainEl = document.getElementById('toastRichMain');
    const actEl = document.getElementById('toastRichAction');
    mainEl.textContent = main;
    if (actionLabel && actionFn) {
      actEl.textContent = actionLabel;
      actEl.onclick = () => { actionFn(); el.classList.remove('show'); };
      actEl.style.display = 'block';
    } else { actEl.style.display = 'none'; }
    el.classList.add('show');
    toastRichTimer = setTimeout(() => el.classList.remove('show'), duration || 4000);
  }

  // ── Save/restore filters ──
  function saveFilters() {
    // Save role-aware filters
    if (typeof currentRole !== 'undefined') {
      if (currentRole === 'student') {
        // FIX 7: guard each element with ?. before reading .value
        ss('rc_browse_filters', {
          role: 'student',
          university: document.getElementById('sFilterUniversity')?.value || '',
          city: document.getElementById('sFilterCity')?.value || '',
          suburb: document.getElementById('sFilterSuburb')?.value || '',
          type: document.getElementById('sFilterType')?.value || '',
          rooms: document.getElementById('sFilterRooms')?.value || '',
          spr: document.getElementById('sFilterStudentsPerRoom')?.value || '',
          budget: document.getElementById('sFilterBudget')?.value || '',
          amenity: document.getElementById('sFilterAmenity')?.value || '',
        });
      } else if (currentRole === 'tenant') {
        ss('rc_browse_filters', {
          role: 'tenant',
          city: document.getElementById('tFilterCity')?.value || '',
          suburb: document.getElementById('tFilterSuburb')?.value || '',
          type: document.getElementById('tFilterType')?.value || '',
          rooms: document.getElementById('tFilterRooms')?.value || '',
          budget: document.getElementById('tFilterBudget')?.value || '',
          amenity: document.getElementById('tFilterAmenity')?.value || '',
        });
      }
    }
  }

  function restoreFilters() {
    const f = sg('rc_browse_filters');
    if (!f || !f.role) return;
    // Normalise: old versions may have saved page IDs ('pg-tenant', 'pg-student')
    // instead of role strings ('tenant', 'student'). Strip the prefix if present.
    const role = (f.role || '').replace(/^pg-/, '');
    if (role === 'student') {
      if (f.city) { const el = document.getElementById('sFilterCity'); if (el) el.value = f.city; }
      if (f.type) { const el = document.getElementById('sFilterType'); if (el) el.value = f.type; }
      if (f.university) { const el = document.getElementById('sFilterUniversity'); if (el) el.value = f.university; }
      if (f.rooms) { const el = document.getElementById('sFilterRooms'); if (el) el.value = f.rooms; }
      if (f.spr) { const el = document.getElementById('sFilterStudentsPerRoom'); if (el) el.value = f.spr; }
      if (f.budget) { const el = document.getElementById('sFilterBudget'); if (el) el.value = f.budget; }
      if (f.amenity) { const el = document.getElementById('sFilterAmenity'); if (el) el.value = f.amenity; }
      if (f.city) filterStudentListings();
      if (f.suburb) { const el = document.getElementById('sFilterSuburb'); if (el) { el.value = f.suburb; filterStudentListings(); } }
    } else if (role === 'tenant') {
      if (f.city) { const el = document.getElementById('tFilterCity'); if (el) el.value = f.city; }
      if (f.type) { const el = document.getElementById('tFilterType'); if (el) el.value = f.type; }
      if (f.rooms) { const el = document.getElementById('tFilterRooms'); if (el) el.value = f.rooms; }
      if (f.budget) { const el = document.getElementById('tFilterBudget'); if (el) el.value = f.budget; }
      if (f.amenity) { const el = document.getElementById('tFilterAmenity'); if (el) el.value = f.amenity; }
      if (f.city) filterTenantListings();
      if (f.suburb) { const el = document.getElementById('tFilterSuburb'); if (el) { el.value = f.suburb; filterTenantListings(); } }
    }
    // Restore scroll
    const scroll = sg('rc_browse_scroll');
    if (scroll) setTimeout(() => window.scrollTo(0, scroll), 80);
  }

  function saveScrollPos() {
    ss('rc_browse_scroll', window.scrollY);
  }

  // ── Save/restore landlord form ──
  function saveForm() {
    const data = {
      title: document.getElementById('fTitle')?.value || '',
      rent: document.getElementById('fRent')?.value || '',
      rooms: document.getElementById('fRooms')?.value || '',
      phone: document.getElementById('fPhone')?.value || '',
      callPhone: document.getElementById('fCallPhone')?.value || '',
      desc: document.getElementById('fDesc')?.value || '',
      location: document.getElementById('fLocation')?.value || '',
      citySearch: document.getElementById('fCitySearch')?.value || '',
      suburbSearch: document.getElementById('fSuburbSearch')?.value || '',
    };
    // Only save if there's meaningful data
    if (data.title || data.desc || data.phone) {
      ss('rc_landlord_form', data);
    }
  }

  function clearSavedForm() {
    sessionStorage.removeItem('rc_landlord_form');
    sessionStorage.removeItem('rc_landlord_step');
  }

  let _draftTimerInterval = null;

  function _clearDraftTimer() {
    if (_draftTimerInterval) { clearInterval(_draftTimerInterval); _draftTimerInterval = null; }
  }

  function _hideBanner() {
    const banner = document.getElementById('formRestoreBanner');
    if (!banner) return;
    banner.classList.remove('visible');
    setTimeout(() => banner.classList.remove('show'), 380);
  }

  function checkFormRestore() {
    const saved = sg('rc_landlord_form');
    if (!saved || (!saved.title && !saved.desc && !saved.phone)) return;

    // Populate preview fields
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
    setVal('frbValTitle',    saved.title    || '—');
    setVal('frbValPhone',    saved.phone    ? (saved.phone.length > 6 ? saved.phone.slice(0,4) + '••••' : saved.phone) : '—');
    setVal('frbValLocation', saved.citySearch ? (saved.suburbSearch ? saved.suburbSearch + ', ' + saved.citySearch : saved.citySearch) : '—');

    // Show & animate in
    const banner = document.getElementById('formRestoreBanner');
    if (!banner) return;
    banner.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add('visible')));

    // Auto-discard countdown
    _clearDraftTimer();
    let secondsLeft = 30;
    const countdownEl = document.getElementById('frbCountdown');
    const fillEl      = document.getElementById('frbTimerFill');
    _draftTimerInterval = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = secondsLeft;
      if (fillEl) fillEl.style.width = ((secondsLeft / 30) * 100) + '%';
      if (secondsLeft <= 0) { _clearDraftTimer(); discardDraft(); }
    }, 1000);
  }

  function discardDraft() {
    _clearDraftTimer();
    RC.clearSavedForm();
    _hideBanner();
  }

  function restoreForm() {
    _clearDraftTimer();
    const data = sg('rc_landlord_form');
    if (!data) return;
    if (document.getElementById('fTitle'))     document.getElementById('fTitle').value     = data.title     || '';
    if (document.getElementById('fRent'))      document.getElementById('fRent').value      = data.rent      || '';
    if (document.getElementById('fRooms'))     document.getElementById('fRooms').value     = data.rooms     || '';
    if (document.getElementById('fPhone'))     document.getElementById('fPhone').value     = data.phone     || '';
    if (document.getElementById('fCallPhone')) document.getElementById('fCallPhone').value = data.callPhone || '';
    if (document.getElementById('fDesc'))      document.getElementById('fDesc').value      = data.desc      || '';
    if (document.getElementById('fLocation'))  document.getElementById('fLocation').value  = data.location  || '';
    if (data.citySearch && document.getElementById('fCitySearch')) {
      document.getElementById('fCitySearch').value = data.citySearch;
      if (data.citySearch) selectCity(data.citySearch);
    }
    if (data.suburbSearch && document.getElementById('fSuburbSearch')) {
      setTimeout(() => {
        document.getElementById('fSuburbSearch').value = data.suburbSearch;
        if (data.suburbSearch) selectSuburb(data.suburbSearch);
      }, 100);
    }
    _hideBanner();
    toast('✓ Draft restored — carry on where you left off!');
  }

  // ── Track viewed listing types for smart defaulting ──
  function trackViewedType(type) {
    viewedTypes.unshift(type);
    if (viewedTypes.length > 9) viewedTypes = viewedTypes.slice(0, 9);
    ls('rc_viewed_types', viewedTypes);
  }

  function getDefaultTab() {
    if (!viewedTypes.length) return null;
    const counts = {};
    viewedTypes.slice(0, 3).forEach(t => { counts[t] = (counts[t]||0)+1; });
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    if (!top) return null;
    // Map listing type to tenant tab
    const tMap = {
      'Single Room': 'students', 'Self-Contained': 'students', 'Shared House': 'students',
      'Full Apartment': 'profam', 'Full House': 'profam', 'Cottage': 'profam',
    };
    return tMap[top[0]] || null;
  }

  function applyDefaultTab() {
    // Category-to-panel linking now handled by activateAmenityPanel() in showFlowStep
  }

  // ── Smart: pre-fill WA number ──
  function prefillWANumber() {
    // WA number is no longer auto-filled from storage to keep fields clean on fresh open
  }

  function persistWANumber(val) {
    if (val && val.length >= 8) ls('rc_wa_number', val);
  }

  // ── Smart: upcoming weekend dates for lodge booking ──
  function getUpcomingWeekend() {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
    let daysToFri = (5 - day + 7) % 7;
    if (daysToFri === 0) daysToFri = 7; // if today is Friday, next Friday
    const fri = new Date(now); fri.setDate(now.getDate() + daysToFri);
    const sun = new Date(fri); sun.setDate(fri.getDate() + 2);
    const fmt = d => d.toISOString().split('T')[0];
    return { checkin: fmt(fri), checkout: fmt(sun) };
  }

  // Track how many times a lodge detail has been viewed
  const lodgeViews = lg('rc_lodge_views') || {};
  function trackLodgeView(id) {
    // Don't count views from the lodge's own owner,
    // and don't fire a Supabase write if already seen this session
    const lodge = [...(window.myLodges||[]), ...(window.lodges||[])].find(l => l.id == id);
    const _sess = (()=>{ try { return JSON.parse(localStorage.getItem('rc_session')); } catch(e){ return null; }})();
    if (lodge && _sess && _sess.code && lodge._ownerCode && lodge._ownerCode === _sess.code) {
      return lodgeViews[id] || lodge.views || 0; // return current count without incrementing
    }
    window._seenLodges = window._seenLodges || new Set();
    const _lodgeAlreadySeen = window._seenLodges.has(id);
    if (!_lodgeAlreadySeen) window._seenLodges.add(id);
    lodgeViews[id] = (lodgeViews[id] || 0) + 1;
    ls('rc_lodge_views', lodgeViews);
    // Persist to Supabase so view count is cross-device
    if (lodge && lodge._dbId && typeof db !== 'undefined' && !_lodgeAlreadySeen) {
      lodge.views = lodgeViews[id];
      (async () => {
        try {
          const res = await fetch(
            `${SUPABASE_URL}/rest/v1/lodges?id=eq.${encodeURIComponent(lodge._dbId)}`,
            {
              method: 'PATCH',
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({ views: lodge.views })
            }
          );
          if (!res.ok) console.warn('Lodge view update error:', res.status, await res.text());
        } catch(e) { console.warn('Lodge view update failed:', e); }
      })();
    }
    // ── Update dashboard stat + per-card badge live (mirrors property view behaviour) ──
    const _lodgeSess = (typeof session === 'function') ? session() : null;
    if (_lodgeSess && !_lodgeAlreadySeen) {
      // Re-total views across all owned properties + lodges
      const statViews = document.getElementById('statViews');
      if (statViews) {
        const ownedProps   = (window.myListings || []).filter(x => x._ownerCode === _lodgeSess.code);
        const ownedLodges  = (window.myLodges   || []).filter(x => x._ownerCode === _lodgeSess.code);
        const total = [...ownedProps, ...ownedLodges].reduce((a, x) => a + (x.views || 0), 0);
        statViews.textContent = total || '—';
      }
      // Update the per-card views badge on the dashboard if it's visible
      const cardBadges = document.querySelectorAll(`#dlc-${id} .dlc-views-badge`);
      const vCount = lodgeViews[id] || 0;
      cardBadges.forEach(b => { b.textContent = `👁 ${vCount} view${vCount === 1 ? '' : 's'}`; });
    }
    return lodgeViews[id];
  }

  // ── Fav tracking + Super Searcher badge ──
  function onFav(area) {
    favCount = (lg('rc_fav_count') || 0) + 1;
    ls('rc_fav_count', favCount);
    richToast(
      `❤️ Added to favourites.`,
      area ? `Explore more in ${area}` : null,
      area ? () => {
        setRole('tenant');
        setTimeout(() => {
          // Use tenant city filter (role-aware)
          const cityEl = document.getElementById('tFilterCity');
          if (cityEl) {
            const opts = Array.from(cityEl.options);
            const match = opts.find(o => area.toLowerCase().includes(o.value.toLowerCase()) || o.value.toLowerCase().includes(area.toLowerCase()));
            if (match) { cityEl.value = match.value; filterTenantListings(); }
          }
        }, 200);
      } : null
    );
    if (favCount >= 5) {
      const badge = document.getElementById('superSearcherBadge');
      if (badge) {
        badge.style.display = 'block';
        setTimeout(() => badge.style.display = 'none', 4500);
      }
    }
  }

  // ── View count → gentle prompt ──
  function onListingView() {
    viewCount = (lg('rc_view_count') || 0) + 1;
    ls('rc_view_count', viewCount);
    // "Looking for something specific?" popup removed
  }

  // ── Live Preview Card ── (card removed from UI; method kept as no-op for safety)
  // FIX 6: updateLivePreview removed – referenced DOM elements do not exist

  // ── Smart suburb suggestion after city ──
  const POPULAR_SUBURBS = {
    'Harare': 'Avondale', 'Bulawayo': 'Nkulumane', 'Masvingo': 'Mucheke',
    'Mutare': 'Dangamvura', 'Gweru': 'Mkoba', 'Chinhoyi': 'Chipadze',
    'Bindura': 'Chiwaridzo', 'Kwekwe': 'Mbizo', 'Kadoma': 'Rimuka',
    'Victoria Falls': 'Chinotimba', 'Kariba': 'Nyamhunga', 'Nyanga': 'Nyanga Township',
  };

  function onCitySelected(city) {
    const suburbInput = document.getElementById('fSuburbSearch');
    if (suburbInput && POPULAR_SUBURBS[city]) {
      suburbInput.placeholder = `e.g. ${POPULAR_SUBURBS[city]}`;
    }
    // Pre-suggest university for known university cities
    const cityUniMap = {
      'Harare': 'University of Zimbabwe (UZ)',
      'Bulawayo': 'National University of Science and Technology (NUST)',
      'Masvingo': 'Great Zimbabwe University (GZU)',
      'Mutare': 'Africa University (AU)',
      'Gweru': 'Midlands State University (MSU)',
      'Chinhoyi': 'Chinhoyi University of Technology (CUT)',
      'Bindura': 'Bindura University of Science Education (BUSE)',
    };
    const uniInput = document.getElementById('fUniversity');
    if (uniInput && !uniInput.value && cityUniMap[city]) {
      uniInput.placeholder = `e.g. ${cityUniMap[city]}`;
    }
  }

  // ── Phone verification (simulated) ──
  // FIX 11: verifyPhone stub removed

  // ── After booking: "You might also like" ──
  // FIX 9: accepts allLodges array as argument to avoid closure over stale globals
  function showYouMightLike(lodge, allLodges) {
    if (!allLodges) allLodges = [...new Map([...lodges, ...myLodges].map(l => [l.id, l])).values()];
    const region = lodge.location.split(',').pop()?.trim() || '';
    const similar = allLodges.filter(l => l.id !== lodge.id && (l.location.includes(region) || l.type === lodge.type)).slice(0,4);
    if (!similar.length) return;
    const grid = document.getElementById('youMightLikeGrid');
    const wrap = document.getElementById('youMightLike');
    if (!grid || !wrap) return;
    grid.innerHTML = similar.map(l => `
      <div class="yml-card" onclick="openLodgeDetail('${l.id}')">
        <img src="${l.photo}" alt="${esc(l.name)}" loading="lazy" onerror="onImgError(this)">
        <div class="yml-card-body">
          <div class="yml-card-name">${esc(l.name)}</div>
          <div class="yml-card-price">$${l.pricePerNight}/night</div>
        </div>
      </div>`).join('');
    wrap.classList.add('show');
  }

  // ── After viewing: similar listings ──
  // FIX 9: accepts allListings and allLodges arrays as arguments
  function showSimilarListings(listing, allListings, allLodges) {
    if (!allListings) allListings = [...new Map([...listings, ...myListings].map(l => [l.id, l])).values()];
    if (!allLodges)   allLodges   = [...new Map([...lodges,   ...myLodges  ].map(l => [l.id, l])).values()];
    const sameRole = listing.role || 'tenant';
    let pool = allListings;
    if (sameRole === 'lodge') {
      const lodgeAsListings = allLodges.map(l => ({
        ...l, title: l.name, rent: l.pricePerNight, role: 'lodge', category: 'lodge',
        amenities: l.features || [], forWho: ['Guests'], rooms: l.chalets || 1,
      }));
      pool = [...new Map([...allListings, ...lodgeAsListings].map(l => [l.id, l])).values()];
    }
    const similar = pool
      .filter(l => l.id !== listing.id && (l.role === sameRole) && (
        (l.location || '').toLowerCase().includes((listing.location.split(',')[1]?.trim() || '').toLowerCase()) ||
        l.type === listing.type
      )).slice(0, 4);
    const row = document.getElementById('similarListingsRow');
    const grid = document.getElementById('similarListingsGrid');
    if (!row || !grid) return;
    const titleEl = row.querySelector('.slr-title');
    if (titleEl) titleEl.textContent = 'Properties you might also like';
    if (!similar.length) { row.classList.remove('show'); return; }
    grid.innerHTML = similar.map(l => `
      <div class="lcard" onclick="openDetail('${l.id}')" style="margin:0">
        <div class="lcard-photo" style="height:140px">
          <img src="${l.photo}" alt="${esc(l.title || l.name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="onImgError(this)">
        </div>
        <div class="lcard-body" style="padding:12px 14px 14px">
          <div class="lcard-tags" style="margin-bottom:6px;">
            ${(l.amenities || []).slice(0,2).map(a => `<span class="ltag">${amenityIcon(a)} ${esc(a)}</span>`).join('')}
          </div>
          <div class="lcard-title" style="font-size:14px;margin-bottom:8px">${esc(l.title || l.name)}</div>
          <div class="lcard-footer">
            <div class="lcard-price" style="font-size:18px">$${l.rent}<sub>${sameRole === 'lodge' ? '/night' : '/mo'}</sub></div>
            <div class="lcard-avail" style="font-size:11px">${(l.location || '').split(',')[0]}</div>
          </div>
        </div>
      </div>`).join('');
    row.classList.add('show');
  }

  // ── Lodge owner banner ──
  function showLodgeOwnerBanner(city) {
    const banner = document.getElementById('lodgeOwnerBanner');
    if (!banner) return;
    const sub = document.getElementById('lobSub');
    if (sub && city) {
      sub.textContent = `List your ${city} property and start receiving bookings via WhatsApp today.`;
    } else if (sub) {
      sub.textContent = 'List your property and start receiving bookings via WhatsApp today.';
    }
    banner.classList.add('show');
  }

  // ── Card tap animation ──
  function animateCardTap(el) {
    el.classList.add('tapping');
    setTimeout(() => el.classList.remove('tapping'), 260);
  }

  // Public API
  return {
    saveFilters, restoreFilters, saveScrollPos,
    saveForm, clearSavedForm, checkFormRestore, restoreForm, discardDraft,
    clearDraftTimer: function() { _clearDraftTimer(); _hideBanner(); },
    applyDefaultTab, prefillWANumber, persistWANumber,
    getUpcomingWeekend, trackLodgeView,
    onFav, onListingView,
    onCitySelected,
    launchConfetti, richToast,
    showYouMightLike, showSimilarListings,
    showLodgeOwnerBanner, animateCardTap,
    trackViewedType,
    get phoneVerified() { return phoneVerified; },
    get lastLodgeCity() { return lastLodgeCity; },
    set lastLodgeCity(v) { lastLodgeCity = v; ss('rc_last_lodge_city', v); },
  };
})();

// Standalone sessionStorage helper for use in non-RC functions
function ss(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch(e){} }

// ══════════════════════════════════════
//  STATE
// ══════════════════════════════════════
let currentRole = null, currentStep = 1, selectedCategory = null, uploadedPhotos = [];
var myListings = window.myListings; // alias for use in this script block
let _pendingPhotoSrc = null;
let _flowDirection = 1;
const TOTAL_STEPS = 7;
const STEP_LABELS = ['Choose Category','Property Type','Who & Amenities','Amenities Review','Property Details','Photos','Review & Submit'];

// Type → photo mapping
const TYPE_PHOTOS = {
  'Single Room':    'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=700&q=80&auto=format&fit=crop',
  'Self-Contained': 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=700&q=80&auto=format&fit=crop',
  'Full Apartment': 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=700&q=80&auto=format&fit=crop',
  'Shared House':   'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=700&q=80&auto=format&fit=crop',
  'Full House':     'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=700&q=80&auto=format&fit=crop',
  'Cottage':        'https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=700&q=80&auto=format&fit=crop',
};

// Listings array — shared with Supabase helpers declared in the first script block
// (do not use const here; use the global window.listings set up earlier)
var listings = window.listings; // alias for use in this script block

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════
function showPage(id, _fromPopstate) {
  // Save scroll before leaving browse page
  const activePage = document.querySelector('.page.active');
  if (activePage && activePage.id === 'pg-browse') RC.saveScrollPos();
  // FIX 2: clear draft timer when navigating away from landlord page
  if (activePage && activePage.id === 'pg-landlord' && id !== 'pg-landlord') {
    RC.clearDraftTimer();
  }
  // Hide lodge owner banner when navigating away from lodges
  if (id !== 'pg-lodges') {
    const lob = document.getElementById('lodgeOwnerBanner');
    if (lob) lob.classList.remove('show');
  }

  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
  const pg = document.getElementById(id);
  if (!pg) { console.error(`showPage: no element with id "${id}"`); return; }
  const isFlex = ['pg-landing','pg-success','pg-lodge-success'].includes(id);
  pg.style.display = isFlex ? 'flex' : 'block';
  setTimeout(() => pg.classList.add('active'), 10);

  // Restore browse filters/scroll when going to browse
  if (id === 'pg-browse') {
    setTimeout(() => RC.restoreFilters(), 30);
  }

  // Hide similar listings row when leaving detail page
  if (id !== 'pg-detail') {
    const slr = document.getElementById('similarListingsRow');
    if (slr) slr.classList.remove('show');
    document.getElementById('listingSuccessBanner')?.classList.remove('show');
  }

  window.scrollTo(0, 0);

  // ── BACK-BUTTON FIX ──
  // Push a real browser history entry for every in-app navigation so the
  // phone/browser back button steps back through app pages instead of
  // immediately exiting the site. Skip pushing when this call was itself
  // triggered by a popstate event (i.e. the user already pressed back),
  // otherwise we'd create a new forward entry and break the back button.
  if (!_fromPopstate) {
    if (history.state && history.state.page === id) {
      // Same page re-render (e.g. initial load) — keep history in sync without duplicating.
      history.replaceState({ page: id }, '', '#' + id);
    } else {
      history.pushState({ page: id }, '', '#' + id);
    }
  }
}

// ── FIX 3: Footer visibility helper ──
function updateFooterVisibility() {
  const footer = document.getElementById('siteFooter');
  if (!footer) return;
  const activePage = document.querySelector('.page.active');
  const hideOnPages = ['pg-landlord','pg-detail','pg-mylistings','pg-lodge-list','pg-booking'];
  if (activePage && hideOnPages.includes(activePage.id)) {
    footer.style.display = 'none';
  } else {
    footer.style.display = ''; // FIX 3: use empty string not 'block'
  }
}

// ── FIX 2, 3, 5, 8: popstate listener ──
// BACK-BUTTON FIX: this now actually renders the page the user navigated
// back (or forward) to, using the state pushed by showPage(). Previously
// this listener only ran cosmetic cleanup and never called showPage() at
// all, and showPage() never pushed history entries — so the browser only
// ever had one history entry for the whole app and the very first back
// press exited the site instead of stepping back through in-app pages.
window.addEventListener('popstate', function(e) {
  const pageId = (e.state && e.state.page) || 'pg-landing';

  // Actually switch to the page the user went back/forward to.
  showPage(pageId, /* _fromPopstate */ true);

  // FIX 3: restore footer on back nav
  updateFooterVisibility();
  // FIX 2 & 8: clear draft timer when leaving landlord page
  if (pageId !== 'pg-landlord') {
    RC.clearDraftTimer();
  }
  // FIX 5: restore filters on back nav to browse/lodges
  if (pageId === 'pg-browse') {
    RC.restoreFilters();
  }
  if (pageId === 'pg-lodges') {
    filterLodges();
  }
});

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const offset = 80; // account for sticky headers
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: 'smooth' });
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ══════════════════════════════════════
//  ZIMBABWE LOCATION DATA
// ══════════════════════════════════════


const ZW_LOCATIONS = {
  "Harare": {
    "Avondale": ["Avondale West","Avondale Centre","Emerald Hill","Borrowdale Road"],
    "Borrowdale": ["Borrowdale Brooke","The Chase","Shawasha Hills","Highlands"],
    "Greendale": ["Greendale North","Greendale South","Msasa","Msasa Park"],
    "Glen View": ["Glen View 1","Glen View 2","Glen View 3","Glen View 4","Glen View 5","Glen View 6","Glen View 7","Glen View 8"],
    "Budiriro": ["Budiriro 1","Budiriro 2","Budiriro 3","Budiriro 4","Budiriro 5"],
    "Mbare": ["Mbare Flats","Matapi Flats","Stodart","Rufaro"],
    "Highfield": ["Highfield A","Highfield B","Highfield C","Machipisa","Overspill"],
    "Warren Park": ["Warren Park 1","Warren Park 2","Warren Park D"],
    "Chitungwiza": ["Unit A","Unit B","Unit C","Unit D","Unit E","Unit F","Unit G","Unit H","Unit J","Unit K","Unit L","Unit M","Makoni"],
    "Kuwadzana": ["Kuwadzana 1","Kuwadzana 2","Kuwadzana 3","Kuwadzana 4","Kuwadzana Extension"],
    "Mabvuku": ["Mabvuku North","Mabvuku South","Tafara 1","Tafara 2","Tafara 3"],
    "Hatcliffe": ["Hatcliffe Extension","Hatcliffe Village","Whitecliffe"],
    "Dzivarasekwa": ["Dzivarasekwa 1","Dzivarasekwa 2","Dzivarasekwa 3","Dzivarasekwa Extension"],
    "Epworth": ["Epworth Ward 1","Epworth Ward 2","Epworth Ward 3","Epworth Ward 4","Epworth Ward 5"],
    "Mount Pleasant": ["Mount Pleasant Heights","Mount Pleasant East","Glenara Estates"],
    "Waterfalls": ["Waterfalls East","Waterfalls West","Hatfield"],
    "Eastlea": ["Eastlea South","Eastlea North","Belgravia"],
    "Arcadia": ["Arcadia Extension","Glen Lorne","Chisipite"],
    "Braeside": ["Braeside","Ardbennie","Willowvale"],
    "Sunningdale": ["Sunningdale 1","Sunningdale 2","Sunningdale 3"],
    "Zengeza": ["Zengeza 1","Zengeza 2","Zengeza 3","Zengeza 4","Zengeza 5"],
    "Hopley": ["Hopley Farm A","Hopley Farm B","Hopley Farm C"],
    "CBD Harare": ["First Street","Samora Machel Ave","Jason Moyo Ave","Nelson Mandela Ave","Leopold Takawira"],
    "Kambuzuma": ["Kambuzuma 1","Kambuzuma 2","Kambuzuma 3","Kambuzuma 4","Kambuzuma 5","Kambuzuma 6"],
    "Tynwald": ["Tynwald North","Tynwald South","Westlea"],
    "Rugare": ["Rugare 1","Rugare 2","Rugare 3"],
    "Msasa": ["Msasa Park","Msasa Industrial","Msasa North"],
    "St Martins": ["St Martins","Coldstream","Caledonia Farm"]
  },
  "Bulawayo": {
    "Suburbs": ["Suburbs North","Suburbs South","Suburbs Central"],
    "Nkulumane": ["Nkulumane 1","Nkulumane 2","Nkulumane 3","Nkulumane 4","Nkulumane 5","Nkulumane 6","Nkulumane 7","Nkulumane 8","Nkulumane 9","Nkulumane 10","Nkulumane 11","Nkulumane 12"],
    "Magwegwe": ["Magwegwe North","Magwegwe South","Magwegwe West"],
    "Emganwini": ["Emganwini 1","Emganwini 2","Emganwini 3"],
    "Sizinda": ["Sizinda 1","Sizinda 2","Sizinda 3"],
    "Lobengula": ["Lobengula East","Lobengula West","Mzilikazi"],
    "Makokoba": ["Makokoba Central","Stanley Square","Mguza"],
    "Njube": ["Njube 1","Njube 2","Njube 3"],
    "Cowdray Park": ["Cowdray Park Ward 1","Cowdray Park Ward 2","Cowdray Park Ward 3","Cowdray Park Extension"],
    "Entumbane": ["Entumbane 1","Entumbane 2","Entumbane 3","Entumbane 4"],
    "Tshabalala": ["Tshabalala 1","Tshabalala 2","Tshabalala 3","Tshabalala 4"],
    "Belmont": ["Belmont North","Belmont South","Belmont Industrial"],
    "Hillside": ["Hillside North","Hillside South","Queens Park"],
    "Burnside": ["Burnside East","Burnside West","Burnside Central"],
    "Mahatshula": ["Mahatshula North","Mahatshula South","Mahatshula East"],
    "Pumula": ["Pumula East","Pumula West","Pumula North"],
    "Luveve": ["Luveve 1","Luveve 2","Luveve 3","Luveve 4","Luveve 5","Luveve 6","Luveve 7"],
    "CBD Bulawayo": ["Main Street","8th Avenue","9th Avenue","Fort Street","Fife Street"],
    "Iminyela": ["Iminyela","Old Pumula","Pumula South"]
  },
  "Masvingo": {
    "Masvingo CBD": ["Central Ward 1","Central Ward 2","Central Ward 3"],
    "Mucheke": ["Mucheke A","Mucheke B","Mucheke C","Mucheke D"],
    "Rujeko": ["Rujeko A","Rujeko B","Rujeko C","Rujeko D"],
    "Rhodene": ["Rhodene North","Rhodene South","Rhodene East"],
    "Eastvale": ["Eastvale West","Eastvale East"],
    "Runyararo": ["Runyararo West","Runyararo East"],
    "Shagashe": ["Shagashe River Side","Shagashe Farm"],
    "Zimre Park": ["Zimre Park A","Zimre Park B","Zimre Park C"],
    "Longdale": ["Longdale Extension","Longdale Village"]
  },
  "Mutare": {
    "Mutare CBD": ["Herbert Chitepo Street","Main Street","Robert Mugabe Avenue"],
    "Dangamvura": ["Dangamvura 1","Dangamvura 2","Dangamvura 3","Dangamvura 4","Dangamvura 5","Dangamvura 6","Dangamvura 7"],
    "Sakubva": ["Sakubva 1","Sakubva 2","Sakubva 3","Sakubva 4","Sakubva 5"],
    "Chikanga": ["Chikanga 1","Chikanga 2","Chikanga 3"],
    "Hobhouse": ["Hobhouse North","Hobhouse South"],
    "Fairbridge": ["Fairbridge Park","Fairbridge Heights"],
    "Palmerstone": ["Palmerstone East","Palmerstone West"],
    "Yeovil": ["Yeovil East","Yeovil West"],
    "Greenside": ["Greenside Estate","Greenside Extension"]
  },
  "Gweru": {
    "Gweru CBD": ["Main Street","Fourth Street","Seventh Street","Lobengula Avenue"],
    "Mkoba": ["Mkoba 1","Mkoba 2","Mkoba 3","Mkoba 4","Mkoba 5","Mkoba 6","Mkoba 7","Mkoba 8","Mkoba 9","Mkoba 10","Mkoba 11","Mkoba 12","Mkoba 13","Mkoba 14","Mkoba 15","Mkoba 16","Mkoba 17","Mkoba 18","Mkoba 19","Mkoba Village"],
    "Senga": ["Senga North","Senga South","Senga Extension"],
    "Woodlands": ["Woodlands East","Woodlands West"],
    "Nehanda": ["Nehanda 1","Nehanda 2","Nehanda 3"],
    "Ascot": ["Ascot East","Ascot West","Ascot Racecourse"],
    "Kopje": ["Kopje Hill","Kopje Extension"],
    "Ridgemont": ["Ridgemont East","Ridgemont West"]
  },
  "Chinhoyi": {
    "Chinhoyi CBD": ["Central Ward","Pioneer Avenue","Chipadze Road"],
    "Chipadze": ["Chipadze 1","Chipadze 2","Chipadze 3","Chipadze 4"],
    "Chibondo": ["Chibondo East","Chibondo West","Chibondo Extension"],
    "Chinhoyi Expansion": ["Expansion Area A","Expansion Area B","Expansion Area C"],
    "Manyame": ["Manyame 1","Manyame 2","Manyame 3"],
    "Madziva": ["Madziva Village","Madziva Extension"]
  },
  "Bindura": {
    "Bindura CBD": ["Central Bindura","Market Square","Bindura Mall Area"],
    "Chipadze Bindura": ["Chipadze Phase 1","Chipadze Phase 2","Chipadze Phase 3"],
    "Chiwaridzo": ["Chiwaridzo 1","Chiwaridzo 2","Chiwaridzo 3","Chiwaridzo 4"],
    "Manditsvara": ["Manditsvara East","Manditsvara West"],
    "Chiuya": ["Chiuya North","Chiuya South"],
    "Bindura Extension": ["Extension A","Extension B","Extension C"]
  },
  "Kwekwe": {
    "Kwekwe CBD": ["Main Street","First Avenue","Goldfields Road"],
    "Mbizo": ["Mbizo 1","Mbizo 2","Mbizo 3","Mbizo 4","Mbizo 5","Mbizo 6","Mbizo 7","Mbizo 8","Mbizo 9","Mbizo 10","Mbizo 11","Mbizo 12","Mbizo 13","Mbizo 14"],
    "Newtown": ["Newtown East","Newtown West","Newtown Extension"],
    "Amaveni": ["Amaveni 1","Amaveni 2","Amaveni 3","Amaveni 4","Amaveni 5"],
    "Wetlands": ["Wetlands North","Wetlands South"],
    "Globe and Phoenix": ["Globe and Phoenix Township","Globe and Phoenix Extension"]
  },
  "Kadoma": {
    "Kadoma CBD": ["Central Ward","Lobengula Road","Harare Road Junction"],
    "Rimuka": ["Rimuka 1","Rimuka 2","Rimuka 3","Rimuka 4","Rimuka 5"],
    "Ngezi": ["Ngezi North","Ngezi South","Ngezi Extension"],
    "Allandale": ["Allandale East","Allandale West"],
    "Kadoma Extension": ["Extension 1","Extension 2","Extension 3"]
  },
  "Zvishavane": {
    "Zvishavane CBD": ["Central","Station Road","Mine Road"],
    "Mandava": ["Mandava 1","Mandava 2","Mandava 3","Mandava 4","Mandava 5"],
    "Makore": ["Makore 1","Makore 2","Makore 3"],
    "Shurugwi Road Area": ["Shurugwi Road Ward 1","Shurugwi Road Ward 2"],
    "Mimosa": ["Mimosa Mine Area","Mimosa Extension"]
  },
  "Victoria Falls": {
    "Victoria Falls CBD": ["Livingstone Way","Parkway Drive","Pioneer Road"],
    "Chinotimba": ["Chinotimba 1","Chinotimba 2","Chinotimba 3","Chinotimba 4","Chinotimba 5","Chinotimba 6"],
    "Mkhosana": ["Mkhosana 1","Mkhosana 2","Mkhosana 3","Mkhosana 4","Mkhosana 5"],
    "Aerodrome": ["Aerodrome Ward","Airport Road Area"],
    "Vic Falls Resort Area": ["Resort Ward A","Resort Ward B","Elephant Hills Area"]
  },
  "Kariba": {
    "Kariba CBD": ["Central Ward","Nyamhunga Road","Lake Drive"],
    "Nyamhunga": ["Nyamhunga 1","Nyamhunga 2","Nyamhunga 3","Nyamhunga 4","Nyamhunga 5","Nyamhunga 6","Nyamhunga 7"],
    "Mahombekombe": ["Mahombekombe 1","Mahombekombe 2","Mahombekombe 3"],
    "Andora Harbour": ["Andora Bay","Harbour View","Lakeside"],
    "Kariba Heights": ["Heights East","Heights West"]
  },
  "Nyanga": {
    "Nyanga Township": ["Nyanga Central","Nyanga North","Nyanga South"],
    "Ruwangwe": ["Ruwangwe 1","Ruwangwe 2","Ruwangwe 3"],
    "Juliasdale": ["Juliasdale Village","Pine Tree Inn Area","Nyanga Downs"],
    "Troutbeck": ["Troutbeck Inn Area","Troutbeck Village"],
    "Nyamatikiti": ["Nyamatikiti East","Nyamatikiti West"]
  },
  "Bvumba": {
    "Bvumba Heights": ["Bvumba Heights East","Bvumba Heights West","Clouds End Area"],
    "Mutare Rural": ["Panorama Estate","Tigers Kloof","Castle Beacon"],
    "Bvumba Road": ["Bvumba Road Ward","Essex Valley"]
  },
  "Rusape": {
    "Rusape CBD": ["Main Street","Gordon Avenue","Headlands Road"],
    "Vengere": ["Vengere 1","Vengere 2","Vengere 3","Vengere 4","Vengere 5","Vengere 6","Vengere 7"],
    "Sakubva Rusape": ["Sakubva North","Sakubva South","Sakubva Extension"],
    "Rusape Extension": ["Extension A","Extension B","Extension C"],
    "Zimunya": ["Zimunya 1","Zimunya 2","Zimunya 3"]
  },
  "Chiredzi": {
    "Chiredzi CBD": ["Central","Triangle Road","Chiredzi Town"],
    "Mkwasine": ["Mkwasine 1","Mkwasine 2","Mkwasine 3"],
    "Triangle": ["Triangle Village","Triangle Estate","Triangle Extension"],
    "Tshovani": ["Tshovani 1","Tshovani 2","Tshovani 3","Tshovani 4"],
    "Hippo Valley": ["Hippo Valley Estate","Hippo Valley Extension"]
  }
};

let locState = { city: null, suburb: null, ward: null };

function initLocationSelector() { populateCityDropdown(); }

function populateCityDropdown(filter) {
  const dd = document.getElementById('cityDropdown'); if (!dd) return;
  const cities = Object.keys(ZW_LOCATIONS).sort();
  const q = (filter||'').toLowerCase().trim();
  const filtered = q ? cities.filter(c => c.toLowerCase().includes(q)) : cities;
  if (!filtered.length) { dd.innerHTML = '<div class="loc-no-results">No city found</div>'; return; }
  dd.innerHTML = filtered.map(c => '<div class="loc-opt" onclick="selectCity(\''+c+'\')"><span class="loc-opt-icon">🏙️</span>'+c+'</div>').join('');
}

function populateSuburbDropdown(city, filter) {
  const dd = document.getElementById('suburbDropdown'); if (!dd||!city) return;
  const suburbs = Object.keys(ZW_LOCATIONS[city]||{}).sort();
  const q = (filter||'').toLowerCase().trim();
  const filtered = q ? suburbs.filter(s => s.toLowerCase().includes(q)) : suburbs;
  if (!filtered.length) { dd.innerHTML = '<div class="loc-no-results">No suburb found</div>'; return; }
  dd.innerHTML = filtered.map(s => '<div class="loc-opt" onclick="selectSuburb(\''+s.replace(/'/g,"\\'")+'\')"><span class="loc-opt-icon">🏘️</span>'+s+'</div>').join('');
}

function populateWardDropdown(city, suburb, filter) {
  const dd = document.getElementById('wardDropdown'); if (!dd||!city||!suburb) return;
  const wards = (ZW_LOCATIONS[city]&&ZW_LOCATIONS[city][suburb] ? ZW_LOCATIONS[city][suburb].slice().sort() : []);
  const q = (filter||'').toLowerCase().trim();
  const filtered = q ? wards.filter(w => w.toLowerCase().includes(q)) : wards;
  if (!filtered.length) { dd.innerHTML = '<div class="loc-no-results">No ward found</div>'; return; }
  dd.innerHTML = filtered.map(w => '<div class="loc-opt" onclick="selectWard(\''+w.replace(/'/g,"\\'")+'\')"><span class="loc-opt-icon">📍</span>'+w+'</div>').join('');
}

function filterCityOptions() { const q=document.getElementById('fCitySearch')?.value||''; populateCityDropdown(q); showLocDropdown('city'); }
function filterSuburbOptions() { const q=document.getElementById('fSuburbSearch')?.value||''; populateSuburbDropdown(locState.city,q); showLocDropdown('suburb'); }
function filterWardOptions() { const q=document.getElementById('fWardSearch')?.value||''; populateWardDropdown(locState.city,locState.suburb,q); showLocDropdown('ward'); }

function showLocDropdown(level) {
  if (level==='city') { populateCityDropdown(document.getElementById('fCitySearch')?.value); document.getElementById('cityDropdown')?.classList.add('open'); }
  if (level==='suburb'&&locState.city) { populateSuburbDropdown(locState.city,document.getElementById('fSuburbSearch')?.value); document.getElementById('suburbDropdown')?.classList.add('open'); }
  if (level==='ward'&&locState.suburb) { populateWardDropdown(locState.city,locState.suburb,document.getElementById('fWardSearch')?.value); document.getElementById('wardDropdown')?.classList.add('open'); }
}
function hideLocDropdown(level,delay) {
  setTimeout(()=>{
    if (level==='city') document.getElementById('cityDropdown')?.classList.remove('open');
    if (level==='suburb') document.getElementById('suburbDropdown')?.classList.remove('open');
    if (level==='ward') document.getElementById('wardDropdown')?.classList.remove('open');
  }, delay||200);
}

function selectCity(city) {
  locState={city,suburb:null,ward:null};
  document.getElementById('fCitySearch').value=city;
  document.getElementById('cityDropdown').classList.remove('open');
  const sl=document.getElementById('suburbLevel'); if(sl){sl.style.opacity='1';sl.style.pointerEvents='auto';}
  const fSub=document.getElementById('fSuburbSearch'); if(fSub){fSub.value='';fSub.placeholder='Search suburb in '+city+'…';}
  const wl=document.getElementById('wardLevel'); if(wl){wl.style.opacity='0.4';wl.style.pointerEvents='none';}
  const fWard=document.getElementById('fWardSearch'); if(fWard){fWard.value='';fWard.placeholder='Select suburb first…';}
  updateLocPill();
  // Smart suburb suggestion
  RC.onCitySelected(city);
}

function selectSuburb(suburb) {
  locState.suburb=suburb; locState.ward=null;
  document.getElementById('fSuburbSearch').value=suburb;
  document.getElementById('suburbDropdown').classList.remove('open');
  const wl=document.getElementById('wardLevel'); if(wl){wl.style.opacity='1';wl.style.pointerEvents='auto';}
  const fWard=document.getElementById('fWardSearch'); if(fWard){fWard.value='';fWard.placeholder='Search ward/section in '+suburb+'…';}
  populateWardDropdown(locState.city,suburb);
  updateLocPill();
}

function selectWard(ward) {
  locState.ward=ward;
  document.getElementById('fWardSearch').value=ward;
  document.getElementById('wardDropdown').classList.remove('open');
  updateLocPill();
}

function updateLocPill() {
  const pill=document.getElementById('locSelectedPill');
  const txt=document.getElementById('locSelectedText');
  const hidden=document.getElementById('fLocation');
  if (!locState.city) { if(pill)pill.style.display='none'; if(hidden)hidden.value=''; return; }
  let loc=locState.city;
  if (locState.suburb) loc=locState.suburb+', '+locState.city;
  if (locState.ward) loc=locState.ward+', '+locState.suburb+', '+locState.city;
  if(txt)txt.textContent=loc;
  if(pill)pill.style.display='flex';
  if(hidden)hidden.value=loc;
}

function clearLocation() {
  locState={city:null,suburb:null,ward:null};
  ['fCitySearch','fSuburbSearch','fWardSearch'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const fSub=document.getElementById('fSuburbSearch'); if(fSub)fSub.placeholder='Select city first…';
  const fWard=document.getElementById('fWardSearch'); if(fWard)fWard.placeholder='Select suburb first…';
  const sl=document.getElementById('suburbLevel'); if(sl){sl.style.opacity='0.4';sl.style.pointerEvents='none';}
  const wl=document.getElementById('wardLevel'); if(wl){wl.style.opacity='0.4';wl.style.pointerEvents='none';}
  const pill=document.getElementById('locSelectedPill'); if(pill)pill.style.display='none';
  const hidden=document.getElementById('fLocation'); if(hidden)hidden.value='';
  ['cityDropdown','suburbDropdown','wardDropdown'].forEach(id=>document.getElementById(id)?.classList.remove('open'));
}

function formatPhone(raw) {
  let n = raw.replace(/\D/g, '');
  if (n.startsWith('0')) n = '263' + n.slice(1);
  if (!n.startsWith('263')) n = '263' + n;
  return '+' + n;
}

// Valid Zimbabwean mobile prefixes (Econet 077/078, NetOne 071, Telecel 073)
const ZW_MOBILE_PREFIXES = ['071','073','077','078'];
function isValidZwPhone(digits10) {
  // digits10 must be exactly 10 digits starting with a known ZW mobile prefix
  if (!digits10 || digits10.length !== 10) return false;
  return ZW_MOBILE_PREFIXES.some(p => digits10.startsWith(p));
}

function updateNav(role, context) {
  const badge = document.getElementById('navBadge');
  const btnMyL = document.getElementById('btnMyListings');
  const btnPost = document.getElementById('btnListProp');
  const btnListLodge = document.getElementById('btnListLodge');
  if (btnListLodge) btnListLodge.style.display = 'none';
  if (!role && context !== 'lodge') {
    if (badge) badge.style.display = 'none';
    if (btnMyL) btnMyL.style.display = 'none';
    // Always show List Property button on landing/browse
    if (btnPost) btnPost.style.display = 'block';
    return;
  }
  if (context === 'lodge') {
    if (badge) { badge.style.display = 'block'; badge.className = 'nav-badge';
    badge.style.background = 'rgba(245,158,11,0.1)'; badge.style.color = '#D97706';
    badge.style.borderColor = 'rgba(245,158,11,0.3)'; badge.textContent = '🏨 Lodges'; }
    if (btnListLodge) btnListLodge.style.display = 'none';
    if (btnMyL) btnMyL.style.display = 'none';
    if (btnPost) { btnPost.style.display = 'block'; }
    return;
  }
  if (badge) { badge.style.display = 'block'; badge.style.background = ''; badge.style.color = ''; badge.style.borderColor = '';
  badge.className = 'nav-badge nb-' + role;
  badge.textContent = { student: '🎓 Student', tenant: '🏠 Tenant', landlord: '🔑 Landlord' }[role] || ''; }
  if (btnMyL) btnMyL.style.display = role === 'landlord' ? 'block' : 'none';
  // Show List Property button for non-landlord roles; hide when in listing flow
  if (btnPost) btnPost.style.display = (role === 'landlord') ? 'none' : 'block';
}

// ══════════════════════════════════════
//  LANDLORD DROPDOWN
// ══════════════════════════════════════
function showLandlordDropdown() {
  const btn = document.getElementById('landlordNavBtn');
  if (btn) btn.style.display = 'block';
}

function toggleLandlordDropdown() {}
function closeLandlordDropdown() {}

function updateLandlordStats() {
  const propListings = myListings.filter(l => l.role !== 'lodge' && l.category !== 'lodge');
  const lodgeListings = myListings.filter(l => l.role === 'lodge' || l.category === 'lodge');
  const total = myListings.length + myLodges.filter(l => !myListings.find(ml => ml.id === l.id)).length;
  const props = propListings.length;
  const lodges = myLodges.length;

  // Dashboard page stats
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('dashStatTotal', total);
  el('dashStatProps', props);
  el('dashStatLodges', lodges);
  el('dashStatActive', total);
}

// Dropdown removed - My Listings button now navigates directly

// ══════════════════════════════════════
//  DASHBOARD PAGE
// ══════════════════════════════════════
function openDashboard() {
  updateLandlordStats();
  const panel = document.getElementById('dashListingsPanel');
  if (!panel) return;

  const propListings = myListings.filter(l => l.role !== 'lodge' && l.category !== 'lodge');
  const lodgeListings = myLodges;

  if (propListings.length === 0 && lodgeListings.length === 0) {
    panel.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">🏠</div>
        <div class="dash-empty-title">No listings yet</div>
        <div class="dash-empty-sub">Add your first property or lodge to get started</div>
        <button class="dash-empty-btn" onclick="openListingFlow()">+ Add Your First Listing</button>
      </div>`;
  } else {
    let html = '';
    if (propListings.length > 0) {
      html += `<div style="font-size:13px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;">🏡 Properties (${propListings.length})</div>`;
      html += `<div class="listings-grid" style="padding:0;margin-bottom:28px;">`;
      propListings.forEach(l => {
        html += buildMyListingCard(l);
      });
      html += `</div>`;
    }
    if (lodgeListings.length > 0) {
      html += `<div style="font-size:13px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;margin-top:8px;">🏨 Lodges (${lodgeListings.length})</div>`;
      html += `<div class="listings-grid" style="padding:0;">`;
      lodgeListings.forEach(l => {
        html += `<div class="lcard" style="cursor:default;">
          <div class="lcard-photo"><img src="${l.photo||''}" alt="${esc(l.name)}" loading="lazy" onerror="onImgError(this)"></div>
          <div class="lcard-body" style="padding:14px 16px 16px;">
            <div class="lcard-title">${esc(l.name)}</div>
            <div class="lcard-loc">📍 ${esc(l.location)}</div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
              <button onclick="openLodgeDetail('${l.id}')" style="flex:1;padding:8px;border-radius:var(--r-sm);background:var(--depth3);border:1px solid var(--seam2);font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;cursor:pointer;color:var(--text-secondary);">View</button>
              <button onclick="deleteMyLodge('${l.id}')" style="padding:8px 12px;border-radius:var(--r-sm);background:none;border:1px solid rgba(220,38,38,0.2);font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;cursor:pointer;color:var(--danger);">Delete</button>
            </div>
          </div>
        </div>`;
      });
      html += `</div>`;
    }
    panel.innerHTML = html;
  }
  showPage('pg-dashboard');
}

function buildMyListingCard(l) {
  return `<div class="lcard" style="cursor:default;">
    <div class="lcard-photo">
      <img src="${l.photo||''}" alt="${esc(l.title)}" onerror="onImgError(this)">
      <div class="lcard-photo-grad"></div>
      <div class="lcard-badges">
        ${l.verified ? '<span class="lbadge-verified">✓ Verified</span>' : '<span style="background:rgba(0,0,0,0.5);color:rgba(255,255,255,0.8);padding:3px 8px;border-radius:100px;font-size:10px;font-weight:700;">Pending</span>'}
      </div>
    </div>
    <div class="lcard-body" style="padding:14px 16px 16px;">
      <div class="lcard-title">${esc(l.title)}</div>
      <div class="lcard-loc">📍 ${esc(l.location)}</div>
      <div class="lcard-meta" style="margin-top:6px;font-size:12px;color:var(--text-tertiary);">${esc(l.type)} · ${l.rooms} room${l.rooms!==1?'s':''}</div>
      <div class="lcard-price" style="margin-top:8px;font-size:16px;font-weight:800;color:var(--text-primary);">$${l.rent}<span style="font-size:11px;font-weight:500;color:var(--text-tertiary);">/mo</span></div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button onclick="openDetail('${l.id}')" style="flex:1;padding:8px;border-radius:var(--r-sm);background:var(--depth3);border:1px solid var(--seam2);font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;cursor:pointer;color:var(--text-secondary);">View</button>
        <button onclick="Auth.deleteListing('${l.id}')" style="padding:8px 12px;border-radius:var(--r-sm);background:none;border:1px solid rgba(220,38,38,0.2);font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;cursor:pointer;color:var(--danger);">Delete</button>
      </div>
    </div>
  </div>`;
}

function goHome() {
  currentRole = null;
  updateNav(null, null);
  // Show List Property on landing page
  const btnPost = document.getElementById('btnListProp');
  if (btnPost) btnPost.style.display = 'block';
  showPage('pg-landing');
}

function goBack() {
  const currentPage = document.querySelector('.page.active');
  const pageId = currentPage ? currentPage.id : null;
  if (pageId === 'pg-detail') {
    const from = window._lastBrowsePage;
    const safePages = ['pg-browse','pg-dashboard','pg-mylistings','pg-landing','pg-lodges'];
    showPage(safePages.includes(from) ? from : 'pg-browse');
  } else if (pageId === 'pg-lodge-detail') {
    const from = window._lastBrowsePage;
    const safePages = ['pg-lodges','pg-browse','pg-dashboard','pg-mylistings','pg-landing'];
    if (safePages.includes(from)) showPage(from);
    else showLodges();
  } else if (pageId === 'pg-booking') {
    if (currentLodgeId) { openLodgeDetail(currentLodgeId); } else { showLodges(); }
  } else if (pageId === 'pg-success') {
    goHome();
  } else if (pageId === 'pg-mylistings') {
    goHome();
  } else if (pageId === 'pg-landlord') {
    // Step back through the listing flow; step 1 goes home
    flowPrev();
  } else if (pageId === 'pg-lodge-list') {
    lodgeFlowPrevFn();
  } else {
    goHome();
  }
}

// ══════════════════════════════════════
//  ROLE
// ══════════════════════════════════════
function openListingFlow(preserveState) {
  if (!preserveState) {
    // Reset all previous selections
    selectedCategory = null;
    currentStep = 1;
    _flowDirection = 1;
    document.querySelectorAll('.catcard').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.tcard').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('#fs3 .chip').forEach(e => {
      e.classList.remove('on');
      const i = e.querySelector('.chip-ico'); if (i) i.style.transform = '';
    });
    uploadedPhotos = [];
    _pendingPhotoSrc = null;
    window._pendingPhotoFile = null;
    window._confirmedPhotoFile = null;
    ['fTitle','fRent','fRooms','fPhone','fDesc','fUniversity','fUniversityVal','fStudentsPerRoom',
     'fHourlyRate','fDayRate','fNightRate','fWeeklyRate'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    clearLocation && clearLocation();
  }
  // Reset photo UI (only when not preserving state)
  if (!preserveState) setTimeout(() => {
    const picker = document.getElementById('photoPickerArea');
    const preview = document.getElementById('waPhotoPreview');
    const confirmed = document.getElementById('photoConfirmedArea');
    if (picker) picker.style.display = 'block';
    if (preview) preview.style.display = 'none';
    if (confirmed) confirmed.style.display = 'none';
  }, 50);

  // Set landlord mode — hides List Property button, shows My Listings
  currentRole = 'landlord';
  updateNav('landlord', null);
  // But we want List Property hidden and Back visible for flow nav
  const btnPost = document.getElementById('btnListProp');
  if (btnPost) btnPost.style.display = 'none';
  const btnMyL = document.getElementById('btnMyListings');
  if (btnMyL) btnMyL.style.display = myListings.length > 0 ? 'block' : 'none';

  // Check for saved form data
  RC.checkFormRestore();

  showFlowStep(1);
  showPage('pg-landlord');
  setTimeout(() => {
    initLocationSelector && initLocationSelector();
    RC.prefillWANumber();
  }, 50);
}

function setRole(role, preserveFilters) {
  currentRole = role; updateNav(role, null);
  const tabsBar = document.getElementById('studentTabsBar');

  // Hide both filter strips first; show correct one
  document.getElementById('filter-strip-student').style.display = 'none';
  document.getElementById('filter-strip-tenant').style.display = 'none';

  if (role === 'student' || role === 'tenant') {
    document.getElementById('browseTitle').textContent =
      role === 'student' ? 'Student Rooms & Housing' : 'All Rentals Across Zimbabwe';
    if (tabsBar) tabsBar.style.display = role === 'student' ? 'block' : 'none';

    // FIX 7: only reset filters when preserveFilters is not true
    if (!preserveFilters) {
      resetFiltersForRole(role);
    }

    if (role === 'student') {
      document.getElementById('filter-strip-student').style.display = '';
      // Populate student dropdowns dynamically
      populateStudentTypeDropdown();
      populateStudentAmenityDropdown();
      // Reset student tabs
      document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
      const firstTab = document.querySelector('.stab');
      if (firstTab) firstTab.classList.add('active');
      filterStudentListings();
    } else {
      document.getElementById('filter-strip-tenant').style.display = '';
      // Populate tenant dropdowns dynamically
      populateTenantTypeDropdown();
      populateTenantAmenityDropdown();
      filterTenantListings();
    }
    showPage('pg-browse');
  } else if (role === 'landlord') {
    openListingFlow();
  } else {
    if (tabsBar) tabsBar.style.display = 'none';
    showPage('pg-browse');
  }
}

function resetFiltersForRole(role) {
  if (role === 'student') {
    ['sFilterUniversity','sFilterCity','sFilterSuburb','sFilterType',
     'sFilterRooms','sFilterStudentsPerRoom','sFilterBudget','sFilterAmenity']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const sub = document.getElementById('sFilterSuburb');
    if (sub) sub.style.display = 'none';
  } else {
    ['tFilterCity','tFilterSuburb','tFilterType','tFilterRooms','tFilterBudget','tFilterAmenity']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const sub = document.getElementById('tFilterSuburb');
    if (sub) sub.style.display = 'none';
  }
}

// ── Populate student type dropdown from CATEGORY_TYPES.student ──
function populateStudentTypeDropdown() {
  const sel = document.getElementById('sFilterType');
  if (!sel) return;
  const groups = CATEGORY_TYPES.student?.groups || [];
  const types = [...new Set(groups.flatMap(g => g.types.map(t => t.name)))].sort();
  sel.innerHTML = '<option value="">🏘 Any Type</option>' +
    types.map(t => `<option value="${t}">${t}</option>`).join('');
}

// ── Populate student amenity dropdown from ttab-students chips ──
function populateStudentAmenityDropdown() {
  const sel = document.getElementById('sFilterAmenity');
  if (!sel) return;
  const chips = document.querySelectorAll('#ttab-students .chip[data-val]');
  const amenities = [...new Set([...chips].map(c => c.dataset.val).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">✅ Any Amenity</option>' +
    amenities.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
}

// ── Populate tenant type dropdown from CATEGORY_TYPES.family ──
function populateTenantTypeDropdown() {
  const sel = document.getElementById('tFilterType');
  if (!sel) return;
  const groups = CATEGORY_TYPES.family?.groups || [];
  const types = [...new Set(groups.flatMap(g => g.types.map(t => t.name)))].sort();
  sel.innerHTML = '<option value="">🏘 Any Type</option>' +
    types.map(t => `<option value="${t}">${t}</option>`).join('');
}

// ── Populate tenant amenity dropdown from ttab-profam chips ──
function populateTenantAmenityDropdown() {
  const sel = document.getElementById('tFilterAmenity');
  if (!sel) return;
  const chips = document.querySelectorAll('#ttab-profam .chip[data-val]');
  const amenities = [...new Set([...chips].map(c => c.dataset.val).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">✅ Any Amenity</option>' +
    amenities.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
}

// ── Populate lodge dynamic dropdowns ──
let _lodgeDropdownsPopulated = false;
let _lodgeDropdownsCount = -1;
function populateLodgeDropdowns() {
  const allLodges = [...lodges, ...myLodges];
  // Skip rebuild if already populated and lodge count hasn't changed
  if (_lodgeDropdownsPopulated && allLodges.length === _lodgeDropdownsCount) return;
  _lodgeDropdownsPopulated = true;
  _lodgeDropdownsCount = allLodges.length;

  // City filter — use ALL cities from ZW_LOCATIONS (same source as listing flow)
  const citySel = document.getElementById('lFilterCity');
  if (citySel) {
    const cities = Object.keys(ZW_LOCATIONS).sort();
    citySel.innerHTML = '<option value="">📍 All Cities</option>' +
      cities.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  // Reset town dropdown
  const suburbSel = document.getElementById('lFilterSuburb');
  if (suburbSel) {
    suburbSel.innerHTML = '<option value="">🏘️ All Towns</option>';
    suburbSel.style.display = 'none';
  }
  // Type — from actual lodge data
  const typeSel = document.getElementById('lFilterType');
  if (typeSel) {
    const types = [...new Set(allLodges.map(l => l.type))].sort();
    typeSel.innerHTML = '<option value="">🏨 Any Type</option>' +
      types.map(t => `<option value="${t}">${t}</option>`).join('');
  }
  // Amenity/Features — from actual lodge data
  const amenSel = document.getElementById('lFilterAmenity');
  if (amenSel) {
    const feats = [...new Set(allLodges.flatMap(l => l.features || []))].sort();
    amenSel.innerHTML = '<option value="">✨ Any Feature</option>' +
      feats.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  }

  // Populate lodge listing form city dropdown from ZW_LOCATIONS
  const llCity = document.getElementById('llCity');
  if (llCity && llCity.options.length <= 1) {
    const cities = Object.keys(ZW_LOCATIONS).sort();
    llCity.innerHTML = '<option value="">Select city…</option>' +
      cities.map(c => `<option value="${c}">${c}</option>`).join('');
  }
}

// Called when user selects a city in the lodge listing form
function onLlCityChange() {
  const city = document.getElementById('llCity')?.value || '';
  const townSel = document.getElementById('llTown');
  const townField = document.getElementById('llTownField');
  const hidden = document.getElementById('llLocation');
  if (city && ZW_LOCATIONS[city]) {
    const towns = Object.keys(ZW_LOCATIONS[city]).sort();
    townSel.innerHTML = '<option value="">Select town… (optional)</option>' +
      towns.map(t => `<option value="${t}">${t}</option>`).join('');
    if (townField) townField.style.display = '';
  } else {
    if (townField) townField.style.display = 'none';
    if (townSel) townSel.value = '';
  }
  // Update hidden location field — "Town, City" or just "City"
  if (hidden) hidden.value = city;
  // Re-run town change in case a town was previously selected
  onLlTownChange();
}

// Called when user selects a town in the lodge listing form
function onLlTownChange() {
  const city = document.getElementById('llCity')?.value || '';
  const town = document.getElementById('llTown')?.value || '';
  const hidden = document.getElementById('llLocation');
  if (hidden) {
    hidden.value = town ? `${town}, ${city}` : city;
  }
}

// ── Helper: apply budget filter ──
function applyBudgetFilter(rent, val) {
  if (!val) return true;
  const r = rent;
  if (val === 'u50'   && r >= 50) return false;
  if (val === 'u100'  && r >= 100) return false;
  if (val === '50-100'  && (r < 50  || r > 100))  return false;
  if (val === '100-200' && (r < 100 || r > 200))  return false;
  if (val === '200-400' && (r < 200 || r > 400))  return false;
  if (val === '400-800' && (r < 400 || r > 800))  return false;
  if (val === '400+' && r <= 400) return false;
  if (val === '800+' && r <= 800) return false;
  return true;
}

// ── Helper: suburb cascade ──
function updateSuburbDropdown(citySelId, suburbSelId, filterFn) {
  const citySel   = document.getElementById(citySelId);
  const suburbSel = document.getElementById(suburbSelId);
  if (!citySel || !suburbSel) return;
  const cityVal = citySel.value;
  if (cityVal && ZW_LOCATIONS && ZW_LOCATIONS[cityVal]) {
    const suburbs = Object.keys(ZW_LOCATIONS[cityVal]).sort();
    suburbSel.innerHTML = '<option value="">🏘️ All Towns</option>' +
      suburbs.map(s => `<option value="${s}">${s}</option>`).join('');
    suburbSel.style.display = '';
  } else {
    suburbSel.innerHTML = '<option value="">🏘️ All Towns</option>';
    suburbSel.style.display = 'none';
  }
  // FIX 4: call the filter function after rebuilding options so UI stays in sync
  if (typeof filterFn === 'function') filterFn();
}

// ══════════════════════════════════════
//  STUDENT FILTER FUNCTION
// ══════════════════════════════════════
let _filterStudentRunning = false;
let _sLastCity = null;
function filterStudentListings() {
  if (_filterStudentRunning) return;
  _filterStudentRunning = true;
  try {
  // Only rebuild suburb dropdown when city actually changed
  const cityVal    = document.getElementById('sFilterCity')?.value    || '';
  if (cityVal !== _sLastCity) { updateSuburbDropdown('sFilterCity', 'sFilterSuburb', null); _sLastCity = cityVal; }
  const suburbVal  = document.getElementById('sFilterSuburb')?.value  || '';
  const typeVal    = document.getElementById('sFilterType')?.value    || '';
  const univVal    = document.getElementById('sFilterUniversity')?.value || '';
  const roomsVal   = document.getElementById('sFilterRooms')?.value   || '';
  const sprVal     = document.getElementById('sFilterStudentsPerRoom')?.value || '';
  const budgetVal  = document.getElementById('sFilterBudget')?.value  || '';
  const amenVal    = document.getElementById('sFilterAmenity')?.value  || '';

  // Deduplicate source
  const all = [...new Map([...listings, ...myListings].map(l => [l.id, l])).values()];

  const filtered = all.filter(l => {
    // Must be student role
    if (l.role && l.role !== 'student') return false;
    if (!l.role && l.forWho && l.forWho.length > 0 && !l.forWho.some(w => w === 'Students')) return false;

    const loc = (l.location || l.city || '').toLowerCase();
    if (cityVal   && !loc.includes(cityVal.toLowerCase()))   return false;
    if (suburbVal && !loc.includes(suburbVal.toLowerCase())) return false;
    if (typeVal   && l.type !== typeVal)                      return false;

    // University filter: match nearestUniversity field (partial match)
    if (univVal) {
      const uni = (l.nearestUniversity || '').toLowerCase();
      const searchTerm = univVal.split('(')[0].trim().toLowerCase();
      if (!uni.includes(searchTerm) && !uni.includes(univVal.toLowerCase())) return false;
    }

    // Rooms filter
    if (roomsVal && (l.rooms || 0) < parseInt(roomsVal)) return false;

    // Students per room filter
    if (sprVal) {
      const spr = l.studentsPerRoom || '';
      if (sprVal === '5') {
        // 5+ means 5 or more
        if (!spr || parseInt(spr) < 5) return false;
      } else {
        if (String(spr) !== String(sprVal)) return false;
      }
    }

    // Budget
    if (!applyBudgetFilter(l.rent || 0, budgetVal)) return false;

    // Amenity
    if (amenVal && !(l.amenities || []).includes(amenVal)) return false;

    return true;
  });

  renderListings(filtered);
  const rc = document.getElementById('resultCount');
  if (rc) rc.textContent = filtered.length + ' propert' + (filtered.length === 1 ? 'y' : 'ies');
  } finally {
    _filterStudentRunning = false;
  }
}

// ══════════════════════════════════════
//  TENANT FILTER FUNCTION
// ══════════════════════════════════════
let _filterTenantRunning = false;
let _tLastCity = null;
function filterTenantListings() {
  if (_filterTenantRunning) return;
  _filterTenantRunning = true;
  try {
  // Only rebuild suburb dropdown when city actually changed
  const cityVal   = document.getElementById('tFilterCity')?.value   || '';
  if (cityVal !== _tLastCity) { updateSuburbDropdown('tFilterCity', 'tFilterSuburb', null); _tLastCity = cityVal; }
  const suburbVal = document.getElementById('tFilterSuburb')?.value || '';
  const typeVal   = document.getElementById('tFilterType')?.value   || '';
  const roomsVal  = document.getElementById('tFilterRooms')?.value  || '';
  const budgetVal = document.getElementById('tFilterBudget')?.value || '';
  const amenVal   = document.getElementById('tFilterAmenity')?.value || '';

  // Deduplicate source
  const all = [...new Map([...listings, ...myListings].map(l => [l.id, l])).values()];

  const filtered = all.filter(l => {
    // Must be tenant role
    if (l.role && l.role !== 'tenant') return false;
    if (!l.role && l.forWho && l.forWho.length > 0 &&
        l.forWho.every(w => w === 'Students' || w === 'Guests')) return false;

    const loc = (l.location || l.city || '').toLowerCase();
    if (cityVal   && !loc.includes(cityVal.toLowerCase()))   return false;
    if (suburbVal && !loc.includes(suburbVal.toLowerCase())) return false;
    if (typeVal   && l.type !== typeVal)                      return false;
    if (roomsVal  && (l.rooms || 0) < parseInt(roomsVal))    return false;
    if (!applyBudgetFilter(l.rent || 0, budgetVal))           return false;
    if (amenVal && !(l.amenities || []).includes(amenVal))    return false;

    return true;
  });

  renderListings(filtered);
  const rc = document.getElementById('tResultCount');
  if (rc) rc.textContent = filtered.length + ' propert' + (filtered.length === 1 ? 'y' : 'ies');
  } finally {
    _filterTenantRunning = false;
  }
}

// ── filterListings kept as alias for backward-compat (called by RC.restoreFilters etc.) ──
function filterListings() {
  if (currentRole === 'student') filterStudentListings();
  else if (currentRole === 'tenant') filterTenantListings();
}

function filterStudentTab(btn, type) {
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  // Set the type filter to match the tab ('' = all), then run full filter
  const typeEl = document.getElementById('sFilterType');
  if (typeEl) typeEl.value = type === 'all' ? '' : type;
  filterStudentListings();
}

function toggleMobileNav() {
  const drawer = document.getElementById('mobileNavDrawer');
  drawer.classList.toggle('open');
}
function closeMobileNav() {
  document.getElementById('mobileNavDrawer').classList.remove('open');
}

// ── Amenity icon map ──
const AMENITY_ICONS = {
  'Borehole Water':'🚰','Municipal Water':'🏙️','Reliable Water Supply':'🚿',
  'Electricity (ZESA)':'💡','Solar Power':'☀️','Generator Backup':'🔋','Prepaid Electricity':'⚡','Backup Power':'🔌',
  'Security Guard':'💂','CCTV Cameras':'📹','Fenced':'🧱','Durawall':'🏗️','Gated Community':'🚧','Secure Environment':'🛡️','24-Hour Security':'🛡️','Secure Parking':'🚗',
  'WiFi / Internet':'📶','Fast WiFi':'🚀','Parking':'🚗','Furnished':'🛋️','Kitchen Access':'🍳','Laundry':'👕','Garden / Yard':'🌿','Meals Included':'🍽️',
  'Study Desk':'📚','Shared Room Option':'🛏️','Affordable Pricing':'💲','Near Schools / Colleges':'🏫','Quiet Environment':'🤫',
  'Private Rooms':'🛏️','Parking Space':'🚗','Full Kitchen':'🍳','Built-in Cupboards':'🚪','Garden or Yard':'🌳','Family-Friendly':'👨‍👩‍👧','Near Shops & Transport':'🏪',
  'Daily Cleaning':'🧹','Towels & Bedding':'🛌','Air Conditioning':'❄️','TV':'📺','Private Bathroom':'🚿','Self-Catering Kitchen':'🍳',
  'Swimming Pool':'🏊','Restaurant':'🍽️','Free WiFi':'📶','Game Drives':'🦁','Spa & Wellness':'🧖','Bar & Lounge':'🍸',
  'Airport Transfers':'🚗','Campfire Evenings':'🔥','Birdwatching':'🦅','Canoe / Kayak':'🛶','Kids Activities':'🧒',
};
function amenityIcon(a) { return AMENITY_ICONS[a] || '✓'; }

// ── Debounce helper — prevents filter functions firing on every keystroke ──
function _debounce(fn, delay) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}
const _dFilterTenant  = _debounce(() => filterTenantListings(),  120);
const _dFilterStudent = _debounce(() => filterStudentListings(), 120);
const _dFilterLodges  = _debounce(() => filterLodges(),          120);


// ══════════════════════════════════════
//  LISTINGS RENDERER
// ══════════════════════════════════════
function getListedAgoLabel(l) {
  // Use l.listedAt (mapped from Supabase created_at) if it is a valid finite number.
  // A truthy check is insufficient because new Date(null).getTime() === 0 and
  // new Date(undefined).getTime() === NaN — both are falsy or invalid, causing
  // the seed fallback to fire even for real Supabase listings.
  const now = Date.now();
  let ms;
  if (Number.isFinite(l.listedAt) && l.listedAt > 0) {
    ms = now - l.listedAt;
  } else {
    // For sample data: spread them across last 180 days deterministically
    const seed = (l.id * 7919) % 180;
    ms = seed * 86400000;
  }
  const days = Math.floor(ms / 86400000);
  if (days < 1) return 'Listed today';
  if (days === 1) return 'Listed 1 day ago';
  if (days < 7) return `Listed ${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? 'Listed 1 week ago' : `Listed ${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? 'Listed 1 month ago' : `Listed ${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'Listed 1 year ago' : `Listed ${years} years ago`;
}

function renderListings(list) {
  const grid = document.getElementById('listingsGrid');
  if (!list.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:56px 20px;color:var(--text-tertiary);">
        <div style="font-size:48px;margin-bottom:14px;">🔍</div>
        <div style="font-family:'DM Serif Display',serif;font-size:20px;color:var(--text-primary);margin-bottom:8px;">No listings found</div>
        <div style="font-size:14px;color:var(--text-secondary);margin-bottom:20px;">Try adjusting your filters — no properties match the current selection.</div>
        <button onclick="clearAllFilters()" style="background:var(--emerald);color:#fff;border:none;padding:11px 24px;border-radius:var(--r);font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:var(--shadow-emerald);">Clear Filters</button>
      </div>`;
    return;
  }
  grid.innerHTML = list.map(l => {
    const isStudentOrTenant = l.role === 'student' || l.role === 'tenant' || l.category === 'student' || l.category === 'tenant';
    const listedAgoTag = isStudentOrTenant
      ? `<div class="lbadge-listed-ago">🕐 ${getListedAgoLabel(l)}</div>` : '';
    return `
    <div class="lcard" onclick="RC.animateCardTap(this);setTimeout(()=>openDetail('${l.id}'),180)" style="cursor:pointer">
      <div class="lcard-photo">
        <img src="${l.photo}" alt="${esc(l.title)}" loading="lazy" onerror="onImgError(this)">
        <div class="lcard-photo-grad"></div>
        <div class="lcard-badges">
          <div class="lbadge-type">${esc(l.type)}</div>
        </div>
      </div>
      <div class="lcard-body">
        ${listedAgoTag}
        <div class="lcard-loc">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(l.location)}
        </div>
        <div class="lcard-title">${esc(l.title)}</div>
        <div class="lcard-tags">
          ${(l.amenities || []).slice(0, 3).map(a => `<span class="ltag">${amenityIcon(a)} ${esc(a)}</span>`).join('')}
          ${(l.amenities || []).length > 3 ? `<span class="ltag">+${l.amenities.length - 3}</span>` : ''}
        </div>
        <div class="lcard-footer">
          <div class="lcard-price">$${l.rent}<sub>/mo</sub></div>
          <div class="lcard-avail">${l.rooms} room${l.rooms > 1 ? 's' : ''} available</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════
//  LODGE FILTER FUNCTION  (replaces static renderLodges)
// ══════════════════════════════════════
function filterLodges() {
  // Update town dropdown based on selected city
  const citySel   = document.getElementById('lFilterCity');
  const suburbSel = document.getElementById('lFilterSuburb');
  if (citySel && suburbSel) {
    const cityVal2 = citySel.value;
    if (cityVal2 && ZW_LOCATIONS && ZW_LOCATIONS[cityVal2]) {
      const suburbs = Object.keys(ZW_LOCATIONS[cityVal2]).sort();
      suburbSel.innerHTML = '<option value="">🏘️ All Towns</option>' +
        suburbs.map(s => `<option value="${s}">${s}</option>`).join('');
      suburbSel.style.display = '';
    } else {
      suburbSel.innerHTML = '<option value="">🏘️ All Towns</option>';
      suburbSel.style.display = 'none';
    }
  }

  const cityVal    = document.getElementById('lFilterCity')?.value    || '';
  const suburbVal  = document.getElementById('lFilterSuburb')?.value  || '';
  const typeVal    = document.getElementById('lFilterType')?.value    || '';
  const amenVal    = document.getElementById('lFilterAmenity')?.value  || '';
  const chaletsVal = document.getElementById('lFilterChalets')?.value || '';
  const hourlyVal  = document.getElementById('lFilterHourlyRate')?.value || '';
  const nightVal   = document.getElementById('lFilterNightRate')?.value || '';
  const dayVal     = document.getElementById('lFilterDayRate')?.value   || '';
  const weeklyVal  = document.getElementById('lFilterWeeklyRate')?.value || '';

  const allLodges = [...new Map([...lodges, ...myLodges].map(l => [l.id, l])).values()];

  const filtered = allLodges.filter(l => {
    const loc = (l.location || '').toLowerCase();
    if (cityVal   && !loc.includes(cityVal.toLowerCase()))   return false;
    if (suburbVal && !loc.includes(suburbVal.toLowerCase())) return false;
    if (typeVal && l.type !== typeVal) return false;
    if (amenVal && !(l.features || []).includes(amenVal)) return false;
    if (chaletsVal && (l.chalets || 0) < parseInt(chaletsVal)) return false;

    // Hourly rate filter — maps to l.hourlyRate
    if (hourlyVal) {
      const ph = parseFloat(l.hourlyRate) || 0;
      if (hourlyVal === 'u10'   && ph >= 10)           return false;
      if (hourlyVal === '10-25' && (ph < 10  || ph > 25)) return false;
      if (hourlyVal === '25-50' && (ph < 25  || ph > 50)) return false;
      if (hourlyVal === '50+'   && ph <= 50)           return false;
    }
    // Night rate filter
    if (nightVal) {
      const pn = l.pricePerNight || 0;
      if (nightVal === 'u50'    && pn >= 50)           return false;
      if (nightVal === '50-120' && (pn < 50  || pn > 120)) return false;
      if (nightVal === '120-250'&& (pn < 120 || pn > 250)) return false;
      if (nightVal === '250+'   && pn <= 250)           return false;
    }
    // Day rate filter
    if (dayVal) {
      const pd = l.pricePerDay || l.dayRate || 0;
      if (dayVal === 'u30'    && pd >= 30)           return false;
      if (dayVal === '30-60'  && (pd < 30  || pd > 60))  return false;
      if (dayVal === '60-120' && (pd < 60  || pd > 120)) return false;
      if (dayVal === '120+'   && pd <= 120)           return false;
    }
    // Weekly rate filter
    if (weeklyVal) {
      const pw = l.weeklyRate || 0;
      if (weeklyVal === 'u200'    && pw >= 200)             return false;
      if (weeklyVal === '200-500' && (pw < 200 || pw > 500)) return false;
      if (weeklyVal === '500-1000'&& (pw < 500 || pw > 1000))return false;
      if (weeklyVal === '1000+'   && pw <= 1000)            return false;
    }
    return true;
  });

  const count = document.getElementById('lodgeCount');
  if (count) count.textContent = filtered.length + ' lodge' + (filtered.length !== 1 ? 's' : '');

  if (!filtered.length) {
    document.getElementById('lodgeGrid').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:56px 20px;color:var(--text-tertiary);">
        <div style="font-size:48px;margin-bottom:14px;">🏨</div>
        <div style="font-family:'DM Serif Display',serif;font-size:20px;color:var(--text-primary);margin-bottom:8px;">No lodges found</div>
        <div style="font-size:14px;color:var(--text-secondary);margin-bottom:20px;">No lodges match your current filters. Try broadening your search.</div>
        <button onclick="clearLodgeFilters()" style="background:#F59E0B;color:#000;border:none;padding:11px 24px;border-radius:var(--r);font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(245,158,11,0.28);">Clear Filters</button>
      </div>`;
    return;
  }

  document.getElementById('lodgeGrid').innerHTML = filtered.map(l => `
    <div class="lodge-card" onclick="openLodgeDetail('${l.id}')">
      <div class="lodge-card-photo">
        <img src="${l.photo}" alt="${esc(l.name)}" loading="lazy" onerror="onImgError(this)">
        <div class="${l.available ? 'lodge-badge-avail' : 'lodge-badge-full'}">${l.available ? '✓ Available' : 'Fully Booked'}</div>
        <div class="lodge-star-row" style="position:absolute;bottom:12px;left:14px;z-index:2;color:#FCD34D;font-size:13px;letter-spacing:1px;">${'★'.repeat(l.stars)}${'☆'.repeat(5-l.stars)}</div>
      </div>
      <div class="lodge-card-body">
        <div class="lodge-card-loc">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(l.location)}
        </div>
        <div class="lodge-card-name">${esc(l.name)}</div>
        <div class="lodge-card-amenities">
          ${(l.features || []).slice(0,3).map(f => `<span class="lodge-amenity-tag">${amenityIcon(f)} ${esc(f)}</span>`).join('')}
          ${(l.features || []).length > 3 ? `<span class="lodge-amenity-tag">+${l.features.length-3} more</span>` : ''}
        </div>
        <div class="lodge-card-footer">
          <div class="lodge-price-block">
            <div class="lodge-price">$${l.pricePerNight}<sub>/night</sub></div>
            ${l.hourlyRate ? `<div style="font-size:11px;color:var(--text-tertiary);">⏱️ $${l.hourlyRate}/hr${l.weeklyRate ? ' · 📅 $'+l.weeklyRate+'/wk' : ''}</div>` : (l.weeklyRate ? `<div style="font-size:11px;color:var(--text-tertiary);">📅 $${l.weeklyRate}/wk</div>` : `<div class="lodge-price-cap">${l.chalets} chalets · max ${l.maxGuests} guests</div>`)}
          </div>
          <button class="btn-book-card" ${!l.available ? 'disabled' : ''} onclick="event.stopPropagation();openBookingPage('${l.id}')">${l.available ? 'Book Now' : 'Full'}</button>
        </div>
      </div>
    </div>`).join('');
}

// Keep renderLodges as alias
function renderLodges() { filterLodges(); }

// ── Clear filter helpers (called from empty-state buttons) ──
function clearAllFilters() {
  // Tenant filters
  ['tFilterCity','tFilterSuburb','tFilterType','tFilterRooms','tFilterBudget','tFilterAmenity'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  // Student filters
  ['sFilterCity','sFilterSuburb','sFilterType','sFilterUniversity','sFilterRooms','sFilterStudentsPerRoom','sFilterBudget','sFilterAmenity'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  filterListings();
}

function clearLodgeFilters() {
  ['lFilterCity','lFilterSuburb','lFilterType','lFilterAmenity','lFilterChalets','lFilterHourlyRate','lFilterNightRate','lFilterDayRate','lFilterWeeklyRate'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  filterLodges();
}

// ── Old populate functions kept as no-ops for backward-compat ──
function populateAmenityDropdown() {}
function populateTypeDropdown(role) {}

// ══════════════════════════════════════
//  DETAIL
// ══════════════════════════════════════
function openDetail(id) {
  id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
  // Remember which browse page we came from so Back button works
  const active = document.querySelector('.page.active');
  if (active) window._lastBrowsePage = active.id;
  // CHANGE 1: Deduplicate when finding listing
  const allListings = [...new Map([...listings, ...myListings].map(l => [l.id, l])).values()];
  const l = allListings.find(x => x.id === id);
  if (!l) return;

  // Track views and type
  RC.onListingView();
  RC.trackViewedType(l.type);

  // ── Increment per-listing view count ──
  // Skip view increment if the logged-in user owns this listing,
  // or if they already viewed it this session (avoid hammering Supabase on back/forward)
  const _viewerSession = (typeof session === 'function') ? session() : null;
  const _isOwner = _viewerSession && _viewerSession.code && l._ownerCode && l._ownerCode === _viewerSession.code;
  window._seenListings = window._seenListings || new Set();
  const _alreadySeen = window._seenListings.has(l.id);
  if (!_alreadySeen) window._seenListings.add(l.id);
  if (!_isOwner && !_alreadySeen) {
    l.views = (l.views || 0) + 1;
    // Sync to myListings entry so in-memory count is current
    const myEntry = myListings.find(x => x.id === l.id);
    if (myEntry) myEntry.views = l.views;
    // Persist view counts to localStorage so they survive page refreshes
    try {
      const stored = JSON.parse(localStorage.getItem('rc_listing_views') || '{}');
      stored[l.id] = l.views;
      localStorage.setItem('rc_listing_views', JSON.stringify(stored));
    } catch(e) {}
  }
  // Also update in Supabase so all devices see real counts (skip for owner)
  if (l._dbId && !_isOwner && !_alreadySeen) {
    (async () => {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/properties?id=eq.${encodeURIComponent(l._dbId)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ views: l.views })
          }
        );
        if (!res.ok) console.warn('View update error:', res.status, await res.text());
      } catch(e) { console.warn('View update failed:', e); }
    })();
  }
  // Update dashboard stat live immediately (no full dashboard reload needed)
  const statViews = document.getElementById('statViews');
  if (statViews) {
    const s = typeof session === 'function' ? session() : null;
    if (s) {
      const ownerListings = myListings.filter(x => x._ownerCode === s.code);
      const total = ownerListings.reduce((a, x) => a + (x.views || 0), 0);
      statViews.textContent = total || '—';
    }
  }
  // Update the per-card view badge live on the dashboard if visible
  const cardBadges = document.querySelectorAll(`#dlc-${l.id} .dlc-views-badge`);
  cardBadges.forEach(b => { b.textContent = `👁 ${l.views} view${l.views === 1 ? '' : 's'}`; });
  RC.saveFilters(); // save filters before leaving browse

  const phone = formatPhone(l.phone);
  const callPhone = formatPhone(l.callPhone || l.phone);
  const waMsg = encodeURIComponent(`Hi! I saw your listing "${esc(l.title)}" on RentaCrib ZW. Is it still available?`);

  document.getElementById('detailHero').innerHTML = `
    <img src="${l.photo}" alt="${esc(l.title)}" style="width:100%;height:100%;object-fit:cover;animation:heroZoom 20s ease-in-out infinite alternate;" onerror="onImgError(this)">
    <div class="detail-hero-scrim"></div>
    <div class="detail-hero-badges">
      <div style="background:rgba(255,255,255,0.26);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.45);color:rgba(255,255,255,0.96);padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;">${esc(l.type)}</div>
      ${(l.role === 'student' || l.role === 'tenant' || l.category === 'student' || l.category === 'tenant') ? `<div style="background:rgba(0,0,0,0.45);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.88);padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;">🕐 ${getListedAgoLabel(l)}</div>` : ''}
    </div>`;

  document.getElementById('detailBody').innerHTML = `
    <div class="detail-top-section">
      <div class="detail-top-row">
        <h1 class="detail-title">${esc(l.title)}</h1>
        <div class="detail-price-block">
          <span class="detail-price">$${l.rent}</span>
          <div class="detail-price-note">per month</div>
        </div>
      </div>
      <div class="detail-meta">
        <div class="dmeta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><strong>${esc(l.location)}</strong></div>
        <div class="dmeta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><strong>${l.rooms}</strong>&nbsp;room${l.rooms > 1 ? 's' : ''} available</div>
        <div class="dmeta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>For: <strong>${(l.forWho || ['Anyone']).map(w => esc(w)).join(', ')}</strong></div>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-label">Amenities & Features</div>
      <div class="amenity-wrap">${(l.amenities || []).map(a => `<div class="amenity-pill has">${amenityIcon(a)} ${esc(a)}</div>`).join('')}</div>
    </div>
    <div class="detail-section">
      <div class="detail-section-label">About This Property</div>
      <p class="detail-desc">${esc(l.desc)}</p>
    </div>`;

  document.getElementById('contactBar').innerHTML = `
    <a href="https://wa.me/${phone.replace('+','')}?text=${waMsg}" target="_blank" style="flex:1;text-decoration:none;" onclick="RC.persistWANumber(document.getElementById('bkPhone')?.value||''); saveEnquiryToSupabase('${l.id}', document.getElementById('bkName')?.value||'', document.getElementById('bkPhone')?.value||'', 'Property enquiry: ${l.title||l.name||''}')">
      <button class="btn-whatsapp" style="width:100%">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>
        Message on WhatsApp
      </button>
    </a>
    <a href="tel:${callPhone}" style="flex:1;text-decoration:none;">
      <button class="btn-call" style="width:100%">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 3.07 9.81a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 2 0h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L6.09 7.91A16 16 0 0 0 13 14.84l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.07 16l.85.92z"/></svg>
        Call Landlord
      </button>
    </a>`;

  showPage('pg-detail');
  // Update back button label to match the originating page
  const _backLabel = document.getElementById('detailBackLabel');
  if (_backLabel) {
    _backLabel.textContent = window._lastBrowsePage === 'pg-lodges' ? 'Back to Lodges'
      : window._lastBrowsePage === 'pg-dashboard' ? 'Back to Dashboard'
      : window._lastBrowsePage === 'pg-mylistings' ? 'Back to My Listings'
      : 'Back to Listings';
  }
  // FIX 10: build fresh deduped arrays each time and pass as arguments
  setTimeout(() => {
    const _allListings = [...new Map([...listings, ...myListings].map(i => [i.id, i])).values()];
    const _allLodges   = [...new Map([...lodges,   ...myLodges  ].map(i => [i.id, i])).values()];
    RC.showSimilarListings(l, _allListings, _allLodges);
  }, 300);
}
// ══════════════════════════════════════
let _flowDirection_dummy; // placeholder

function showFlowStep(n) {
  document.querySelectorAll('.fstep').forEach(s => { s.classList.remove('active','slide-right','slide-left'); });
  const step = document.getElementById('fs' + n);
  step.classList.add('active', _flowDirection >= 0 ? 'slide-right' : 'slide-left');
  document.getElementById('flowLabel').textContent = STEP_LABELS[n - 1];
  document.getElementById('flowCount').textContent = 'Step ' + n + ' of ' + TOTAL_STEPS;
  document.getElementById('progFill').style.width = ((n / TOTAL_STEPS) * 100) + '%';
  document.getElementById('flowPrev').style.visibility = n === 1 ? 'hidden' : 'visible';
  const nb = document.getElementById('flowNext');
  nb.textContent = n === TOTAL_STEPS ? 'Submit Listing ✓' : 'Continue →';
  if (n === TOTAL_STEPS) buildReview();
  if (n === 2) buildTypeGrid();
  if (n === 3) activateAmenityPanel();
  if (n === 4) renderFs3Summary();
  if (n === 5) {
    updatePropertyDetailsFields();
    RC.prefillWANumber();
    // Wire up live update listeners — just save form on input now
    ['fTitle','fRent','fLocation'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => RC.saveForm(), {once:false});
    });
  }
  // Save form progress
  ss('rc_landlord_step', n);
  window.scrollTo(0, 0);
  // Reset scroll hint animation
  const hint = document.getElementById('flowScrollHint');
  if (hint) {
    hint.style.animation = 'none';
    void hint.offsetWidth;
    hint.style.animation = '';
    hint.style.opacity = '0';
    hint.style.animation = 'scrollHintFadeIn 0.6s 1.4s cubic-bezier(0.22,1,0.36,1) forwards';
    const arrowEl = hint.querySelector('.scroll-hint-arrow');
    if (arrowEl) { arrowEl.style.animation = 'none'; void arrowEl.offsetWidth; arrowEl.style.animation = 'scrollArrowBounce 1.6s ease-in-out 2.0s infinite'; }
  }
  // Button peek — slide footer up into view with a bounce settle
  const footer = document.querySelector('#pg-landlord .flow-footer');
  if (footer) {
    footer.classList.remove('btn-peek');
    void footer.offsetWidth; // force reflow to restart animation
    footer.classList.add('btn-peek');
    // Remove class after animation completes so hover/active still work cleanly
    setTimeout(() => footer.classList.remove('btn-peek'), 2400);
  }
}

function flowNext() {
  if (currentStep === 1 && !document.querySelector('.catcard.selected')) { toast('Please select a category'); return; }
  if (currentStep === 2 && !document.querySelector('.tcard.selected')) { toast('Please select a property type'); return; }
  if (currentStep === 3 && document.querySelectorAll('#fs3 .chip.on').length === 0) { toast('Please select at least one amenity'); return; }
  if (currentStep === 5) {
    if (!document.getElementById('fTitle').value.trim()) { toast('Please enter a property title'); return; }
    if (!document.getElementById('fLocation').value.trim()) { toast('Please select at least a city and suburb for this property'); return; }
    const cat = getActiveCategory();
    if (cat === 'guests') {
      if (!document.getElementById('fDayRate').value || parseFloat(document.getElementById('fDayRate').value) <= 0) { toast('Please enter a valid Day Stay Rate'); return; }
      if (!document.getElementById('fNightRate').value || parseFloat(document.getElementById('fNightRate').value) <= 0) { toast('Please enter a valid Night Stay Rate'); return; }
    } else {
      const _rentVal = parseFloat(document.getElementById('fRent').value);
      if (!document.getElementById('fRent').value || _rentVal <= 0) { toast('Please enter a monthly rent greater than $0'); return; }
    }
    const _roomsVal = parseInt(document.getElementById('fRooms').value);
    if (!document.getElementById('fRooms').value || _roomsVal < 1) { toast('Please enter at least 1 room available'); return; }
    const rawPhone = document.getElementById('fPhone').value.replace(/\D/g, '');
    if (!rawPhone) { toast('Please enter your WhatsApp number'); return; }
    if (rawPhone.length !== 10) { toast('WhatsApp number must be exactly 10 digits'); return; }
    if (!isValidZwPhone(rawPhone)) { toast('Enter a valid Zimbabwean mobile number (071 / 073 / 077 / 078)'); return; }
    const rawCallPhone = document.getElementById('fCallPhone')?.value?.replace(/\D/g, '') || '';
    if (rawCallPhone && rawCallPhone.length !== 10) { toast('Call number must be exactly 10 digits'); return; }
    if (rawCallPhone && !isValidZwPhone(rawCallPhone)) { toast('Call number must be a valid Zimbabwean mobile number (071 / 073 / 077 / 078)'); return; }
    if (!document.getElementById('fDesc').value.trim()) { toast('Please add a description'); return; }
    // Persist WA number
    RC.persistWANumber(document.getElementById('fPhone').value);
  }
  if (currentStep === TOTAL_STEPS) { submitListing(); return; }
  _flowDirection = 1;
  currentStep++; showFlowStep(currentStep);
}

function flowPrev() {
  if (currentStep === 1) { goHome(); return; }
  _flowDirection = -1;
  currentStep--; showFlowStep(currentStep);
}

function selectOne(sel, el) {
  document.querySelectorAll(sel).forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

// ── Category suggestion (Step 1) ──
const CATEGORY_TYPES = {

  /* ═══════════════════════════════════════════════════════
     STUDENT HOUSING  ←  mirrors "I'm a Student" tab
     Shows: affordable rooms, self-contained, shared housing
     near campus — exactly what setRole('student') shows
  ═══════════════════════════════════════════════════════ */
  student: {
    label: '🎓 Student Properties',
    groups: [
      {
        heading: 'Rooms',
        types: [
          { name: 'Single Room',    desc: 'Standard or en-suite, private or shared bathroom', emoji: '🛏️', img: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=400&q=75&auto=format&fit=crop' },
          { name: 'Shared Room',    desc: 'Twin or triple occupancy — budget-friendly',       emoji: '👥', img: 'https://images.unsplash.com/photo-1555854877-bab0e564b8d5?w=400&q=75&auto=format&fit=crop' },
          { name: 'Student Bedsitter', desc: 'Compact room with own kitchenette',              emoji: '🪑', img: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=400&q=75&auto=format&fit=crop' },
        ]
      },
      {
        heading: 'Self-Contained & Flats',
        types: [
          { name: 'Self-Contained', desc: 'Own bathroom & kitchenette — full privacy',        emoji: '🚿', img: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=400&q=75&auto=format&fit=crop' },
          { name: 'Student Flat',   desc: 'Shared or private kitchen, 1–2 bedrooms',          emoji: '🏢', img: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=400&q=75&auto=format&fit=crop' },
        ]
      },
      {
        heading: 'Shared Houses & Halls',
        types: [
          { name: 'Shared House',               desc: 'Rooms in a house with fellow students',        emoji: '🏠', img: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=400&q=75&auto=format&fit=crop' },
          { name: 'Student Hostel',              desc: 'Male, female or mixed-gender hostel',          emoji: '🏨', img: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400&q=75&auto=format&fit=crop' },
          { name: 'University Hall of Residence',desc: 'On-campus accommodation',                     emoji: '🎓', img: 'https://images.unsplash.com/photo-1541339907198-e08756dedf3f?w=400&q=75&auto=format&fit=crop' },
          { name: 'Private Student Hall',        desc: 'Managed off-campus student block',            emoji: '🏛️', img: 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=400&q=75&auto=format&fit=crop' },
        ]
      }
    ]
  },

  /* ═══════════════════════════════════════════════════════
     FAMILIES & PROFESSIONALS  ←  mirrors "I'm a Tenant" tab
     Shows: apartments, houses, self-contained units, cottages
     — exactly what setRole('tenant') shows
  ═══════════════════════════════════════════════════════ */
  family: {
    label: '🏡 Families & Professionals',
    groups: [
      {
        heading: 'Rooms',
        types: [
          { name: 'Room (Single / Double / Triple)', desc: 'Furnished or unfurnished private rooms',   emoji: '🛏️', img: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=400&q=75&auto=format&fit=crop' },
          { name: 'Bedsitter',                       desc: 'Standard or executive bedsitter',          emoji: '🪑', img: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=400&q=75&auto=format&fit=crop' },
          { name: 'Self-Contained Room',             desc: 'Studio or loft with own bathroom',         emoji: '🚿', img: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=400&q=75&auto=format&fit=crop' },
          { name: 'Shared Room / Co-living',         desc: 'Communal living arrangement',              emoji: '🤝', img: 'https://images.unsplash.com/photo-1555854877-bab0e564b8d5?w=400&q=75&auto=format&fit=crop' },
        ]
      },
      {
        heading: 'Apartments & Flats',
        types: [
          { name: 'Flat / Apartment',   desc: '1–3+ bedrooms, duplex, maisonette or penthouse', emoji: '🏢', img: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=400&q=75&auto=format&fit=crop' },
          { name: 'Serviced Apartment', desc: 'Fully serviced — utilities included',             emoji: '✨', img: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=400&q=75&auto=format&fit=crop' },
          { name: 'Corporate Housing',  desc: 'Business-grade furnished accommodation',          emoji: '💼', img: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=400&q=75&auto=format&fit=crop' },
        ]
      },
      {
        heading: 'Houses & Cottages',
        types: [
          { name: 'Cottage',                desc: 'Backyard or standalone cottage',                          emoji: '🏡', img: 'https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=400&q=75&auto=format&fit=crop' },
          { name: 'House',                  desc: 'Detached, semi-detached, townhouse, bungalow or villa',    emoji: '🏠', img: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=400&q=75&auto=format&fit=crop' },
          { name: 'Affordable Housing Unit',desc: 'Government or subsidised housing',                        emoji: '🏗️', img: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=400&q=75&auto=format&fit=crop' },
        ]
      }
    ]
  },

  /* ═══════════════════════════════════════════════════════
     LODGE / SHORT STAY  ←  mirrors "Book a Lodge" tab
     Shows: lodge rooms, entire properties, guesthouses
     — exactly what showLodges() shows
  ═══════════════════════════════════════════════════════ */
  lodge: {
    label: '🏨 Lodges / Short Stay & Airbnb',
    groups: [
      {
        heading: 'Rooms & Private Stays',
        types: [
          { name: 'Lodge Room',         desc: 'Standard or premium room — nightly rate',      emoji: '🏨', img: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400&q=75&auto=format&fit=crop' },
          { name: 'Guest House / B&B',  desc: 'Bed and breakfast guesthouse stay',             emoji: '☕', img: 'https://images.unsplash.com/photo-1445991842772-097fea258e7b?w=400&q=75&auto=format&fit=crop' },
          { name: 'Private Room',       desc: 'Shared or private bathroom',                    emoji: '🔑', img: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=400&q=75&auto=format&fit=crop' },
          { name: 'Family Room',        desc: 'Spacious room for families',                    emoji: '👨‍👩‍👧', img: 'https://images.unsplash.com/photo-1598928636135-d146006ff4be?w=400&q=75&auto=format&fit=crop' },
          { name: 'Business Stay Room', desc: 'Work-ready room with desk &amp; fast WiFi',     emoji: '💼', img: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=400&q=75&auto=format&fit=crop' },
        ]
      },
      {
        heading: 'Entire Properties',
        types: [
          { name: 'Entire Apartment',desc: 'Full apartment to yourself',                     emoji: '🏢', img: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=400&q=75&auto=format&fit=crop' },
          { name: 'Entire Home',     desc: 'Full house or villa — exclusive use',             emoji: '🏠', img: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=400&q=75&auto=format&fit=crop' },
          { name: 'Cabin or Chalet', desc: 'Rustic retreat in nature',                        emoji: '🌿', img: 'https://images.unsplash.com/photo-1470770903676-69b98201ea1c?w=400&q=75&auto=format&fit=crop' },
          { name: 'Vacation Rental', desc: 'Holiday home or leisure property',                emoji: '🌴', img: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=400&q=75&auto=format&fit=crop' },
          { name: 'Airbnb Unit',     desc: 'Verified short-stay listing',                     emoji: '🔴', img: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=400&q=75&auto=format&fit=crop' },
        ]
      },
      {
        heading: 'Hotels & Resorts',
        types: [
          { name: 'Boutique Hotel',desc: 'Small, stylish hotel property', emoji: '✨', img: 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=400&q=75&auto=format&fit=crop' },
          { name: 'Resort Room',   desc: 'Leisure resort accommodation',  emoji: '🏖️', img: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=400&q=75&auto=format&fit=crop' },
        ]
      }
    ]
  }
};

function selectCategory(key, el) {
  selectedCategory = key;
  // Correct role mapping per spec:
  // student → 'student', family/tenant → 'tenant', lodge → 'lodge'
  const roleMap = { student: 'student', family: 'tenant', tenant: 'tenant', lodge: 'lodge' };
  currentRole = roleMap[key] || 'tenant';
  document.querySelectorAll('.catcard').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

function buildTypeGrid() {
  const cat = CATEGORY_TYPES[selectedCategory];
  if (!cat) return;
  // Update step 2 subtitle and badge
  const badge = document.getElementById('fs2CatBadge');
  if (badge) badge.textContent = cat.label;
  // Build grouped cards
  const grid = document.getElementById('typeGrid');
  if (!grid) return;
  grid.innerHTML = cat.groups.map(group => `
    <div class="type-group">
      <div class="type-group-heading"><span>${group.heading}</span></div>
      <div class="type-group-cards">
        ${group.types.map(t => `
          <div class="tcard" onclick="selectOne('.tcard',this)">
            <img class="tcard-photo" src="${t.img}" alt="${t.name}" loading="lazy">
            <div class="tcard-body">
              <div class="tcard-emoji-row"><span class="tcard-emoji">${t.emoji}</span></div>
              <div class="tcard-name">${t.name}</div>
              <div class="tcard-desc">${t.desc}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function resetCategory() {
  selectedCategory = null;
  document.querySelectorAll('.catcard').forEach(c => c.classList.remove('selected'));
}

function toggleWho(el) { el.classList.toggle('selected'); }

function toggleChip(el) {
  el.classList.toggle('on');
  const ico = el.querySelector('.chip-ico');
  if (ico) ico.style.transform = el.classList.contains('on') ? 'rotate(-6deg) scale(1.15)' : '';
  updateTtabSummary();
  // Bounce the summary panel
  const summary = document.getElementById('ttabSummary');
  if (summary && summary.style.display !== 'none') {
    summary.classList.remove('bouncing');
    void summary.offsetWidth; // force reflow
    summary.classList.add('bouncing');
    setTimeout(() => summary.classList.remove('bouncing'), 420);
  }
}

function activateAmenityPanel() {
  // Map selectedCategory → panel id
  const panelMap = { student: 'students', family: 'profam', lodge: 'guests' };
  const panelId  = panelMap[selectedCategory] || 'profam';
  // Show the right panel, hide others
  document.querySelectorAll('.ttab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('ttab-' + panelId);
  if (panel) panel.classList.add('active');
  // Update the banner label
  const bannerMap = {
    student: '🎓 Student Amenities',
    family:  '🏡 Families & Professionals Amenities',
    lodge:   '🏨 Lodge / Short Stay Amenities'
  };
  const banner = document.getElementById('amenityCatBanner');
  if (banner) banner.textContent = bannerMap[selectedCategory] || '';
  // Reset any previously selected chips when re-entering
  updateTtabSummary();
}

function switchTenantTab(tab, btn) {
  document.querySelectorAll('.ttab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.ttab-panel').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const panel = document.getElementById('ttab-' + tab);
  if (panel) panel.classList.add('active');
  // Update Step 4 fields based on selected category
  updatePropertyDetailsFields(tab);
}

// ══════════════════════════════════════
//  PROPERTY DETAILS — CATEGORY-AWARE
// ══════════════════════════════════════
const ZW_UNIVERSITIES = [
  'University of Zimbabwe (UZ)',
  'Midlands State University (MSU)',
  'National University of Science and Technology (NUST)',
  'Chinhoyi University of Technology (CUT)',
  'Bindura University of Science Education (BUSE)',
  'Harare Institute of Technology (HIT)',
  'Zimbabwe Ezekiel Guti University (ZEGU)',
  'Africa University (AU)',
  'Zimbabwe Open University (ZOU)',
  'Lupane State University (LSU)',
  'Great Zimbabwe University (GZU)',
  'Gwanda State University',
  'Manicaland State University of Applied Sciences (MSUAS)',
  'Marondera University of Agricultural Sciences and Technology (MUAST)',
  "Women's University in Africa (WUA)",
  'Reformed Church University (RCU)',
  'Catholic University in Zimbabwe (CUZ)',
  'Arrupe Jesuit University',
  'Zimbabwe Theological College',
  'Solusi University',
  'Belvedere Technical Teachers College',
  'United College of Education (UCE)',
  'Joshua Mqabuko Nkomo Polytechnic',
  'Bulawayo Polytechnic',
  'Harare Polytechnic',
  'Mutare Polytechnic',
  'Masvingo Polytechnic',
  'Gweru Technical College',
  'Kwekwe Polytechnic',
  'Chinhoyi Technical College',
  'Mkoba Teachers College',
  'Morgan Zintec Teachers College',
  'Hillside Teachers College',
  'Gweru Teachers College',
  'Masvingo Teachers College',
  'Mutare Teachers College',
  'Morgenster Teachers College',
  'United College of Education – Bulawayo',
  'Seke Teachers College',
  'Marymount Teachers College',
  'Nyadire Teachers College'
];

function filterUniversityOptions() {
  const q = (document.getElementById('fUniversity')?.value || '').toLowerCase().trim();
  populateUniversityDropdown(q);
  showUniversityDropdown();
}

function populateUniversityDropdown(filter) {
  const dd = document.getElementById('universityDropdown');
  if (!dd) return;
  const q = (filter || '').toLowerCase().trim();
  const filtered = q ? ZW_UNIVERSITIES.filter(u => u.toLowerCase().includes(q)) : ZW_UNIVERSITIES;
  if (!filtered.length) { dd.innerHTML = '<div class="loc-no-results">No institution found</div>'; return; }
  dd.innerHTML = filtered.map(u =>
    '<div class="loc-opt" onclick="selectUniversity(\'' + u.replace(/'/g, "\\'") + '\')">'
    + '<span class="loc-opt-icon">🏫</span>' + u + '</div>'
  ).join('');
}

function showUniversityDropdown() {
  populateUniversityDropdown(document.getElementById('fUniversity')?.value || '');
  document.getElementById('universityDropdown')?.classList.add('open');
}

function hideUniversityDropdown(delay) {
  setTimeout(() => { document.getElementById('universityDropdown')?.classList.remove('open'); }, delay || 200);
}

function selectUniversity(name) {
  const inp = document.getElementById('fUniversity');
  const hid = document.getElementById('fUniversityVal');
  if (inp) inp.value = name;
  if (hid) hid.value = name;
  document.getElementById('universityDropdown')?.classList.remove('open');
}

function selectStudentsPerRoom(btn, val) {
  document.querySelectorAll('#studentsPerRoomPicker .spr-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const hid = document.getElementById('fStudentsPerRoom');
  if (hid) hid.value = val;
}

function getActiveCategory() {
  if (selectedCategory === 'student') return 'students';
  if (selectedCategory === 'lodge')   return 'guests';
  return 'profam'; // family or default
}

function updatePropertyDetailsFields(tab) {
  if (!tab) tab = getActiveCategory();
  const studentFields = document.getElementById('studentFields');
  const guestFields = document.getElementById('guestFields');
  const monthlyRentField = document.getElementById('fieldMonthlyRent');
  if (tab === 'students') {
    if (studentFields) studentFields.style.display = 'block';
    if (guestFields) guestFields.style.display = 'none';
    if (monthlyRentField) monthlyRentField.style.display = 'block';
  } else if (tab === 'guests') {
    if (studentFields) studentFields.style.display = 'none';
    if (guestFields) guestFields.style.display = 'block';
    if (monthlyRentField) monthlyRentField.style.display = 'none';
  } else {
    if (studentFields) studentFields.style.display = 'none';
    if (guestFields) guestFields.style.display = 'none';
    if (monthlyRentField) monthlyRentField.style.display = 'block';
  }
}

function updateTtabSummary() {
  const count = document.querySelectorAll('#fs3 .chip.on').length;
  const summary = document.getElementById('ttabSummary');
  const countEl = document.getElementById('ttabCount');
  if (summary && countEl) {
    summary.style.display = count > 0 ? 'flex' : 'none';
    countEl.textContent = count;
  }
}

function renderFs3Summary() {
  const selected = Array.from(document.querySelectorAll('#fs3 .chip.on'));
  const listEl = document.getElementById('fs3AmenityList');
  const emptyEl = document.getElementById('fs3Empty');
  if (!listEl || !emptyEl) return;
  if (selected.length === 0) {
    listEl.style.display = 'none'; emptyEl.style.display = 'block';
    return;
  }
  listEl.style.display = 'flex'; emptyEl.style.display = 'none';
  listEl.innerHTML = selected.map(chip => {
    const ico = chip.querySelector('.chip-ico') ? chip.querySelector('.chip-ico').textContent : '✓';
    const val = chip.dataset.val;
    return `<div class="fs3-amenity-pill" onclick="removeAmenity(this,'${val}')">${ico} ${val} <span class="pill-remove">✕</span></div>`;
  }).join('');
}

function removeAmenity(pill, val) {
  const chip = document.querySelector('#fs3 .chip[data-val="' + CSS.escape(val) + '"]');
  if (chip) { chip.classList.remove('on'); const ico = chip.querySelector('.chip-ico'); if (ico) ico.style.transform = ''; }
  pill.remove();
  const listEl = document.getElementById('fs3AmenityList');
  const emptyEl = document.getElementById('fs3Empty');
  if (listEl && listEl.children.length === 0) { listEl.style.display = 'none'; if (emptyEl) emptyEl.style.display = 'block'; }
  updateTtabSummary();
}

// ── Single-photo WhatsApp-style upload (Step 6) ──
function handleSinglePhoto(e) {
  const file = e.target.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  window._pendingPhotoFile = file;   // keep raw File for Supabase Storage upload
  const r = new FileReader();
  r.onload = ev => {
    _pendingPhotoSrc = ev.target.result;
    // Show WA-style preview
    document.getElementById('waPreviewImg').src = _pendingPhotoSrc;
    document.getElementById('waPhotoPreview').style.display = 'block';
    document.getElementById('photoPickerArea').style.display = 'none';
    document.getElementById('photoConfirmedArea').style.display = 'none';
  };
  r.readAsDataURL(file);
  e.target.value = '';
}

function confirmPhotoSend() {
  if (!_pendingPhotoSrc) return;
  uploadedPhotos = [_pendingPhotoSrc];
  window._confirmedPhotoFile = window._pendingPhotoFile; // preserve File ref for Supabase upload
  document.getElementById('confirmedPhotoImg').src = _pendingPhotoSrc;
  document.getElementById('waPhotoPreview').style.display = 'none';
  document.getElementById('photoPickerArea').style.display = 'none';
  document.getElementById('photoConfirmedArea').style.display = 'block';
  _pendingPhotoSrc = null;
  toast('✓ Photo added to your listing');
}

function cancelPhotoPreview() {
  _pendingPhotoSrc = null;
  window._pendingPhotoFile = null;
  window._confirmedPhotoFile = null;
  // Clear the file input so re-selecting the same file fires onchange
  const inp = document.getElementById('photoInput');
  if (inp) inp.value = '';
  document.getElementById('waPhotoPreview').style.display = 'none';
  document.getElementById('photoPickerArea').style.display = 'block';
  document.getElementById('photoConfirmedArea').style.display = uploadedPhotos.length ? 'block' : 'none';
}

function changePhoto() {
  uploadedPhotos = [];
  _pendingPhotoSrc = null;
  window._pendingPhotoFile = null;
  window._confirmedPhotoFile = null;
  document.getElementById('photoConfirmedArea').style.display = 'none';
  document.getElementById('photoPickerArea').style.display = 'block';
  document.getElementById('photoInput').click();
}

// ── Lodge photo upload handlers ──
function handleLodgePhoto(e) {
  const file = e.target.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  window._pendingLodgePhotoFile = file;
  const r = new FileReader();
  r.onload = ev => {
    document.getElementById('llPhotoPreviewImg').src = ev.target.result;
    document.getElementById('llPhotoUploadArea').style.display = 'none';
    document.getElementById('llPhotoPreviewArea').style.display = 'block';
  };
  r.readAsDataURL(file);
}

function cancelLodgePhoto() {
  window._pendingLodgePhotoFile = null;
  document.getElementById('llPhotoPreviewImg').src = '';
  document.getElementById('llPhotoPreviewArea').style.display = 'none';
  document.getElementById('llPhotoUploadArea').style.display = 'block';
  const inp = document.getElementById('llPhotoInput');
  if (inp) inp.value = '';
}

// Keep renderPreviews as no-op for backward compat
function renderPreviews() {}
function handlePhotos(e) {}
function handlePhotosDrop(e) {}
function removePhoto(i) {}

function buildReview() {
  const type = document.querySelector('.tcard.selected .tcard-name')?.textContent || '—';
  const catMap = { student: 'students', family: 'profam', lodge: 'guests' };
  const cat = catMap[selectedCategory] || 'profam';
  const whoMap = { students: 'Students', profam: 'Professionals / Families', guests: 'Guests' };
  const who = [whoMap[cat] || cat];
  const amenities = Array.from(document.querySelectorAll('#fs3 .chip.on')).map(e => e.dataset.val);
  const title = document.getElementById('fTitle').value || '—';
  const loc   = document.getElementById('fLocation').value || '—';
  const rooms = document.getElementById('fRooms').value || '—';
  const phone = document.getElementById('fPhone').value || '—';
  const desc  = document.getElementById('fDesc').value || '—';
  const heroImg = uploadedPhotos.length ? uploadedPhotos[0] : (TYPE_PHOTOS[type] || TYPE_PHOTOS['Full House']);

  let priceLine = '';
  let extraRows = '';

  if (cat === 'guests') {
    const dayRate = document.getElementById('fDayRate')?.value;
    const dayFrom = document.getElementById('fDayFrom')?.value;
    const dayTo = document.getElementById('fDayTo')?.value;
    const nightRate = document.getElementById('fNightRate')?.value;
    const nightFrom = document.getElementById('fNightFrom')?.value;
    const nightTo = document.getElementById('fNightTo')?.value;
    const hourly = document.getElementById('fHourlyRate')?.value;
    const weekly = document.getElementById('fWeeklyRate')?.value;
    priceLine = dayRate ? `$${dayRate}` : '—';
    extraRows = `
      ${hourly ? `<div class="rrow"><span class="rrow-label">⏱️ Hourly Rate</span><span class="rrow-val">$${hourly}/hr</span></div>` : ''}
      ${dayRate ? `<div class="rrow"><span class="rrow-label">🌞 Day Stay Rate</span><span class="rrow-val">$${dayRate} · ${dayFrom||'—'} – ${dayTo||'—'}</span></div>` : ''}
      ${nightRate ? `<div class="rrow"><span class="rrow-label">🌙 Night Stay Rate</span><span class="rrow-val">$${nightRate} · ${nightFrom||'—'} – ${nightTo||'—'}</span></div>` : ''}
      ${weekly ? `<div class="rrow"><span class="rrow-label">📅 Weekly Rate</span><span class="rrow-val">$${weekly}/week</span></div>` : ''}`;
  } else {
    const rent = document.getElementById('fRent').value || '—';
    priceLine = rent !== '—' ? `$${rent}` : '—';
    extraRows = `<div class="rrow"><span class="rrow-label">Monthly Rent</span><span class="rrow-val">${priceLine !== '—' ? priceLine + '/mo' : '—'}</span></div>`;
  }

  let studentRows = '';
  if (cat === 'students') {
    const uni = document.getElementById('fUniversityVal')?.value;
    const spr = document.getElementById('fStudentsPerRoom')?.value;
    studentRows = `
      ${uni ? `<div class="rrow"><span class="rrow-label">🏫 Nearest University</span><span class="rrow-val">${uni}</span></div>` : ''}
      ${spr ? `<div class="rrow"><span class="rrow-label">👥 Students / Room</span><span class="rrow-val">${spr}</span></div>` : ''}`;
  }

  document.getElementById('reviewContent').innerHTML = `
    <div class="review-hero-card">
      <img class="review-hero-img" src="${heroImg}" alt="${title}">
      <div class="review-hero-fade"></div>
      <div class="review-hero-info">
        <div class="review-eyebrow">Listing Preview</div>
        <div class="review-prop-name">${title}</div>
        <div class="review-location">📍 ${loc}</div>
        <div class="review-price">${priceLine}<span style="font-family:'DM Sans',sans-serif;font-size:14px;font-weight:400;color:rgba(255,255,255,0.6);margin-left:6px;">${cat === 'guests' ? 'day stay' : '/month'}</span></div>
      </div>
    </div>
    <div class="review-rows">
      <div class="rrow"><span class="rrow-label">Property Type</span><span class="rrow-val">${type}</span></div>
      <div class="rrow"><span class="rrow-label">Suitable For</span><span class="rrow-val">${who.join(', ') || '—'}</span></div>
      <div class="rrow"><span class="rrow-label">Rooms Available</span><span class="rrow-val">${rooms}</span></div>
      ${extraRows}
      ${studentRows}
      <div class="rrow"><span class="rrow-label">WhatsApp Contact</span><span class="rrow-val">${phone !== '—' ? formatPhone(phone) : phone}</span></div>
      ${(() => { const cp = document.getElementById('fCallPhone')?.value; return cp ? `<div class="rrow"><span class="rrow-label">📞 Call Number</span><span class="rrow-val">${formatPhone(cp)}</span></div>` : ''; })()}
      <div class="rrow"><span class="rrow-label">Photos Uploaded</span><span class="rrow-val">${uploadedPhotos.length} photo${uploadedPhotos.length !== 1 ? 's' : ''}</span></div>
    </div>
    ${amenities.length ? `<div style="margin-bottom:16px;"><div class="asec-label" style="margin-bottom:10px;">Selected Amenities</div><div class="review-amenities">${amenities.map(a => `<span class="ramenity">${esc(a)}</span>`).join('')}</div></div>` : ''}
    <div><div class="asec-label" style="margin-bottom:10px;">Your Description</div><div class="review-desc">${desc}</div></div>`;
}

// ── Listing rate-limit state (session-scoped, not persisted) ──
const _listingRateLimit = { lastSubmit: 0, sessionCount: 0 };
const _LISTING_COOLDOWN_MS  = 30_000; // 30 s between submissions
const _LISTING_SESSION_CAP  = 10;     // max new listings per session

async function submitListing() {
  // ── Skip all rate-limit checks when editing an existing listing ──
  const _editingNow = (typeof Auth !== 'undefined') ? Auth._editingId : null;
  if (!_editingNow) {
    // 1. Cooldown check
    const _msSinceLast = Date.now() - _listingRateLimit.lastSubmit;
    if (_listingRateLimit.lastSubmit && _msSinceLast < _LISTING_COOLDOWN_MS) {
      const _secsLeft = Math.ceil((_LISTING_COOLDOWN_MS - _msSinceLast) / 1000);
      toast(`⏳ Please wait ${_secsLeft}s before submitting another listing`); return;
    }
    // 2. Session cap
    if (_listingRateLimit.sessionCount >= _LISTING_SESSION_CAP) {
      toast('🚫 Maximum listings reached for this session. Refresh to continue.'); return;
    }
    // 3. Duplicate title + location check
    const _titleVal    = (document.getElementById('fTitle')?.value    || '').trim().toLowerCase();
    const _locationVal = (document.getElementById('fLocation')?.value || '').trim().toLowerCase();
    if (_titleVal && _locationVal) {
      const _isDupe = myListings.some(l =>
        (l.title    || '').trim().toLowerCase() === _titleVal &&
        (l.location || '').trim().toLowerCase() === _locationVal
      );
      if (_isDupe) { toast('⚠️ A listing with this title and location already exists'); return; }
    }
  }

  const type = document.querySelector('.tcard.selected .tcard-name')?.textContent || '';
  const cat = getActiveCategory();
  const isGuest = cat === 'guests';
  const isStudent = cat === 'students';
  // Derive role and category strings from selectedCategory
  const roleLookup = { student: 'student', family: 'tenant', tenant: 'tenant', lodge: 'lodge' };
  const catLookup  = { student: 'student', family: 'tenant', tenant: 'tenant', lodge: 'lodge' };
  const forWhoLookup = {
    student: ['Students'],
    family:  ['Families', 'Professionals'],
    tenant:  ['Families', 'Professionals'],
    lodge:   ['Guests'],
  };
  const listingRole     = roleLookup[selectedCategory]  || 'tenant';
  const listingCategory = catLookup[selectedCategory]   || 'tenant';
  const listingForWho   = forWhoLookup[selectedCategory] || ['Anyone'];
  const _s = (typeof Auth !== 'undefined' && Auth._session) ? Auth._session() : (()=>{ try { return JSON.parse(localStorage.getItem('rc_session')); } catch(e){ return null; }})();
  const newL = {
    id: Date.now(),
    _ownerCode: (_s && _s.code) ? _s.code : '',
    title: document.getElementById('fTitle').value,
    location: document.getElementById('fLocation').value,
    rent: isGuest ? 0 : (parseInt(document.getElementById('fRent').value) || 0),
    rooms: parseInt(document.getElementById('fRooms').value) || 1,
    phone: document.getElementById('fPhone').value,
    callPhone: document.getElementById('fCallPhone')?.value || document.getElementById('fPhone').value,
    desc: document.getElementById('fDesc').value,
    type, photo: uploadedPhotos.length ? uploadedPhotos[0] : (TYPE_PHOTOS[type] || TYPE_PHOTOS['Full House']),
    role: listingRole,
    category: listingCategory,
    forWho: listingForWho,
    amenities: Array.from(document.querySelectorAll('#fs3 .chip.on')).map(e => e.dataset.val),
    verified: false, photos: [...uploadedPhotos],
    listedAt: Date.now(),
    nearestUniversity: isStudent ? (document.getElementById('fUniversityVal')?.value || '') : '',
    studentsPerRoom: isStudent ? (document.getElementById('fStudentsPerRoom')?.value || '') : '',
    hourlyRate: isGuest ? (document.getElementById('fHourlyRate')?.value || '') : '',
    dayRate: isGuest ? (document.getElementById('fDayRate')?.value || '') : '',
    dayFrom: isGuest ? (document.getElementById('fDayFrom')?.value || '') : '',
    dayTo: isGuest ? (document.getElementById('fDayTo')?.value || '') : '',
    nightRate: isGuest ? (document.getElementById('fNightRate')?.value || '') : '',
    nightFrom: isGuest ? (document.getElementById('fNightFrom')?.value || '') : '',
    nightTo: isGuest ? (document.getElementById('fNightTo')?.value || '') : '',
    weeklyRate: isGuest ? (document.getElementById('fWeeklyRate')?.value || '') : '',
  };
  // ── Edit vs. Create ──
  const editingId = (typeof Auth !== 'undefined') ? Auth._editingId : null;
  if (editingId) {
    // Update existing listing in-place
    const idx = myListings.findIndex(l => l.id === editingId);
    if (idx > -1) { myListings[idx] = { ...myListings[idx], ...newL, id: editingId }; newL.id = editingId; }
    const gi = listings.findIndex(l => l.id === editingId);
    if (gi > -1) listings[gi] = { ...listings[gi], ...newL, id: editingId };
    // If category changed away from lodge, remove orphan from myLodges,
    // public lodges array, rc_myLodges localStorage, and Supabase lodges row
    if (selectedCategory !== 'lodge') {
      const li = myLodges.findIndex(l => l.id === editingId);
      if (li > -1) {
        const removedLodge = myLodges[li];
        myLodges.splice(li, 1);
        // Remove from public lodges array
        const pli = lodges.findIndex(l => l.id === editingId);
        if (pli > -1) lodges.splice(pli, 1);
        // Remove from rc_myLodges localStorage
        try {
          const storedLodges = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
          localStorage.setItem('rc_myLodges', JSON.stringify(storedLodges.filter(l => l.id !== editingId)));
        } catch(e) {}
        // Delete from Supabase lodges table
        if (removedLodge && removedLodge._dbId) {
          deleteLodgeFromSupabase(removedLodge._dbId);
        }
      }
    }
    // ── Capture _dbId BEFORE Auth._editingId is cleared and before myListings is further mutated ──
    // Search both myListings (by editingId) and the already-updated idx entry to find _dbId.
    // This handles remote-only listings that were never in myListings locally.
    const _preEditEntry = (idx > -1 ? myListings[idx] : null)
      || myListings.find(l => l.id === editingId)
      || listings.find(l => l.id === editingId);
    const _editDbId = _preEditEntry?._dbId || null;
    Auth._editingId = null;
    // ── Sync edited listing to localStorage so it survives a refresh ──
    try {
      const _stored = JSON.parse(localStorage.getItem('rc_myListings') || '[]');
      const _si = _stored.findIndex(l => l.id === editingId);
      if (_si > -1) _stored[_si] = { ..._stored[_si], ...newL, id: editingId };
      else _stored.push({ ...newL, id: editingId });
      localStorage.setItem('rc_myListings', JSON.stringify(_stored));
    } catch(e) {}
    // ── Sync edit to Supabase ──
    if (_editDbId) {
      (async () => {
        try {
          const locationParts = (newL.location || '').split(',');
          // Location string is "suburb, city[, ward]"
          const _suburb = locationParts[0]?.trim() || '';
          const _city   = locationParts[1]?.trim() || '';
          const _ward   = locationParts[2]?.trim() || '';
          const { error } = await db.from('properties').update({
            title:               newL.title              || '',
            city:                _city,
            suburb:              _suburb,
            ward:                _ward,
            type:                newL.type               || '',
            price:               newL.rent               || 0,
            bedrooms:            newL.rooms              || 1,
            description:         newL.desc               || '',
            whatsapp:            newL.phone              || '',
            call_phone:          newL.callPhone          || newL.phone || '',
            amenities:           JSON.stringify(newL.amenities || []),
            category:            newL.category           || 'tenant',
            role:                newL.role               || 'tenant',
            for_who:             JSON.stringify(newL.forWho || ['Anyone']),
            nearest_university:  newL.nearestUniversity  || '',
            students_per_room:   newL.studentsPerRoom    || '',
            hourly_rate:         parseFloat(newL.hourlyRate) || 0,
            day_rate:            parseFloat(newL.dayRate)    || 0,
            day_from:            newL.dayFrom            || '',
            day_to:              newL.dayTo              || '',
            night_rate:          parseFloat(newL.nightRate)  || 0,
            night_from:          newL.nightFrom          || '',
            night_to:            newL.nightTo            || '',
            weekly_rate:         parseFloat(newL.weeklyRate) || 0,
            photo:               newL.photo              || '',
            photos:              JSON.stringify(newL.photoUrls || []),
          }).eq('id', _editDbId);
          if (error) console.warn('Listing update error:', error.message);
          else console.log('✅ Listing updated in Supabase');
        } catch(e) { console.warn('Listing update failed:', e); }
      })();
    }
    // ── Re-render dashboard immediately so stale title/price don't linger ──
    if (typeof Auth !== 'undefined' && typeof Auth.renderDashboard === 'function') {
      Auth.renderDashboard(myListings);
    }
    toast('✓ Listing updated!');
  } else {
    // ── Stamp rate-limit state for new listings ──
    _listingRateLimit.lastSubmit = Date.now();
    _listingRateLimit.sessionCount++;
    myListings.push(newL); listings.unshift(newL);
    // ── Upload photo then save to Supabase — await so success page shows after ──
    // FIX: localStorage is now saved AFTER saveListingToSupabase returns so _dbId
    // is written back onto newL before we store it. Previously saving before the
    // await meant _dbId was missing, and the ghost-purge on next load deleted the listing.
    toast('⏳ Saving your listing…');
    try {
      const fileToUpload = window._pendingPhotoFile || window._confirmedPhotoFile;
      if (fileToUpload) {
        const url = await uploadPhotoToSupabase(fileToUpload);
        if (url) {
          newL.photoUrls = [url];
          newL.photo     = url;
        }
        window._pendingPhotoFile = null;
        window._confirmedPhotoFile = null;
      }
      await saveListingToSupabase(newL); // writes _dbId back onto newL
      console.log('Listing synced to Supabase database');
      // ── Persist to localStorage AFTER _dbId is written back ──
      try {
        const stored = JSON.parse(localStorage.getItem('rc_myListings') || '[]');
        stored.push(newL);
        localStorage.setItem('rc_myListings', JSON.stringify(stored));
      } catch(e) {}
    } catch(e) {
      console.warn('Supabase save failed:', e);
      toast('⚠️ Listing saved locally — sync failed. It will retry on next load.');
      // ── Fallback: save without _dbId so listing isn't lost if network fails ──
      try {
        const stored = JSON.parse(localStorage.getItem('rc_myListings') || '[]');
        stored.push(newL);
        localStorage.setItem('rc_myListings', JSON.stringify(stored));
      } catch(e2) {}
    }
  }

  // Reveal the landlord nav dropdown now that they have a listing
  showLandlordDropdown();
  
  // If this is a lodge listing, also add/update in myLodges so it appears in Book a Lodge
  if (selectedCategory === 'lodge') {
    const lodgeEntry = {
      id: newL.id,
      name: newL.title,
      location: newL.location,
      type: type,
      pricePerNight: parseInt(document.getElementById('fNightRate')?.value || document.getElementById('fDayRate')?.value || 0) || 0,
      hourlyRate: document.getElementById('fHourlyRate')?.value || '',
      dayRate: document.getElementById('fDayRate')?.value || '',
      weeklyRate: document.getElementById('fWeeklyRate')?.value || '',
      chalets: parseInt(document.getElementById('fRooms').value) || 1,
      maxGuests: (parseInt(document.getElementById('fRooms').value) || 1) * 4,
      phone: document.getElementById('fPhone').value,
      callPhone: document.getElementById('fCallPhone')?.value || document.getElementById('fPhone').value,
      desc: document.getElementById('fDesc').value,
      features: Array.from(document.querySelectorAll('#fs3 .chip.on')).map(e => e.dataset.val),
      stars: 4, available: true,
      photo: newL.photo,
      photoUrls: newL.photos && newL.photos.length ? newL.photos : (newL.photo ? [newL.photo] : []),
    };
    // FIX 6: upsert — update existing lodge if editing, otherwise push new
    const existingLodgeIdx = myLodges.findIndex(l => l.id === lodgeEntry.id);
    if (existingLodgeIdx !== -1) {
      myLodges[existingLodgeIdx] = { ...myLodges[existingLodgeIdx], ...lodgeEntry };
    } else {
      myLodges.push(lodgeEntry);
    }
    // FIX: also upsert into public lodges array so it appears in browse immediately
    const existingPublicIdx = lodges.findIndex(l => l.id === lodgeEntry.id);
    if (existingPublicIdx !== -1) {
      lodges[existingPublicIdx] = { ...lodges[existingPublicIdx], ...lodgeEntry };
    } else {
      lodges.unshift(lodgeEntry);
    }
    // FIX: save to Supabase lodges table — previously only saved to `properties`
    lodgeEntry._ownerCode = newL._ownerCode || '';
    saveLodgeToSupabase(lodgeEntry);
  }
  
  // Reset flow
  uploadedPhotos = []; _pendingPhotoSrc = null; currentStep = 1;
  document.querySelectorAll('.tcard').forEach(e => e.classList.remove('selected'));
  document.querySelectorAll('#fs3 .chip').forEach(e => {
    e.classList.remove('on');
    const i = e.querySelector('.chip-ico'); if (i) i.style.transform = '';
  });
  ['fTitle','fRent','fRooms','fPhone','fCallPhone','fDesc','fUniversity','fUniversityVal','fStudentsPerRoom','fHourlyRate','fDayRate','fNightRate','fWeeklyRate'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.querySelectorAll('#studentsPerRoomPicker .spr-btn').forEach(b => b.classList.remove('selected'));
  clearLocation();
  renderPreviews();
  
  // Clear saved form
  RC.clearSavedForm();
  
  // Show success page (new listing) or return to dashboard (edit)
  const _wasEditing = !!(typeof editingId !== 'undefined' && editingId);
  setTimeout(() => {
    if (_wasEditing) {
      if (typeof Auth !== 'undefined' && typeof Auth.showTab === 'function') Auth.showTab('listings');
      showPage('pg-dashboard');
    } else {
      showPage('pg-success');
    }
  }, 80);
}

// ══════════════════════════════════════
//  MY LISTINGS
// ══════════════════════════════════════
let myListingsTab = 'props';

function switchMyTab(tab) {
  myListingsTab = tab;
  document.getElementById('tabProps').classList.toggle('active', tab === 'props');
  document.getElementById('tabLodges').classList.toggle('active', tab === 'lodges');
  document.getElementById('myPropsPanel').style.display = tab === 'props' ? '' : 'none';
  document.getElementById('myLodgesPanel').style.display = tab === 'lodges' ? '' : 'none';
  if (tab === 'lodges') renderMyLodges();
}

function showMyListings() {
  const grid = document.getElementById('myListingsGrid');
  if (myListings.length === 0) {
      grid.innerHTML = `
      <div style="text-align:center;padding:52px 0;color:var(--text-tertiary);">
        <img src="https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=400&q=70&auto=format&fit=crop" style="width:160px;height:110px;object-fit:cover;border-radius:16px;margin:0 auto 20px;display:block;opacity:0.6;border:1px solid var(--seam2);">
        <div style="font-family:'DM Serif Display',serif;font-size:22px;color:var(--text-primary);margin-bottom:8px;">No properties yet</div>
        <div style="font-size:14px;margin-bottom:24px;font-weight:400;color:var(--text-secondary);">Post your first property to start receiving tenant enquiries</div>
        <button onclick="openListingFlow()" style="background:var(--emerald);color:#fff;border:none;padding:13px 28px;border-radius:var(--r);font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:var(--shadow-emerald);">+ Post Your First Property</button>
      </div>`;
  } else {
    // Only show non-lodge listings in the Properties tab
    const propListings = myListings.filter(l => l.role !== 'lodge' && l.category !== 'lodge');
    if (propListings.length === 0) {
      grid.innerHTML = `
      <div style="text-align:center;padding:40px 0;color:var(--text-tertiary);">
        <div style="font-size:42px;margin-bottom:14px;">🏠</div>
        <div style="font-family:'DM Serif Display',serif;font-size:20px;color:var(--text-primary);margin-bottom:8px;">No property listings yet</div>
        <div style="font-size:14px;margin-bottom:22px;color:var(--text-secondary);">Your lodge listings are in the Lodges tab below</div>
        <button onclick="openListingFlow()" style="background:var(--emerald);color:#fff;border:none;padding:13px 28px;border-radius:var(--r);font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:var(--shadow-emerald);">+ Post a Property</button>
      </div>`;
    } else {
    grid.innerHTML = propListings.map(l => {
      const priceDisplay = `$${l.rent}/mo`;
      return `
      <div class="my-listing-row" onclick="openDetail('${l.id}')">
        <img class="my-thumb" src="${l.photo}" alt="${esc(l.title)}" onerror="onImgError(this)">
        <div class="my-info">
          <div class="my-name">${esc(l.title)}</div>
          <div class="my-loc">📍 ${esc(l.location)} · ${esc(l.type)}</div>
          <div class="my-price">${priceDisplay}</div>
        </div>
        <div class="my-actions" onclick="event.stopPropagation()">
          <button class="btn-del-sm" onclick="Auth.deleteListing('${l.id}')">Delete</button>
        </div>
      </div>`;
    }).join('');
    }
  }
  switchMyTab('props');
  showPage('pg-mylistings');
}

function renderMyLodges() {
  const grid = document.getElementById('myLodgesGrid');
  // Combine myLodges with any lodge-category entries in myListings (avoid duplicates by id)
  const lodgeFromListings = myListings
    .filter(l => (l.role === 'lodge' || l.category === 'lodge'))
    .map(l => {
      // Convert listing format to lodge format for display
      const parts = [];
      if (l.hourlyRate) parts.push(`$${l.hourlyRate}/hr`);
      if (l.dayRate) parts.push(`$${l.dayRate}/day`);
      if (l.nightRate) parts.push(`$${l.nightRate}/night`);
      const priceDisplay = parts.length ? parts.join(' · ') : (l.weeklyRate ? `$${l.weeklyRate}/wk` : 'Short Stay');
      return { ...l, _isListingEntry: true, _priceDisplay: priceDisplay, name: l.title, features: l.amenities || [] };
    });
  const allMyLodgeIds = new Set(myLodges.map(x => x.id));
  const combinedLodges = [...myLodges, ...lodgeFromListings.filter(l => !allMyLodgeIds.has(l.id))];

  if (combinedLodges.length === 0) {
    grid.innerHTML = `
      <div style="text-align:center;padding:40px 0;color:var(--text-tertiary);">
        <div style="font-size:48px;margin-bottom:14px;">🏨</div>
        <div style="font-family:'DM Serif Display',serif;font-size:20px;color:var(--text-primary);margin-bottom:8px;">No lodges listed yet</div>
        <div style="font-size:14px;margin-bottom:22px;color:var(--text-secondary);">List your lodge to start receiving booking requests</div>
        <button onclick="showListLodge()" style="background:#F59E0B;color:#000;border:none;padding:13px 28px;border-radius:var(--r);font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(245,158,11,0.28);">+ List Your First Lodge</button>
      </div>`;
  } else {
    grid.innerHTML = combinedLodges.map(l => `
      <div class="my-listing-row" onclick="openLodgeDetail('${l.id}')">
        <img class="my-thumb" src="${l.photo}" alt="${esc(l.name || l.title)}" style="border-radius:12px;" onerror="onImgError(this)">
        <div class="my-info">
          <div class="my-name">${esc(l.name || l.title)}</div>
          <div class="my-loc">📍 ${esc(l.location)} · ${l.type || 'Lodge'}</div>
          <div class="my-price" style="color:#D97706;font-size:13px;">${l._priceDisplay || ('$' + l.pricePerNight + '/night')}</div>
        </div>
        <div class="my-actions" onclick="event.stopPropagation()">
          <button class="btn-del-sm" onclick="deleteMyLodge('${l.id}')">Delete</button>
        </div>
      </div>`).join('');
  }
}

function deleteMyLodge(id) {
  id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
  if (!confirm('Remove this lodge listing?')) return;
  // Clear edit state if this lodge was being edited
  if (window._editingLodgeId === id) window._editingLodgeId = null;
  // ── Delete from Supabase ──
  const deletedLodge = myLodges.find(l => l.id === id) || lodges.find(l => l.id === id);
  if (deletedLodge && deletedLodge._dbId) deleteLodgeFromSupabase(deletedLodge._dbId);
  // FIX: if lodge was created via the property form it also has a row in the
  // properties table — delete it too, otherwise it reappears in browse on next load
  const deletedListingEntry = myListings.find(l => l.id === id) || listings.find(l => l.id === id);
  if (deletedListingEntry && deletedListingEntry._dbId) deleteListingFromSupabase(deletedListingEntry._dbId);
  // ── Remove from localStorage ──
  try {
    const stored = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
    localStorage.setItem('rc_myLodges', JSON.stringify(stored.filter(l => l.id !== id)));
  } catch(e) {}
  // FIX: also remove from rc_myListings if lodge was created via the property form
  // (those lodges are stored in rc_myListings, not rc_myLodges, so they would
  //  reappear as ghost lodges on next reload without this)
  try {
    const storedL = JSON.parse(localStorage.getItem('rc_myListings') || '[]');
    localStorage.setItem('rc_myListings', JSON.stringify(storedL.filter(l => l.id !== id)));
  } catch(e) {}
  // ── Remove from local arrays ──
  myLodges = myLodges.filter(l => l.id !== id);
  // Also remove from myListings and listings if it was listed through the main flow
  myListings = myListings.filter(l => l.id !== id);
  const i = listings.findIndex(l => l.id === id);
  if (i > -1) listings.splice(i, 1);
  renderMyLodges(); toast('✓ Lodge removed');
  if (typeof filterListings === 'function') filterListings();
  if (typeof filterLodges === 'function') filterLodges();
}

// ══════════════════════════════════════
//  LODGE DATA
// ══════════════════════════════════════
// Lodges array — shared with Supabase helpers in the first script block
var lodges = window.lodges; // alias for use in this script block

var myLodges = window.myLodges; // alias for use in this script block
let lodgeStep = 1;
const LODGE_STEPS = 4;
const LODGE_STEP_LABELS = ['Lodge Type','Features','Details','Review & Publish'];

// ══════════════════════════════════════
//  LODGE BROWSE
// ══════════════════════════════════════
function showLodges() {
  console.log(`⏱️ [lodges] showLodges() called at +${performance.now().toFixed(0)}ms — in-memory lodges count: ${lodges.length}`);
  updateNav(null, 'lodge');
  populateLodgeDropdowns(); // populate dynamic lodge filter dropdowns
  // Show skeletons if lodges haven't loaded yet — avoids flash of empty state
  if (!lodges.length) {
    console.log('⏱️ [lodges] no cached data yet — showing skeletons, waiting on network fetch');
    const g = document.getElementById('lodgeGrid');
    if (g) g.innerHTML = Array(6).fill(rcSkeletonCard()).join('');
  } else {
    filterLodges();
  }
  showPage('pg-lodges');
}

// ══════════════════════════════════════
//  LIST LODGE FLOW
// ══════════════════════════════════════
function showListLodge() {
  lodgeStep = 1;
  // Populate city dropdown in lodge listing form from ZW_LOCATIONS
  const llCity = document.getElementById('llCity');
  if (llCity) {
    const cities = Object.keys(ZW_LOCATIONS).sort();
    llCity.innerHTML = '<option value="">Select city…</option>' +
      cities.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  const llTownField = document.getElementById('llTownField');
  if (llTownField) llTownField.style.display = 'none';
  showLodgeStep(1);
  showPage('pg-lodge-list');
}

// ── Lodge Edit ──
window._editingLodgeId = null;

function openEditLodge(id) {
  id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
  const l = [...myLodges, ...lodges].find(x => x.id === id);
  if (!l) { toast('Lodge not found'); return; }
  window._editingLodgeId = id;

  // Init form exactly like showListLodge, then pre-fill
  lodgeStep = 1;
  const llCity = document.getElementById('llCity');
  if (llCity) {
    const cities = Object.keys(ZW_LOCATIONS).sort();
    llCity.innerHTML = '<option value="">Select city…</option>' +
      cities.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  const llTownField = document.getElementById('llTownField');
  if (llTownField) llTownField.style.display = 'none';

  showPage('pg-lodge-list');

  // Pre-fill synchronously — showPage only toggles CSS classes so all
  // elements are already in the DOM; no setTimeout needed.

  // Step 1: pre-select lodge type card
  document.querySelectorAll('.lodge-tcard').forEach(c => {
    const nm = c.querySelector('.tcard-name')?.textContent || '';
    c.classList.toggle('selected', nm === l.type);
  });

  // Step 2: pre-tick feature chips
  document.querySelectorAll('.lodge-feat-chip').forEach(c => {
    const on = (l.features || []).includes(c.dataset.feat);
    c.classList.toggle('on', on);
    const check = c.querySelector('.lf-check');
    if (check) check.textContent = on ? '✓' : '';
  });

  // Start at step 1 so type-card selection is visible and validation runs in order
  lodgeStep = 1;
  showLodgeStep(1);
  const _nb = document.getElementById('lodgeFlowNext');
  if (_nb) _nb.textContent = 'Continue →';

  // Pre-fill text fields
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('llName',      l.name);
  set('llPrice',     l.pricePerNight);
  set('llHourlyRate',l.hourlyRate);
  set('llDayRate',   l.dayRate);
  set('llWeeklyRate',l.weeklyRate);
  set('llRooms',     l.chalets);
  set('llGuests',    l.maxGuests);
  set('llPhone',     l.phone);
  set('llCallPhone', l.callPhone);
  set('llDesc',      l.desc);

  // Pre-fill location — city dropdown is already populated above; town needs
  // a small defer so onLlCityChange can finish building the town options first.
  const locParts = (l.location || '').split(',');
  const city = locParts[0]?.trim() || '';
  const town = locParts[1]?.trim() || '';
  if (city && llCity) {
    llCity.value = city;
    if (typeof onLlCityChange === 'function') onLlCityChange();
    setTimeout(() => {
      const llTown = document.getElementById('llTown');
      if (llTown && town) llTown.value = town;
    }, 50);
  } else {
    set('llLocation', l.location);
  }
}

function showLodgeStep(n) {
  document.querySelectorAll('.lodge-list-step').forEach(s => s.classList.remove('active'));
  document.getElementById('lls' + n).classList.add('active');
  document.getElementById('lodgeFlowLabel').textContent = LODGE_STEP_LABELS[n-1];
  document.getElementById('lodgeFlowCount').textContent = 'Step ' + n + ' of ' + LODGE_STEPS;
  document.getElementById('lodgeProgFill').style.width = ((n / LODGE_STEPS) * 100) + '%';
  document.getElementById('lodgeFlowPrev').style.visibility = n === 1 ? 'hidden' : 'visible';
  const nb = document.getElementById('lodgeFlowNext');
  nb.textContent = n === LODGE_STEPS ? 'Publish Lodge ✓' : 'Continue →';
  if (n === LODGE_STEPS) buildLodgeReview();
  window.scrollTo(0,0);
}

function selectLodgeType(el) {
  document.querySelectorAll('.lodge-tcard').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

function lodgeFlowNextFn() {
  // ── Step 1: type-card must be selected before advancing ──
  if (lodgeStep === 1 && !document.querySelector('.lodge-tcard.selected')) { toast('Please select a lodge type'); return; }
  // ── Step 3: details validation ──
  if (lodgeStep === 3) {
    if (!document.getElementById('llName').value.trim()) { toast('Please enter the lodge name'); return; }
    if (!document.getElementById('llLocation').value.trim()) { toast('Please enter the location'); return; }
    if (!document.getElementById('llPrice').value) { toast('Please enter price per night'); return; }
    if (!document.getElementById('llPhone').value.trim()) { toast('Please enter a WhatsApp number'); return; }
    const llRawPhone = document.getElementById('llPhone').value.replace(/\D/g,'');
    if (llRawPhone.length !== 10) { toast('WhatsApp number must be exactly 10 digits'); return; }
    if (!isValidZwPhone(llRawPhone)) { toast('Enter a valid Zimbabwean mobile number (071 / 073 / 077 / 078)'); return; }
    const llRawCall = document.getElementById('llCallPhone')?.value?.replace(/\D/g,'') || '';
    if (llRawCall && llRawCall.length !== 10) { toast('Call number must be exactly 10 digits'); return; }
    if (llRawCall && !isValidZwPhone(llRawCall)) { toast('Call number must be a valid Zimbabwean mobile number (071 / 073 / 077 / 078)'); return; }
    if (!document.getElementById('llDesc').value.trim()) { toast('Please add a description'); return; }
  }
  // ── Guard: only submit from the final review step ──
  if (lodgeStep === LODGE_STEPS) { submitLodge(); return; }
  // ── Guard: clamp lodgeStep so it can never skip past LODGE_STEPS ──
  if (lodgeStep > LODGE_STEPS) { console.warn('lodgeStep out of sync, resetting to', LODGE_STEPS); lodgeStep = LODGE_STEPS; showLodgeStep(lodgeStep); return; }
  lodgeStep++; showLodgeStep(lodgeStep);
}

function lodgeFlowPrevFn() {
  if (lodgeStep === 1) { showLodges(); return; }
  lodgeStep--; showLodgeStep(lodgeStep);
}

function buildLodgeReview() {
  const type = document.querySelector('.lodge-tcard.selected .tcard-name')?.textContent || '—';
  const feats = Array.from(document.querySelectorAll('.lodge-feat-chip.on')).map(e => e.dataset.feat);
  const name = document.getElementById('llName').value || '—';
  const loc = document.getElementById('llLocation').value || '—';
  const price = document.getElementById('llPrice').value || '—';
  const hourlyRate = document.getElementById('llHourlyRate')?.value || '';
  const dayRate = document.getElementById('llDayRate')?.value || '';
  const weeklyRate = document.getElementById('llWeeklyRate')?.value || '';
  const rooms = document.getElementById('llRooms').value || '—';
  const guests = document.getElementById('llGuests').value || '—';
  const phone = document.getElementById('llPhone').value || '—';
  const callPhoneVal = document.getElementById('llCallPhone')?.value || '';
  const desc = document.getElementById('llDesc').value || '—';
  const LODGE_TYPE_PHOTOS = {
    'Bush Lodge':'https://images.unsplash.com/photo-1489392191049-fc10c97e64b6?w=600&q=80',
    'Lake Lodge':'https://images.unsplash.com/photo-1590523741831-ab7e8b8f9c7f?w=600&q=80',
    'Mountain Retreat':'https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=600&q=80',
    'City Boutique':'https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=600&q=80',
    'Safari Camp':'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=600&q=80',
    'Eco Lodge':'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=600&q=80',
  };
  const heroImg = LODGE_TYPE_PHOTOS[type] || LODGE_TYPE_PHOTOS['Bush Lodge'];
  document.getElementById('lodgeReviewContent').innerHTML = `
    <div class="review-hero-card">
      <img class="review-hero-img" src="${heroImg}" alt="${name}">
      <div class="review-hero-fade"></div>
      <div class="review-hero-info">
        <div class="review-eyebrow">${type}</div>
        <div class="review-prop-name">${name}</div>
        <div class="review-location">📍 ${loc}</div>
        <div class="review-price" style="color:#FCD34D">$${price}<span style="font-size:14px;font-weight:400;color:rgba(255,255,255,0.6);margin-left:6px;">/night</span></div>
      </div>
    </div>
    <div class="review-rows">
      <div class="rrow"><span class="rrow-label">Lodge Type</span><span class="rrow-val">${type}</span></div>
      <div class="rrow"><span class="rrow-label">Chalets / Rooms</span><span class="rrow-val">${rooms}</span></div>
      <div class="rrow"><span class="rrow-label">Max Guests</span><span class="rrow-val">${guests}</span></div>
      ${hourlyRate ? `<div class="rrow"><span class="rrow-label">⏱️ Hourly Rate</span><span class="rrow-val">$${hourlyRate}/hr</span></div>` : ''}
      ${price !== '—' ? `<div class="rrow"><span class="rrow-label">🌙 Night Stay Rate</span><span class="rrow-val">$${price}/night</span></div>` : ''}
      ${dayRate ? `<div class="rrow"><span class="rrow-label">🌞 Day Stay Rate</span><span class="rrow-val">$${dayRate}/day</span></div>` : ''}
      ${weeklyRate ? `<div class="rrow"><span class="rrow-label">📅 Weekly Rate</span><span class="rrow-val">$${weeklyRate}/week</span></div>` : ''}
      <div class="rrow"><span class="rrow-label">WhatsApp</span><span class="rrow-val">${phone !== '—' ? formatPhone(phone) : phone}</span></div>
      ${callPhoneVal ? `<div class="rrow"><span class="rrow-label">📞 Call Number</span><span class="rrow-val">${formatPhone(callPhoneVal)}</span></div>` : ''}
    </div>
    ${feats.length ? `<div class="review-amenities">${feats.map(f=>`<span class="ramenity">${f}</span>`).join('')}</div>` : ''}
    <div class="review-desc">${desc}</div>`;
}

function submitLodge() {
  const type = document.querySelector('.lodge-tcard.selected .tcard-name')?.textContent || '';
  const LODGE_TYPE_PHOTOS = {
    'Bush Lodge':'https://images.unsplash.com/photo-1489392191049-fc10c97e64b6?w=600&q=80',
    'Lake Lodge':'https://images.unsplash.com/photo-1590523741831-ab7e8b8f9c7f?w=600&q=80',
    'Mountain Retreat':'https://images.unsplash.com/photo-1582268611958-ebfd161ef9cf?w=600&q=80',
    'City Boutique':'https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=600&q=80',
    'Safari Camp':'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=600&q=80',
    'Eco Lodge':'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=600&q=80',
  };
  const _ls = (()=>{ try { return JSON.parse(localStorage.getItem('rc_session')); } catch(e){ return null; }})();
  const newLodge = {
    id: Date.now(),
    _ownerCode: (_ls && _ls.code) ? _ls.code : '',
    name: document.getElementById('llName').value,
    location: document.getElementById('llLocation').value,
    type,
    pricePerNight: parseInt(document.getElementById('llPrice').value) || 0,
    hourlyRate: document.getElementById('llHourlyRate')?.value || '',
    dayRate: document.getElementById('llDayRate')?.value || '',
    weeklyRate: document.getElementById('llWeeklyRate')?.value || '',
    chalets: parseInt(document.getElementById('llRooms').value) || 1,
    maxGuests: parseInt(document.getElementById('llGuests').value) || 10,
    phone: document.getElementById('llPhone').value,
    callPhone: document.getElementById('llCallPhone')?.value || document.getElementById('llPhone').value,
    desc: document.getElementById('llDesc').value,
    features: Array.from(document.querySelectorAll('.lodge-feat-chip.on')).map(e => e.dataset.feat),
    stars: 4, available: true,
    photo: LODGE_TYPE_PHOTOS[type] || LODGE_TYPE_PHOTOS['Bush Lodge'],
  };
  const _editingLodgeId = window._editingLodgeId || null;
  if (_editingLodgeId) {
    // ── UPDATE existing lodge ──
    newLodge.id = _editingLodgeId;
    const existingLodge = myLodges.find(x => x.id === _editingLodgeId) || lodges.find(x => x.id === _editingLodgeId);
    if (existingLodge) {
      newLodge._dbId      = existingLodge._dbId;
      newLodge._ownerCode = existingLodge._ownerCode;
      newLodge._remote    = existingLodge._remote;
      // FIX Bug M: preserve existing photo unless a new file has been selected
      if (!window._pendingLodgePhotoFile && existingLodge.photo) {
        newLodge.photo     = existingLodge.photo;
        newLodge.photoUrls = existingLodge.photoUrls || [existingLodge.photo];
      }
    }
    const mi = myLodges.findIndex(x => x.id === _editingLodgeId);
    if (mi > -1) myLodges[mi] = { ...myLodges[mi], ...newLodge };
    else myLodges.push(newLodge);
    const gi = lodges.findIndex(x => x.id === _editingLodgeId);
    if (gi > -1) lodges[gi] = { ...lodges[gi], ...newLodge };

    // ── Upload new photo if provided, then upsert to Supabase ──
    // FIX: localStorage now saved INSIDE the async block after photo upload and
    // Supabase update complete — previously saved synchronously outside so the
    // updated photo URL was never written back to localStorage
    (async () => {
      if (window._pendingLodgePhotoFile) {
        const url = await uploadPhotoToSupabase(window._pendingLodgePhotoFile);
        if (url) { newLodge.photo = url; newLodge.photoUrls = [url]; }
        window._pendingLodgePhotoFile = null;
      }
      if (newLodge._dbId) {
        // Update existing Supabase row
        try {
          const { error } = await db.from('lodges').update({
            name:           newLodge.name            || '',
            location:       newLodge.location        || '',
            type:           newLodge.type            || '',
            price_per_night: newLodge.pricePerNight  || 0,
            hourly_rate:    parseFloat(newLodge.hourlyRate) || 0,
            day_rate:       parseInt(newLodge.dayRate)      || 0,
            weekly_rate:    parseInt(newLodge.weeklyRate)   || 0,
            chalets:        newLodge.chalets         || 1,
            max_guests:     newLodge.maxGuests       || 10,
            description:    newLodge.desc            || '',
            whatsapp:       newLodge.phone           || '',
            call_phone:     newLodge.callPhone       || newLodge.phone || '',
            features:       JSON.stringify(newLodge.features || []),
            photos:         JSON.stringify(newLodge.photoUrls || [])
          }).eq('id', newLodge._dbId);
          if (error) console.warn('Lodge update error:', error.message);
          else console.log('✅ Lodge updated in Supabase');
        } catch(e) { console.warn('Lodge update failed:', e); }
      } else {
        await saveLodgeToSupabase(newLodge); // also writes _dbId back onto newLodge
      }
      // ── Update localStorage AFTER photo upload and Supabase complete ──
      try {
        const stored = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
        const si = stored.findIndex(x => x.id === _editingLodgeId);
        if (si > -1) stored[si] = { ...stored[si], ...newLodge };
        else stored.push(newLodge);
        localStorage.setItem('rc_myLodges', JSON.stringify(stored));
      } catch(e) {}
    })();

    window._editingLodgeId = null;
  } else {
    // ── INSERT new lodge ──
    // Push to myLodges immediately so the dashboard shows it right away,
    // but do NOT push to the public lodges array yet — that happens after
    // Supabase returns with the real _dbId and photo URL, preventing the
    // duplicate-card + ghost-image bug caused by the async race condition.
    myLodges.push(newLodge);
    // ── Upload photo to Supabase Storage, then save lodge ──
    (async () => {
      if (window._pendingLodgePhotoFile) {
        const url = await uploadPhotoToSupabase(window._pendingLodgePhotoFile);
        if (url) {
          newLodge.photo    = url;
          newLodge.photoUrls = [url];
        }
        window._pendingLodgePhotoFile = null;
      }
      await saveLodgeToSupabase(newLodge); // writes _dbId back onto newLodge
      console.log('Lodge synced to Supabase database');
      // Now that _dbId and real photo are set, add to public lodges array.
      // Dedup guard prevents a second copy if loadLodgesFromSupabase already ran.
      if (!lodges.find(x => x._dbId && x._dbId === newLodge._dbId)) {
        lodges.unshift(newLodge);
      }
      // Re-render lodge grid so the real photo appears immediately
      if (typeof filterLodges === 'function') filterLodges();
      // ── Persist to localStorage AFTER _dbId is written back ──
      try {
        const stored = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
        stored.push(newLodge);
        localStorage.setItem('rc_myLodges', JSON.stringify(stored));
      } catch(e) {}
    })();
  }
  // reset
  lodgeStep = 1;
  window._pendingLodgePhotoFile = null;
  cancelLodgePhoto();
  document.querySelectorAll('.lodge-tcard').forEach(e => e.classList.remove('selected'));
  document.querySelectorAll('.lodge-feat-chip').forEach(e => { e.classList.remove('on'); const c = e.querySelector('.lf-check'); if(c) c.textContent=''; });
  ['llName','llLocation','llPrice','llHourlyRate','llDayRate','llWeeklyRate','llRooms','llGuests','llPhone','llCallPhone','llDesc'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const llCity = document.getElementById('llCity'); if (llCity) llCity.value = '';
  const llTown = document.getElementById('llTown'); if (llTown) llTown.value = '';
  const llTownField = document.getElementById('llTownField'); if (llTownField) llTownField.style.display = 'none';
  showPage('pg-lodge-success');
  setTimeout(RC.launchConfetti, 200);
}

// ══════════════════════════════════════
//  LODGE DETAIL PAGE
// ══════════════════════════════════════
let currentLodgeId = null;

function openLodgeDetail(id) {
  id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
  const l = [...lodges, ...myLodges].find(x => x.id === id);
  if (!l) return;
  currentLodgeId = id;
  // Remember which page we came from so Back works correctly
  const active = document.querySelector('.page.active');
  if (active) window._lastBrowsePage = active.id;
  updateNav(null, 'lodge');
  
  // Track views for weekend default
  const views = RC.trackLodgeView(id);
  // Track city for lodge owner banner
  RC.lastLodgeCity = l.location.split(',')[0]?.trim() || '';

  const stars = '★'.repeat(l.stars) + '☆'.repeat(5 - l.stars);
  const availBadge = l.available
    ? `<div class="lbadge-verified" style="font-size:12px;padding:6px 14px;background:#16a34a;">✓ Available</div>`
    : `<div style="background:#dc2626;color:#fff;padding:6px 14px;border-radius:100px;font-size:12px;font-weight:700;">Fully Booked</div>`;

  document.getElementById('lodgeDetailHero').innerHTML = `
    <img src="${l.photo}" alt="${esc(l.name)}" style="width:100%;height:100%;object-fit:cover;animation:heroZoom 20s ease-in-out infinite alternate;" onerror="onImgError(this)">
    <div class="lodge-detail-scrim"></div>
    <div class="lodge-detail-badges">${availBadge}<div style="background:rgba(255,255,255,0.22);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.4);color:#fff;padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;">${esc(l.type)}</div></div>
    <div class="lodge-detail-stars">${stars}</div>`;

  const waLodgeMsg = encodeURIComponent(`Hi! I saw *${esc(l.name)}* on RentaCrib ZW and would like to know more.`);
  const lodgeCallPhone = formatPhone(l.callPhone || l.phone || '');
  const lodgeWaPhone = formatPhone(l.phone || '').replace('+','');

  document.getElementById('lodgeDetailBody').innerHTML = `
    <div class="lodge-detail-top">
      <div class="lodge-detail-top-row">
        <h1 class="lodge-detail-name">${esc(l.name)}</h1>
        <div class="lodge-detail-price-block">
          <span class="lodge-detail-price">$${l.pricePerNight}</span>
          <div class="lodge-detail-price-note">per night</div>
          ${l.hourlyRate ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">⏱️ $${l.hourlyRate}/hr</div>` : ''}
          ${l.dayRate ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">🌞 $${l.dayRate}/day</div>` : ''}
          ${l.weeklyRate ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">📅 $${l.weeklyRate}/wk</div>` : ''}
        </div>
      </div>
      <div class="lodge-detail-meta">
        <div class="lodge-dmeta">📍 <strong>${esc(l.location)}</strong></div>
        <div class="lodge-dmeta">🏠 <strong>${l.chalets}</strong>&nbsp;chalets</div>
        <div class="lodge-dmeta">👥 Max&nbsp;<strong>${l.maxGuests}</strong>&nbsp;guests</div>
        <div class="lodge-dmeta" style="color:#D97706;border-color:rgba(245,158,11,0.2);">⭐ ${l.stars}-star</div>
      </div>
    </div>
    <div class="lodge-detail-section">
      <div class="detail-section-label">Lodge Features</div>
      <div class="lodge-feature-pills">
        ${(l.features || []).map(f => `<div class="lodge-feature-pill">${amenityIcon(f)} ${esc(f)}</div>`).join('')}
      </div>
    </div>
    <div class="lodge-detail-section">
      <div class="detail-section-label">About This Lodge</div>
      <p class="lodge-detail-desc">${esc(l.desc)}</p>
    </div>
    <div class="lodge-detail-section" style="padding-bottom:8px;">
      <div class="detail-section-label">Contact the Lodge</div>
      <div style="display:flex;gap:10px;margin-top:4px;">
        <a href="https://wa.me/${lodgeWaPhone}?text=${waLodgeMsg}" target="_blank" style="flex:1;text-decoration:none;">
          <button style="width:100%;background:#25D366;color:#fff;border:none;border-radius:var(--r);padding:13px 12px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s;" onmouseover="this.style.background='#1ebe5d'" onmouseout="this.style.background='#25D366'">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>
            WhatsApp Lodge
          </button>
        </a>
        ${lodgeCallPhone ? `<a href="tel:${lodgeCallPhone}" style="flex:1;text-decoration:none;">
          <button style="width:100%;background:var(--depth3);border:1.5px solid var(--seam2);color:var(--text-primary);border-radius:var(--r);padding:13px 12px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s;" onmouseover="this.style.background='var(--depth4)'" onmouseout="this.style.background='var(--depth3)'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 3.07 9.81a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 2 0h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L6.09 7.91A16 16 0 0 0 13 14.84l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.07 16l.85.92z"/></svg>
            Call Lodge
          </button>
        </a>` : ''}
      </div>
    </div>
    ${(() => {
      const allLodges = [...new Map([...lodges, ...myLodges].map(x=>[x.id,x])).values()];
      const region = l.location.split(',').pop()?.trim() || '';
      const similar = allLodges.filter(x => x.id !== l.id && (x.location.includes(region) || x.type === l.type)).slice(0,4);
      if (!similar.length) return '';
      return `<div class="lodge-detail-section" style="padding-bottom:80px;">
        <div class="detail-section-label">You Might Also Like</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:8px;">
          ${similar.map(s => `
            <div onclick="openLodgeDetail('${s.id}')" style="cursor:pointer;border-radius:var(--r-lg);overflow:hidden;border:1px solid var(--seam);background:var(--depth2);box-shadow:var(--shadow-card);transition:transform 0.22s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform=''">
              <img src="${s.photo || ''}" alt="${esc(s.name)}" style="width:100%;height:100px;object-fit:cover;display:block;" onerror="onImgError(this)">
              <div style="padding:10px 12px 12px;">
                <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:3px;line-height:1.3;">${esc(s.name)}</div>
                <div style="font-size:13px;color:#D97706;font-family:'DM Serif Display',serif;">$${s.pricePerNight}/night</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
    })()}`;

  document.getElementById('lodgeBookBar').innerHTML = `
    <div class="lodge-book-bar-price">
      <div class="lp-amount">$${l.pricePerNight}<span style="font-family:'DM Sans',sans-serif;font-size:13px;font-weight:400;color:var(--text-tertiary);margin-left:4px;">/night</span></div>
      <div class="lp-label">${l.chalets} chalets available</div>
    </div>
    ${l.available
      ? `<button class="btn-lodge-book-now" onclick="openBookingPage('${l.id}')">${views >= 2 ? '📅 Book for the Weekend' : 'Book Now'}</button>`
      : `<button class="btn-lodge-book-now" disabled>Fully Booked</button>`}`;

  showPage('pg-lodge-detail');
}

// ══════════════════════════════════════
//  BOOKING PAGE (full-page, not modal)
// ══════════════════════════════════════
let bookingLodge = null;

function openBookingPage(id) {
  id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
  const l = [...lodges, ...myLodges].find(x => x.id === id);
  if (!l) return;
  bookingLodge = l;
  currentLodgeId = id;
  updateNav(null, 'lodge');

  // Use upcoming weekend if user has viewed this lodge 2+ times
  const views = RC.trackLodgeView(id);
  let checkinDate, checkoutDate;
  if (views >= 2) {
    const weekend = RC.getUpcomingWeekend();
    checkinDate = weekend.checkin;
    checkoutDate = weekend.checkout;
  } else {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    checkinDate = today;
    checkoutDate = tomorrow;
  }

  document.getElementById('bkCheckin').min = new Date().toISOString().split('T')[0];
  document.getElementById('bkCheckout').min = checkinDate;
  document.getElementById('bkCheckin').value = checkinDate;
  document.getElementById('bkCheckout').value = checkoutDate;
  document.getElementById('bkGuests').value = '2';
  document.getElementById('bkName').value = '';
  document.getElementById('bkRequests').value = '';
  document.getElementById('bookingSuccessBanner').classList.remove('show');
  document.getElementById('youMightLike')?.classList.remove('show');
  // Remove any stale Add to Calendar button from a previous booking
  document.getElementById('calendarBtn')?.remove();

  // Pre-fill WA number
  RC.prefillWANumber();

  document.getElementById('bookingLodgeCard').innerHTML = `
    <img class="booking-lodge-photo" src="${l.photo}" alt="${esc(l.name)}">
    <div class="booking-lodge-info">
      <div class="booking-stars">${'★'.repeat(l.stars)}${'☆'.repeat(5-l.stars)}</div>
      <div class="booking-lodge-name">${esc(l.name)}</div>
      <div class="booking-lodge-loc">📍 ${esc(l.location)}</div>
      <div class="booking-lodge-rate-row">
        <div><span class="booking-rate-amount">$${l.pricePerNight}</span> <span class="booking-rate-label">/night</span></div>
        <div style="font-size:12px;color:var(--text-tertiary)">${l.chalets} chalets · max ${l.maxGuests} guests</div>
      </div>
    </div>`;

  if (views >= 2) {
    toast(`📅 Defaulted to upcoming weekend (${checkinDate} → ${checkoutDate})`);
  }

  calcBooking();
  showPage('pg-booking');
}

function calcBooking() {
  if (!bookingLodge) return;
  const cinVal = document.getElementById('bkCheckin').value;
  const cin = new Date(cinVal);
  const cout = new Date(document.getElementById('bkCheckout').value);
  // Keep checkout min in sync with check-in so picker enforces correct order
  if (cinVal) {
    const _coEl = document.getElementById('bkCheckout');
    _coEl.min = cinVal;
    // If existing checkout is now before or equal to check-in, clear it
    if (_coEl.value && _coEl.value <= cinVal) _coEl.value = '';
  }
  const nights = Math.max(0, Math.round((cout - cin) / 86400000));
  const guests = document.getElementById('bkGuests').value;
  const total = nights * bookingLodge.pricePerNight;
  document.getElementById('bkNights').textContent = nights > 0 ? nights + ' night' + (nights !== 1 ? 's' : '') : '—';
  document.getElementById('bkRate').textContent = nights > 0 ? '$' + bookingLodge.pricePerNight + '/night' : '—';
  document.getElementById('bkGuestsSum').textContent = guests + ' guest' + (parseInt(guests) !== 1 ? 's' : '');
  document.getElementById('bkTotal').textContent = nights > 0 ? '$' + total : '—';
}

function submitBooking() {
  const l = bookingLodge;
  if (!l) return;
  const name = document.getElementById('bkName').value.trim();
  const phone = document.getElementById('bkPhone').value.trim();
  const checkin = document.getElementById('bkCheckin').value;
  const checkout = document.getElementById('bkCheckout').value;
  const guests = document.getElementById('bkGuests').value;
  const requests = document.getElementById('bkRequests').value.trim();
  if (!name) { toast('Please enter your name'); return; }
  if (!phone) { toast('Please enter your WhatsApp number'); return; }
  const _bkRaw = phone.replace(/\D/g,'');
  if (_bkRaw.length !== 10) { toast('WhatsApp number must be exactly 10 digits'); return; }
  if (!isValidZwPhone(_bkRaw)) { toast('Enter a valid Zimbabwean mobile number (071 / 073 / 077 / 078)'); return; }
  if (!checkin || !checkout) { toast('Please select your dates'); return; }
  const _today = new Date(); _today.setHours(0,0,0,0);
  const cin = new Date(checkin), cout = new Date(checkout);
  if (cin < _today) { toast('Check-in date cannot be in the past'); return; }
  if (cout <= cin) { toast('Check-out must be after check-in'); return; }
  const nights = Math.round((cout - cin) / 86400000);
  const total = nights * l.pricePerNight;
  const lodgePhone = formatPhone(l.phone).replace('+', '');
  const msg = encodeURIComponent(
    `Hi! I'd like to book *${esc(l.name)}* via RentaCrib ZW.\n\n` +
    `👤 Name: ${name}\n📞 My WhatsApp: ${formatPhone(phone)}\n` +
    `📅 Check-in: ${checkin}\n📅 Check-out: ${checkout}\n` +
    `👥 Guests: ${guests}\n🌙 Nights: ${nights}\n💵 Total: $${total}` +
    (requests ? `\n📝 Requests: ${requests}` : '') +
    `\n\nPlease confirm availability. Thank you!`
  );
  window.open(`https://wa.me/${lodgePhone}?text=${msg}`, '_blank');
  
  // ── Save lodge enquiry to Supabase ──
  saveEnquiryToSupabase(
    l._dbId || l.id,
    name,
    formatPhone(phone),
    `Lodge booking: ${esc(l.name)}${requests ? ' | Requests: ' + requests : ''}`,
    { checkin, checkout, guests, nights, total, special_requests: requests }
  );
  
  // Persist WA number
  RC.persistWANumber(phone);
  
  const banner = document.getElementById('bookingSuccessBanner');
  banner.classList.add('show');
  document.getElementById('bookingSuccessMsg').textContent =
    `Booking request for ${nights} night${nights!==1?'s':''} ($${total}) sent to ${esc(l.name)}. They'll confirm shortly via WhatsApp.`;
  
  // Add to Calendar button injection
  const calBtn = `<button class="btn-add-calendar" onclick="addToCalendar('${esc(l.name)}','${checkin}','${checkout}')">
    📅 Add to Calendar
  </button>`;
  // FIX 10: remove any existing calendarBtn before injecting to prevent duplicates
  const oldCalBtn = document.getElementById('calendarBtn');
  if (oldCalBtn) oldCalBtn.remove();
  const bannerEl = document.getElementById('bookingSuccessBanner');
  if (bannerEl) {
    const div = document.createElement('div');
    div.id = 'calendarBtn';
    div.innerHTML = calBtn;
    div.style.marginTop = '8px';
    bannerEl.parentNode.insertBefore(div, bannerEl.nextSibling);
  }
  
  // FIX 10: build fresh deduped array each time and pass as argument
  setTimeout(() => {
    const _allLodges = [...new Map([...lodges, ...myLodges].map(i => [i.id, i])).values()];
    RC.showYouMightLike(l, _allLodges);
  }, 400);
  
  window.scrollTo(0, 0);
}

// Add to calendar helper
function addToCalendar(name, checkin, checkout) {
  const fmt = (d) => d.replace(/-/g,'');
  const title = encodeURIComponent(`Stay at ${name} via RentaCrib ZW`);
  const desc = encodeURIComponent(`Booked via RentaCrib ZW. Check-in: ${checkin}, Check-out: ${checkout}`);
  const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${fmt(checkin)}/${fmt(checkout)}&details=${desc}`;
  window.open(url, '_blank');
}

function backFromBooking() {
  if (currentLodgeId) { openLodgeDetail(currentLodgeId); }
  else { showLodges(); }
}

function openEditListing(id) {
  id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
  const l = myListings.find(x => x.id === id);
  if (!l) return;
  Auth._editingId = id;

  // Derive selectedCategory from the listing's role/category field
  const roleToCategory = { student: 'student', tenant: 'family', lodge: 'lodge' };
  selectedCategory = roleToCategory[l.role] || roleToCategory[l.category] || 'family';

  // Navigate to landlord flow — preserve state so category/step aren't wiped
  openListingFlow(true);

  setTimeout(() => {
    // Pre-select the matching catcard
    document.querySelectorAll('.catcard').forEach(c => {
      if (c.dataset && c.dataset.key === selectedCategory) c.classList.add('selected');
    });

    // Build step 2 type grid using the correct category
    buildTypeGrid();

    // Build step 3 amenity panel
    activateAmenityPanel();

    // Pre-select the matching tcard (after type grid is built)
    document.querySelectorAll('.tcard').forEach(c => {
      if (c.querySelector('.tcard-name')?.textContent === l.type) c.classList.add('selected');
    });

    // Pre-tick amenity chips
    (l.amenities || []).forEach(val => {
      const chip = document.querySelector(`#fs3 .chip[data-val="${CSS.escape(val)}"]`);
      if (chip) {
        chip.classList.add('on');
        const ico = chip.querySelector('.chip-ico');
        if (ico) ico.style.transform = 'scale(1.3)';
      }
    });
    updateTtabSummary && updateTtabSummary();

    // Jump to step 5 and pre-fill text fields
    currentStep = 5; _flowDirection = 1;
    showFlowStep(5);

    setTimeout(() => {
      if (document.getElementById('fTitle'))     document.getElementById('fTitle').value     = l.title    || '';
      if (document.getElementById('fRent'))      document.getElementById('fRent').value      = l.rent     || '';
      if (document.getElementById('fRooms'))     document.getElementById('fRooms').value     = l.rooms    || '';
      if (document.getElementById('fPhone'))     document.getElementById('fPhone').value     = l.phone    || '';
      if (document.getElementById('fCallPhone')) document.getElementById('fCallPhone').value = l.callPhone|| '';
      if (document.getElementById('fDesc'))      document.getElementById('fDesc').value      = l.desc     || '';
      // FIX 2: Restore photo
      if (l.photo) {
        uploadedPhotos = [l.photo];
        const confirmedImg = document.getElementById('confirmedPhotoImg');
        if (confirmedImg) confirmedImg.src = l.photo;
        const photoConfirmed = document.getElementById('photoConfirmedArea');
        if (photoConfirmed) photoConfirmed.style.display = 'block';
        const photoPicker = document.getElementById('photoPickerArea');
        if (photoPicker) photoPicker.style.display = 'none';
        const waPreview = document.getElementById('waPhotoPreview');
        if (waPreview) waPreview.style.display = 'none';
      }
      // Restore guest-stay fields
      if (l.dayRate   && document.getElementById('fDayRate'))   document.getElementById('fDayRate').value   = l.dayRate;
      if (l.nightRate && document.getElementById('fNightRate')) document.getElementById('fNightRate').value = l.nightRate;
      if (l.hourlyRate&& document.getElementById('fHourlyRate'))document.getElementById('fHourlyRate').value= l.hourlyRate;
      if (l.weeklyRate&& document.getElementById('fWeeklyRate'))document.getElementById('fWeeklyRate').value= l.weeklyRate;
      // FIX 9: Restore time-range inputs for lodge
      if (l.dayFrom   && document.getElementById('fDayFrom'))   document.getElementById('fDayFrom').value   = l.dayFrom;
      if (l.dayTo     && document.getElementById('fDayTo'))     document.getElementById('fDayTo').value     = l.dayTo;
      if (l.nightFrom && document.getElementById('fNightFrom')) document.getElementById('fNightFrom').value = l.nightFrom;
      if (l.nightTo   && document.getElementById('fNightTo'))   document.getElementById('fNightTo').value   = l.nightTo;
      // FIX 3: Restore student-specific fields
      if (l.nearestUniversity) {
        const fUVal = document.getElementById('fUniversityVal');
        const fU    = document.getElementById('fUniversity');
        if (fUVal) fUVal.value = l.nearestUniversity;
        if (fU)    fU.value    = l.nearestUniversity;
      }
      if (l.studentsPerRoom) {
        const fSPR = document.getElementById('fStudentsPerRoom');
        if (fSPR) fSPR.value = l.studentsPerRoom;
        const btn = Array.from(document.querySelectorAll('#studentsPerRoomPicker .spr-btn'))
          .find(b => b.textContent.trim() === String(l.studentsPerRoom));
        if (btn) btn.classList.add('selected');
      }
      // Location
      if (l.location) {
        const parts = l.location.split(',').map(s => s.trim());
        if (parts.length >= 2) {
          selectCity(parts[parts.length - 1]);
          setTimeout(() => selectSuburb(parts[0]), 150);
        } else {
          selectCity(parts[0]);
        }
      }
      // FIX 6: RC.updateLivePreview() removed (dead code – elements don't exist)
    }, 100);
  }, 150);
}

// ══════════════════════════════════════
//  MY LISTINGS — DELETE
// ══════════════════════════════════════
// Increment view count for a listing in Supabase

function deleteListing(id) {
  id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
  if (!confirm('Delete this listing permanently?')) return;
  myListings = myListings.filter(l => l.id !== id);
  const i = listings.findIndex(l => l.id === id);
  if (i > -1) listings.splice(i, 1);
  // FIX 4: also remove from myLodges and lodges to prevent orphaned lodge entries
  if (typeof myLodges !== 'undefined') {
    myLodges = myLodges.filter(l => l.id !== id);
  }
  const lodgeIdx = lodges.findIndex(l => l.id === id);
  if (lodgeIdx > -1) lodges.splice(lodgeIdx, 1);
  showMyListings(); toast('✓ Listing removed');
  if (typeof filterListings === 'function') filterListings();
  if (typeof filterLodges === 'function') filterLodges();
}

// ══════════════════════════════════════
//  GLOBAL EVENT LISTENERS
// ══════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Restore persisted view counts into listing objects
  restoreViewCounts();

  // Auto-save landlord form fields
  const formFields = ['fTitle','fRent','fRooms','fPhone','fCallPhone','fDesc'];
  formFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { RC.saveForm(); }, { passive: true });
  });

  // Save scroll position when browsing
  window.addEventListener('scroll', () => {
    const activePg = document.querySelector('.page.active');
    if (activePg && ['pg-browse','pg-lodges'].includes(activePg.id)) {
      RC.saveScrollPos();
    }
  }, { passive: true });

  // Save filters when any filter select changes
  const allFilterIds = [
    'sFilterUniversity','sFilterCity','sFilterSuburb','sFilterType',
    'sFilterRooms','sFilterStudentsPerRoom','sFilterBudget','sFilterAmenity',
    'tFilterCity','tFilterSuburb','tFilterType','tFilterRooms','tFilterBudget','tFilterAmenity',
    'lFilterCity','lFilterSuburb','lFilterType','lFilterAmenity','lFilterChalets',
    'lFilterHourlyRate','lFilterNightRate','lFilterDayRate','lFilterWeeklyRate'
  ];
  allFilterIds.forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => RC.saveFilters(), { passive: true });
  });
});

// ══════════════════════════════════════
//  AUTH MODULE
//  API endpoints (no backend logic here):
//    POST /api/signup          body: { username }   → { code, pin, username, token? }
//    POST /api/login           body: { code, pin }  → { username, token }
//    GET  /api/listings        Authorization: Bearer <token>  → { listings: [...] }
//    POST /api/edit-listing    Authorization: Bearer <token>, body: { id, ...fields }
//    POST /api/delete-listing  Authorization: Bearer <token>, body: { id }
// ══════════════════════════════════════
const Auth = (() => {
  const LS_KEY = 'rc_session'; // { code, pin, username, token }

  /* ── session helpers ── */
  function session() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
  }
  function saveSession(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem(LS_KEY); }
  function authHeaders() {
    const s = session();
    const h = { 'Content-Type': 'application/json' };
    if (s && s.token) h['Authorization'] = 'Bearer ' + s.token;
    return h;
  }

  /* ── UI helpers ── */
  function setLoading(btnId, on) {
    const b = document.getElementById(btnId);
    if (!b) return;
    b.disabled = on;
    if (on) { b.dataset.orig = b.textContent; b.textContent = 'Please wait…'; }
    else    { b.textContent = b.dataset.orig || b.textContent; }
  }
  function showErr(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('show', !!msg);
  }

  /* ── Tab switcher ── */
  function showTab(tab) {
    ['panelSignup','panelLogin'].forEach(id => {
      document.getElementById(id)?.classList.toggle('active', id === (tab === 'signup' ? 'panelSignup' : 'panelLogin'));
    });
    document.getElementById('tabSignUp')?.classList.toggle('active', tab === 'signup');
    document.getElementById('tabLogin')?.classList.toggle('active', tab === 'login');
    showErr('signupError', ''); showErr('loginError', '');
  }

  /* ── Nav state sync ── */
  function applyNavState() {
    const s = session();
    const pill    = document.getElementById('navUserPill');
    const avatar  = document.getElementById('navUserAvatar');
    const uname   = document.getElementById('navUserName');
    const btnList = document.getElementById('btnListProp');
    const lndBtn  = document.getElementById('landlordNavBtn');

    if (s) {
      if (pill)   pill.style.display = 'flex';
      if (avatar) avatar.textContent = (s.username || '?')[0].toUpperCase();
      if (uname)  uname.textContent  = s.username || s.code;
      if (btnList) btnList.style.display = 'block'; // FIX 1: always visible; onListProperty handles auth
      if (lndBtn)  lndBtn.style.display  = 'block';
    } else {
      if (pill)    pill.style.display    = 'none';
      if (btnList) btnList.style.display = 'block';
      if (lndBtn)  lndBtn.style.display  = 'none';
    }
  }

  /* ── Sign Up — saves to Supabase + localStorage ── */
  async function signup() {
    const username = (document.getElementById('signupUsername')?.value || '').trim();
    if (!username) { showErr('signupError', 'Enter a display name to continue.'); return; }

    setLoading('signupBtn', true); showErr('signupError', '');

    function randCode(len, chars) {
      let out = '';
      if (window.crypto && window.crypto.getRandomValues) {
        const arr = new Uint8Array(len);
        crypto.getRandomValues(arr);
        for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
      } else {
        for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
      }
      return out;
    }
    const code = randCode(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    const pin  = randCode(4, '0123456789');

    // Save to Supabase so this account works on any device
    try {
      const { error: dbErr } = await db.from('landlords').insert([{
        code, pin, username, created_at: new Date().toISOString()
      }]);
      if (dbErr) console.warn('Supabase user save error:', dbErr.message);
    } catch(e) { console.warn('Supabase user save failed:', e); }

    // Also save locally as fallback
    saveSession({ code, pin, username, token: code + pin });
    try {
      const users = JSON.parse(localStorage.getItem('rc_users') || '{}');
      users[code] = { pin, username };
      localStorage.setItem('rc_users', JSON.stringify(users));
    } catch(e) {}

    // Populate login fields
    const lc = document.getElementById('loginCode');
    const lp = document.getElementById('loginPin');
    if (lc) lc.value = code;
    if (lp) lp.value = pin;

    // Show credential box
    const credCode = document.getElementById('credCode');
    const credPin  = document.getElementById('credPin');
    if (credCode) credCode.textContent = code;
    if (credPin)  credPin.textContent  = pin;
    document.getElementById('credBox')?.classList.add('show');
    document.getElementById('signupForm').style.display    = 'none';
    document.getElementById('signupContinue').style.display = 'block';

    applyNavState();
    setLoading('signupBtn', false);
    toast('✓ Account created! Save your Code + PIN.');
  }

  /* ── Login — checks Supabase first, localStorage as fallback ── */
  async function login() {
    const code = (document.getElementById('loginCode')?.value || '').trim().toUpperCase();
    const pin  = (document.getElementById('loginPin')?.value  || '').trim();
    if (!code) { showErr('loginError', 'Enter your manage code.'); return; }
    if (!pin)  { showErr('loginError', 'Enter your PIN.'); return; }

    setLoading('loginBtn', true); showErr('loginError', '');
    try {
      let username = code;
      let verified = false;

      // 1. Try Supabase first (works on any device)
      try {
        const result = await fetchJsonWithTimeout(
          `${SUPABASE_URL}/rest/v1/landlords?code=eq.${encodeURIComponent(code)}&select=code,pin,username`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
          { timeoutMs: 8000, retries: 1, label: 'login' }
        );
        if (result.ok) {
          const rows = result.data;
          if (rows && rows[0]) {
            if (rows[0].pin !== pin) throw new Error('Incorrect PIN. Please try again.');
            username = rows[0].username || code;
            verified = true;
            // Sync to local so offline fallback stays fresh
            try {
              const users = JSON.parse(localStorage.getItem('rc_users') || '{}');
              users[code] = { pin, username };
              localStorage.setItem('rc_users', JSON.stringify(users));
            } catch(e) {}
          }
        }
      } catch(netErr) {
        if (netErr.message.includes('PIN')) throw netErr; // re-throw PIN mismatch
        console.warn('Supabase login check failed, falling back to localStorage:', netErr.message);
      }

      // 2. Fallback: localStorage (same device only)
      if (!verified) {
        const users = JSON.parse(localStorage.getItem('rc_users') || '{}');
        const user  = users[code];
        if (!user) throw new Error('Code not found. Check your code or use the device you signed up on.');
        if (user.pin !== pin) throw new Error('Incorrect PIN. Please try again.');
        username = user.username || code;
      }

      saveSession({ code, pin, username, token: code + pin });
      applyNavState();
      toast('✓ Logged in!');
      showPage('pg-dashboard');
    } catch (err) {
      showErr('loginError', err.message);
    } finally {
      setLoading('loginBtn', false);
    }
  }

  /* ── Logout ── */
  function logout() {
    if (!confirm('Log out of your account?')) return;
    clearSession();
    // Clear all user-owned data from memory so a second user on the same
    // device starts with a clean slate and the browse grid is re-fetched.
    // Clear arrays in place so window.* references stay valid
    myListings.splice(0, myListings.length);
    myLodges.splice(0, myLodges.length);
    listings.splice(0, listings.length);
    lodges.splice(0, lodges.length);
    applyNavState();
    // Re-fetch public listings fresh from Supabase so the grid reflects
    // only publicly visible listings, not the previous owner's private ones.
    Promise.all([loadListingsFromSupabase(), loadLodgesFromSupabase()]).then(() => {
      filterListings();
      filterLodges();
    }).catch(e => console.warn('Reload after logout failed:', e));
    goHome();
    toast('Logged out.');
  }

  /* ── Copy credentials ── */
  function copyCred(field) {
    const el = document.getElementById(field === 'code' ? 'credCode' : 'credPin');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent.trim())
      .then(() => toast('✓ ' + (field === 'code' ? 'Code' : 'PIN') + ' copied!'));
  }
  function copyAll() {
    const code = document.getElementById('credCode')?.textContent.trim() || '';
    const pin  = document.getElementById('credPin')?.textContent.trim()  || '';
    navigator.clipboard.writeText('RentaCrib Code: ' + code + '\nPIN: ' + pin)
      .then(() => toast('✓ Code + PIN copied to clipboard!'));
  }

  /* ── Load & render dashboard — LOCAL ── */
  async function loadDashboard() {
    const s = session();
    if (!s) return;

    const dashName = document.getElementById('dashName');
    const dashCode = document.getElementById('dashCodeDisplay');
    if (dashName) dashName.textContent = s.username || s.code;
    if (dashCode) dashCode.textContent = 'Manage Code: ' + s.code;

    // ── Cache-first: render last-known dashboard data instantly (same pattern ──
    // as the public lodges cache) so the page never sits on a blank skeleton
    // while waiting on the network — even on the very first open of a session.
    let _dashCacheHit = false;
    try {
      const _dc = localStorage.getItem('rc_dash_cache_' + s.code);
      if (_dc) {
        const { propItems: _cp, lodgeItems: _cl } = JSON.parse(_dc);
        if (_cp || _cl) {
          renderDashboard(_cp || [], _cl || []);
          _dashCacheHit = true;
        }
      }
    } catch(e) {}

    // ── Show skeleton cards only if we have nothing cached to show yet ──
    const _dashContainer = document.getElementById('dashListingsContainer');
    if (_dashContainer && !_dashCacheHit) {
      const _dSkel = `
        <div class="dash-listing-card" style="pointer-events:none;">
          <div class="dlc-inner">
            <div class="dlc-photo" style="width:140px;flex-shrink:0;background:linear-gradient(90deg,var(--depth3) 25%,var(--depth4) 50%,var(--depth3) 75%);background-size:600px 100%;animation:rc-shimmer 1.6s ease-in-out infinite;"></div>
            <div class="dlc-content">
              <div style="height:16px;width:55%;border-radius:6px;background:linear-gradient(90deg,var(--depth3) 25%,var(--depth4) 50%,var(--depth3) 75%);background-size:600px 100%;animation:rc-shimmer 1.6s ease-in-out infinite;margin-bottom:10px;"></div>
              <div style="height:12px;width:35%;border-radius:6px;background:linear-gradient(90deg,var(--depth3) 25%,var(--depth4) 50%,var(--depth3) 75%);background-size:600px 100%;animation:rc-shimmer 1.6s ease-in-out infinite;margin-bottom:14px;"></div>
              <div style="display:flex;gap:8px;margin-bottom:12px;">
                <div style="height:22px;width:60px;border-radius:100px;background:linear-gradient(90deg,var(--depth3) 25%,var(--depth4) 50%,var(--depth3) 75%);background-size:600px 100%;animation:rc-shimmer 1.6s ease-in-out infinite;"></div>
                <div style="height:22px;width:80px;border-radius:100px;background:linear-gradient(90deg,var(--depth3) 25%,var(--depth4) 50%,var(--depth3) 75%);background-size:600px 100%;animation:rc-shimmer 1.6s ease-in-out infinite;"></div>
              </div>
            </div>
          </div>
        </div>`;
      _dashContainer.innerHTML = _dSkel + _dSkel + _dSkel;
    }

    // ── Fetch properties and lodges in parallel using raw fetch (same pattern as loadListingsFromSupabase) ──
    // Avoids the DataCloneError bug in Supabase JS v2 SDK and cuts load time in half vs sequential fetches.
    let propItems = [];
    let lodgeItems = [];


    const [propResult, lodgeResult] = await Promise.all([
      fetchJsonWithTimeout(
        `${SUPABASE_URL}/rest/v1/properties?owner_code=eq.${encodeURIComponent(s.code)}&select=id,owner_code,role,category,title,suburb,city,ward,type,price,bedrooms,description,whatsapp,call_phone,amenities,photos,photo,status,views`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
        { timeoutMs: 8000, retries: 1, label: 'dashboard-props' }
      ),
      fetchJsonWithTimeout(
        `${SUPABASE_URL}/rest/v1/lodges?owner_code=eq.${encodeURIComponent(s.code)}&select=id,owner_code,name,location,type,price_per_night,hourly_rate,day_rate,weekly_rate,stars,chalets,max_guests,description,whatsapp,call_phone,features,available,photos,photo,views`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } },
        { timeoutMs: 8000, retries: 1, label: 'dashboard-lodges' }
      )
    ]);

    try {
      if (propResult && propResult.ok && propResult.data) {
        const remoteProps = propResult.data;
        if (remoteProps && remoteProps.length) {
          propItems = remoteProps
            .filter(row => row.role !== 'lodge' && row.category !== 'lodge')
            .map(row => {
              const photos = (() => { try { return JSON.parse(row.photos || '[]'); } catch(e) { return row.photo ? [row.photo] : []; } })();
              return {
                id:         row.id,
                _dbId:      row.id,
                _ownerCode: row.owner_code || s.code,
                _remote:    true,
                title:      row.title       || '',
                location:   [row.suburb, row.city, row.ward].filter(Boolean).join(', '),
                type:       row.type        || '',
                role:       row.role        || 'tenant',
                rent:       row.price       || 0,
                rooms:      row.bedrooms    || 1,
                desc:       row.description || '',
                phone:      row.whatsapp    || '',
                whatsapp:   row.whatsapp    || '',
                callPhone:  row.call_phone  || row.whatsapp || '',
                amenities:  (() => { try { return JSON.parse(row.amenities || '[]'); } catch(e) { return []; } })(),
                photo:      photos[0] || row.photo || '',
                photos:     photos,
                draft:      row.status === 'draft',
                views:      row.views       || 0,
              };
            });
          // Sync into in-memory arrays: update existing entries, and push any that
          // are missing entirely (this is what keeps myListings complete so that
          // OTHER re-render call sites — e.g. after editing a listing — don't fall
          // back to an incomplete list).
          propItems.forEach(mapped => {
            const mi = myListings.findIndex(l => String(l._dbId || l.id) === String(mapped.id));
            if (mi > -1) { myListings[mi].views = mapped.views; myListings[mi].photo = mapped.photo || myListings[mi].photo; }
            else { myListings.push(mapped); }
            const li = listings.findIndex(l => String(l._dbId || l.id) === String(mapped.id));
            if (li > -1) { listings[li].views = mapped.views; listings[li].photo = mapped.photo || listings[li].photo; }
            else { listings.push(mapped); }
          });
        }
      }
    } catch(e) { console.warn('Dashboard property parse failed:', e); }

    try {
      if (lodgeResult && lodgeResult.ok && lodgeResult.data) {
        const remoteLodges = lodgeResult.data;
        if (remoteLodges && remoteLodges.length) {
          lodgeItems = remoteLodges.map(row => {
            const photos = (() => { try { return JSON.parse(row.photos || '[]'); } catch(e) { return row.photo ? [row.photo] : []; } })();
            return {
              id:            row.id,
              _dbId:         row.id,
              _ownerCode:    row.owner_code || s.code,
              _remote:       true,
              name:          row.name             || '',
              location:      row.location         || '',
              type:          row.type             || '',
              pricePerNight: row.price_per_night  || 0,
              hourlyRate:    row.hourly_rate       || 0,
              dayRate:       row.day_rate          || 0,
              weeklyRate:    row.weekly_rate       || 0,
              stars:         row.stars             || 4,
              chalets:       row.chalets           || 1,
              maxGuests:     row.max_guests        || 10,
              desc:          row.description       || '',
              phone:         row.whatsapp          || '',
              callPhone:     row.call_phone        || row.whatsapp || '',
              features:      (() => { try { return JSON.parse(row.features || '[]'); } catch(e) { return []; } })(),
              available:     row.available !== false,
              photo:         photos[0] || row.photo || '',
              photos:        photos,
              views:         row.views             || 0,
            };
          });
          // Sync into in-memory arrays: update existing entries, and push any that
          // are missing entirely. This is the actual fix for lodges appearing late/
          // disappearing on the dashboard — myLodges was previously never filled with
          // remote lodges (the dedicated loader for that was dead code), so any other
          // dashboard re-render that fell back to filtering myLodges came up incomplete.
          lodgeItems.forEach(mapped => {
            const mi = myLodges.findIndex(l => String(l._dbId || l.id) === String(mapped.id));
            if (mi > -1) { myLodges[mi].views = mapped.views; myLodges[mi].photo = mapped.photo || myLodges[mi].photo; }
            else { myLodges.push(mapped); }
            const li = lodges.findIndex(l => String(l._dbId || l.id) === String(mapped.id));
            if (li > -1) { lodges[li].views = mapped.views; lodges[li].photo = mapped.photo || lodges[li].photo; }
            else { lodges.push(mapped); }
          });
        }
      }
    } catch(e) { console.warn('Dashboard lodge parse failed:', e); }

    // Track which fetches actually succeeded. A timed-out fetch after retries
    // still leaves propItems/lodgeItems as [] (not null) — passing those straight
    // to renderDashboard would wipe out the good cache-hit render from earlier
    // in this function with an empty dashboard. Pass null instead for whichever
    // side failed, so renderDashboard falls back to in-memory data.
    const propsFetchOk  = !!(propResult  && propResult.ok);
    const lodgesFetchOk = !!(lodgeResult && lodgeResult.ok);
    renderDashboard(propsFetchOk ? propItems : null, lodgesFetchOk ? lodgeItems : null);

    // ── Save fresh data to cache for instant render next time ──
    // Only overwrite the parts we actually got confirmed data for — a transient
    // timeout on one or both endpoints shouldn't destroy a previously-good cache.
    if (propsFetchOk || lodgesFetchOk) {
      try {
        let _prevCache = null;
        try { _prevCache = JSON.parse(localStorage.getItem('rc_dash_cache_' + s.code) || 'null'); } catch(e) {}
        const cacheProps  = propsFetchOk  ? propItems  : (_prevCache?.propItems  || []);
        const cacheLodges = lodgesFetchOk ? lodgeItems : (_prevCache?.lodgeItems || []);
        localStorage.setItem('rc_dash_cache_' + s.code, JSON.stringify({ propItems: cacheProps, lodgeItems: cacheLodges, ts: Date.now() }));
      } catch(e) {}
    }
  }

  function renderDashboard(items, lodgeItems) {
    const statTotal  = document.getElementById('statTotal');
    const statActive = document.getElementById('statActive');
    const statViews  = document.getElementById('statViews');
    const container  = document.getElementById('dashListingsContainer');

    // items = property listings, lodgeItems = lodges (both fresh from Supabase via loadDashboard,
    // or derived from in-memory arrays when called from other paths)
    const s = session();
    let propItems = items;
    if (!propItems) {
      // Fallback: derive from in-memory array (mirrors the lodge fallback below),
      // e.g. when called as renderDashboard(null, null) for an instant in-memory
      // re-render, or when a Supabase fetch failed and we don't want to wipe
      // a previously-good render with an empty list.
      propItems = (typeof myListings !== 'undefined' && s)
        ? myListings.filter(l => l._ownerCode === s.code)
        : [];
    }
    let myLodgesOwned = lodgeItems;
    if (!myLodgesOwned) {
      // Fallback: derive from in-memory array (e.g. called from loadMyListingsFromSupabase)
      myLodgesOwned = (typeof myLodges !== 'undefined' && s)
        ? myLodges.filter(l => l._ownerCode === s.code)
        : [];
    }
    // Strip any lodge-role items from propItems (they belong in lodgeItems only)
    propItems = propItems.filter(l => l.role !== 'lodge' && l.category !== 'lodge');
    // Deduplicate each list by id just in case
    const seenProp = new Set(); propItems = propItems.filter(l => { const k = String(l.id); return seenProp.has(k) ? false : seenProp.add(k); });
    const seenLodge = new Set(); myLodgesOwned = myLodgesOwned.filter(l => { const k = String(l.id); return seenLodge.has(k) ? false : seenLodge.add(k); });
    const allItems = [...propItems, ...myLodgesOwned];

    if (statTotal)  statTotal.textContent  = allItems.length;
    if (statActive) statActive.textContent = propItems.filter(l => !l.draft).length + myLodgesOwned.filter(l => l.available !== false).length;
    const totalViews = [...propItems, ...myLodgesOwned].reduce((a, l) => a + (l.views || 0), 0);
    if (statViews)  statViews.textContent  = totalViews || '—';

    if (!container) return;
    if (!allItems.length) {
      container.innerHTML = `
        <div class="dash-empty">
          <div class="dash-empty-icon">🏠</div>
          <div class="dash-empty-title">No listings yet</div>
          <div class="dash-empty-sub">Create your first listing and start receiving tenant enquiries via WhatsApp.</div>
          <button class="dash-empty-btn" onclick="Auth.goToListProperty()">+ Create First Listing</button>
        </div>`;
      return;
    }

    // Render property listings
    let html = '';
    if (propItems.length > 0) {
      html += propItems.map(l => {
        const photo    = l.photo || 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=400&q=70&auto=format&fit=crop';
        const priceStr = l.rent ? `$${l.rent}<sub>/mo</sub>` : (l.dayRate ? `$${l.dayRate}<sub>/day</sub>` : '—');
        const isLive   = !l.draft;
        return `
        <div class="dash-listing-card" id="dlc-${l.id}">
          <div class="dlc-inner">
            <div class="dlc-photo"><img src="${photo}" alt="${esc(l.title || "")}" loading="lazy" onerror="onImgError(this)"></div>
            <div class="dlc-content">
              <div class="dlc-top">
                <div class="dlc-title">${esc(l.title || "Untitled Listing")}</div>
                <div class="dlc-price">${priceStr}</div>
              </div>
              <div class="dlc-meta">
                <span class="dlc-badge ${isLive ? 'live' : ''}">${isLive ? '● Live' : '○ Draft'}</span>
                ${l.type     ? `<span class="dlc-badge">${esc(l.type)}</span>` : ''}
                ${l.location ? `<span class="dlc-badge">📍 ${esc(l.location)}</span>` : ''}
                ${l.rooms    ? `<span class="dlc-badge">🛏 ${l.rooms} room${l.rooms > 1 ? 's' : ''}</span>` : ''}
                <span class="dlc-badge dlc-views-badge" style="background:var(--emerald-dim);border-color:var(--emerald-mid);color:var(--emerald);font-weight:700;">👁 ${l.views || 0} view${(l.views || 0) === 1 ? '' : 's'}</span>
              </div>
              <div class="dlc-actions">
                <button class="dlc-btn dlc-btn-view" onclick="openDetail('${l.id}')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View
                </button>
                <button class="dlc-btn dlc-btn-delete" onclick="Auth.deleteListing('${l.id}')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>Delete
                </button>
              </div>
            </div>
          </div>
        </div>`;
      }).join('');
    }

    // Render lodge listings
    if (myLodgesOwned.length > 0) {
      html += `<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-tertiary);margin:20px 0 12px;">🏨 My Lodges</div>`;
      html += myLodgesOwned.map(l => {
        const photo = l.photo || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400&q=70&auto=format&fit=crop';
        return `
        <div class="dash-listing-card" id="dlc-${l.id}">
          <div class="dlc-inner">
            <div class="dlc-photo"><img src="${photo}" alt="${esc(l.name || "")}" loading="lazy" onerror="onImgError(this)"></div>
            <div class="dlc-content">
              <div class="dlc-top">
                <div class="dlc-title">${esc(l.name || "Untitled Lodge")}</div>
                <div class="dlc-price">$${l.pricePerNight || 0}<sub>/night</sub></div>
              </div>
              <div class="dlc-meta">
                <span class="dlc-badge live">● Live</span>
                ${l.type     ? `<span class="dlc-badge">${esc(l.type)}</span>` : ''}
                ${l.location ? `<span class="dlc-badge">📍 ${esc(l.location)}</span>` : ''}
                ${l.chalets  ? `<span class="dlc-badge">🏠 ${l.chalets} chalet${l.chalets > 1 ? 's' : ''}</span>` : ''}
                <span class="dlc-badge dlc-views-badge" style="background:var(--emerald-dim);border-color:var(--emerald-mid);color:var(--emerald);font-weight:700;">👁 ${l.views || 0} view${(l.views || 0) === 1 ? '' : 's'}</span>
              </div>
              <div class="dlc-actions">
                <button class="dlc-btn dlc-btn-view" onclick="openLodgeDetail('${l.id}')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View
                </button>
                <button class="dlc-btn dlc-btn-delete" onclick="Auth.deleteLodge('${l.id}')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>Delete
                </button>
              </div>
            </div>
          </div>
        </div>`;
      }).join('');
    }

    container.innerHTML = html;
  }

  /* ── Edit (pre-fill existing flow, then API-save on submit) ── */
  function editListing(id) {
    id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
    Auth._editingId = id;
    if (typeof openEditListing === 'function') openEditListing(id);
    else toast('Edit flow unavailable.');
  }

  /* ── Delete ── */
  async function deleteListing(id) {
    id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
    if (!confirm('Permanently delete this listing?')) return;
    // Clear edit state if this listing was being edited
    if (Auth._editingId === id) Auth._editingId = null;

    // Capture _dbId BEFORE filtering arrays
    const deletedListing = myListings.find(l => l.id === id) || listings.find(l => l.id === id);
    const dbId = deletedListing?._dbId || null;

    // Mutate in place so window.myListings stays in sync (filter reassignment breaks the reference)
    for (let i = myListings.length - 1; i >= 0; i--) { if (myListings[i].id === id) myListings.splice(i, 1); }
    const gi = listings.findIndex(l => l.id === id);
    if (gi > -1) listings.splice(gi, 1);

    // Also remove from localStorage
    try {
      const stored = JSON.parse(localStorage.getItem('rc_myListings') || '[]');
      localStorage.setItem('rc_myListings', JSON.stringify(stored.filter(l => l.id !== id)));
    } catch(e) {}

    // FIX: if this was a lodge-category listing, also clean up the lodges table,
    // myLodges, public lodges array, and rc_myLodges localStorage — otherwise the
    // lodge row stays in Supabase and reappears in the browse grid on next load
    if (deletedListing && (deletedListing.role === 'lodge' || deletedListing.category === 'lodge')) {
      // Also remove from lodge in-memory arrays and localStorage
      for (let i = myLodges.length - 1; i >= 0; i--) { if (myLodges[i].id === id) myLodges.splice(i, 1); }
      const li = lodges.findIndex(l => l.id === id);
      if (li > -1) lodges.splice(li, 1);
      try {
        const storedLodges = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
        localStorage.setItem('rc_myLodges', JSON.stringify(storedLodges.filter(l => l.id !== id)));
      } catch(e) {}
    }

    const card = document.getElementById('dlc-' + id);
    if (card) {
      card.style.cssText += 'opacity:0;transform:scale(0.96);transition:all 0.3s;';
      setTimeout(() => card.remove(), 300);
    }
    toast('✓ Listing deleted.');
    // Re-render browse grids and dashboard immediately from updated in-memory arrays
    if (typeof filterListings === 'function') filterListings();
    if (typeof filterLodges === 'function') filterLodges();
    renderDashboard(null, null); // instant re-render from in-memory
    // ── Supabase delete runs in background; dashboard refreshes after to confirm ──
    const _deletePromises = [];
    if (dbId) _deletePromises.push(deleteListingFromSupabase(dbId));
    if (deletedListing && (deletedListing.role === 'lodge' || deletedListing.category === 'lodge')) {
      const lodgeDbEntry2 = myLodges.find(l => l.id === id) || lodges.find(l => l.id === id);
      if (lodgeDbEntry2 && lodgeDbEntry2._dbId) _deletePromises.push(deleteLodgeFromSupabase(lodgeDbEntry2._dbId));
    }
    Promise.all(_deletePromises).then(() => loadDashboard());
  }

  /* ── "List Property" nav button — gate behind auth ── */
  function onListProperty() {
    if (session()) {
      openListingFlow();
    } else {
      // Reset signup form state
      showTab('signup');
      document.getElementById('credBox')?.classList.remove('show');
      const sf = document.getElementById('signupForm');
      const sc = document.getElementById('signupContinue');
      if (sf) sf.style.display = 'block';
      if (sc) sc.style.display = 'none';
      const su = document.getElementById('signupUsername');
      if (su) su.value = '';
      showPage('pg-auth');
    }
  }

  function continueAfterSignup() { openListingFlow(); }
  function goToListProperty()    { if (session()) openListingFlow(); else Auth.onListProperty(); }

  /* ── Patch showPage to reload dashboard on navigate ── */
  let _dashLoadedOnce = false;

  /* ── Manual dashboard refresh (button-triggered, replaces old 60s poll) ── */
  let _dashRefreshing = false;
  async function refreshDashboard() {
    if (_dashRefreshing) return;
    _dashRefreshing = true;
    const btn = document.getElementById('dashRefreshBtn');
    if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
    try {
      await loadDashboard();
    } finally {
      if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
      _dashRefreshing = false;
    }
  }
  function patchShowPage() {
    const orig = window.showPage;
    if (!orig || orig._authPatched) return;
    window.showPage = function(id, _fromPopstate) {
      // BACK-BUTTON FIX: forward _fromPopstate so showPage() doesn't push a
      // duplicate history entry every time this wrapper is called from the
      // popstate handler.
      orig(id, _fromPopstate);
      if (id === 'pg-dashboard') {
        // Skip only if Dashboard data was already loaded once this session
        // (covers the case where login() or Auth.init() just loaded it).
        // Always load if this is the first time Dashboard is being shown.
        if (!_dashLoadedOnce) {
          _dashLoadedOnce = true;
          loadDashboard();
        }
      }
    };
    window.showPage._authPatched = true;
  }

  /* ── Init ── */
  function init() {
    applyNavState();
    patchShowPage();

    // If already logged in, silently pre-load dashboard
    const s = session();
    if (s) { _dashLoadedOnce = true; loadDashboard(); }
  }

  /* ── Delete Lodge — LOCAL ── */
  async function deleteLodge(id) {
    id = (id !== null && id !== undefined && !isNaN(Number(id))) ? Number(id) : id;
    if (!confirm('Permanently delete this lodge?')) return;
    // Clear edit state if this lodge was being edited
    if (window._editingLodgeId === id) window._editingLodgeId = null;
    // ── Remove from in-memory arrays FIRST so re-renders are clean ──
    const deletedLodge = (typeof myLodges !== 'undefined' ? myLodges : []).find(l => l.id === id)
                      || (typeof lodges !== 'undefined' ? lodges : []).find(l => l.id === id);
    // Mutate arrays in place so window.myLodges / window.myListings stay in sync
    if (typeof myLodges !== 'undefined') {
      for (let i = myLodges.length - 1; i >= 0; i--) { if (myLodges[i].id === id) myLodges.splice(i, 1); }
    }
    if (typeof myListings !== 'undefined') {
      for (let i = myListings.length - 1; i >= 0; i--) { if (myListings[i].id === id) myListings.splice(i, 1); }
    }
    if (typeof lodges !== 'undefined') {
      for (let i = lodges.length - 1; i >= 0; i--) { if (lodges[i].id === id) lodges.splice(i, 1); }
    }
    if (typeof listings !== 'undefined') {
      for (let i = listings.length - 1; i >= 0; i--) { if (listings[i].id === id) listings.splice(i, 1); }
    }
    // ── Remove from localStorage ──
    try {
      const stored = JSON.parse(localStorage.getItem('rc_myLodges') || '[]');
      localStorage.setItem('rc_myLodges', JSON.stringify(stored.filter(l => l.id !== id)));
    } catch(e) {}
    // ── Animate card out ──
    const card = document.getElementById('dlc-' + id);
    if (card) {
      card.style.cssText += 'opacity:0;transform:scale(0.96);transition:all 0.3s;';
      setTimeout(() => card.remove(), 300);
    }
    toast('✓ Lodge deleted.');
    // Re-render browse grids and dashboard immediately from updated in-memory arrays
    if (typeof filterListings === 'function') filterListings();
    if (typeof filterLodges === 'function') filterLodges();
    renderDashboard(null, null); // instant re-render from in-memory
    // ── Supabase delete runs in background; dashboard refreshes after to confirm ──
    if (deletedLodge && deletedLodge._dbId) {
      deleteLodgeFromSupabase(deletedLodge._dbId).then(() => loadDashboard());
    }
  }

  return { showTab, signup, login, logout, copyCred, copyAll, loadDashboard, refreshDashboard, renderDashboard, editListing, deleteListing, deleteLodge, onListProperty, continueAfterSignup, goToListProperty, init, _editingId: null, _session: session };
})();

// Register real Auth and flush any queued calls from before it was ready
window._AuthReal = Auth;
if (window._AuthQueue && window._AuthQueue.length) {
  window._AuthQueue.forEach(({ prop, args }) => { try { Auth[prop]?.(...args); } catch(e) {} });
  window._AuthQueue = [];
}

// ── Restore per-listing view counts from localStorage into in-memory listing objects ──
function restoreViewCounts() {
  try {
    const stored = JSON.parse(localStorage.getItem('rc_listing_views') || '{}');
    if (!Object.keys(stored).length) return;
    // Apply to both listings arrays so dashboard and browse both reflect real counts
    [listings, myListings].forEach(arr => {
      arr.forEach(l => {
        const saved = stored[l.id];
        if (saved !== undefined) l.views = saved;
      });
    });
  } catch(e) {}
}

// BACK-BUTTON FIX: seed the initial history entry with the landing page as
// its state, so the first popstate event (if any) has somewhere valid to
// fall back to instead of defaulting blindly.
if (!history.state || !history.state.page) {
  history.replaceState({ page: 'pg-landing' }, '', location.hash || '#pg-landing');
}

// Bootstrap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { restoreViewCounts(); Auth.init(); });
} else {
  restoreViewCounts();
  Auth.init();
}

// ═══════════════════════════════════════
// FOOTER CITY GRID
// ═══════════════════════════════════════
// ── Footer city grid ──
(function() {
  const cities = ['Harare','Bulawayo','Masvingo','Mutare','Gweru','Chinhoyi',
    'Bindura','Kwekwe','Kadoma','Victoria Falls','Kariba','Nyanga',
    'Bvumba','Rusape','Chiredzi','Zvishavane'];
  // Tenant city buttons (FIX 7: set filter before setRole, preserveFilters=true)
  const grid = document.getElementById('footerCityGrid');
  if (grid) {
    grid.innerHTML = cities.map(c =>
      `<button class="ftr-city-btn" onclick="(function(){var el=document.getElementById('tFilterCity');if(el)el.value='${c}';setRole('tenant',true);})()">${c}</button>`
    ).join('');
  }
  // FIX 14: Student city buttons row
  const studentGrid = document.getElementById('footerStudentCityGrid');
  if (studentGrid) {
    studentGrid.innerHTML = cities.map(c =>
      `<button class="ftr-city-btn" onclick="(function(){var el=document.getElementById('sFilterCity');if(el)el.value='${c}';setRole('student',true);})()">${c}</button>`
    ).join('');
  }
})();
