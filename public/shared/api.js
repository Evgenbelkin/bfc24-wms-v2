/**
 * BFC24 WMS v2 — Shared API Layer
 * Единственный файл для всех запросов к backend.
 * Все экраны подключают этот файл и используют только его.
 */
(function (window) {
  'use strict';

  const API_BASE = '/api/v2';

  // ─────────────── Token Management ───────────────

  const TOKEN_KEY         = 'wms2_token';
  const REFRESH_TOKEN_KEY = 'wms2_refresh_token';
  const USER_KEY          = 'wms2_user';

  function getToken()        { return localStorage.getItem(TOKEN_KEY); }
  function getRefreshToken() { return localStorage.getItem(REFRESH_TOKEN_KEY); }
  function getUser()         { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
  function saveAuth(token, user, refreshToken) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
  function isLoggedIn() { return !!getToken(); }

  // ─────────────── HTTP Core ───────────────

  // Access token живёт недолго (см. JWT_EXPIRES_IN, по умолчанию 2ч). Чтобы не
  // выкидывать пользователя на логин при каждом истечении, при 401 пробуем один
  // раз молча обновить его через refresh token, и только если это не удалось —
  // разлогиниваем. Конкурентные запросы, словившие 401 одновременно, ждут один
  // и тот же refresh (не долбят /auth/refresh параллельно).
  let refreshPromise = null;

  async function trySilentRefresh() {
    const rt = getRefreshToken();
    if (!rt) return false;
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          const res = await fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: rt }),
          });
          if (!res.ok) return false;
          const json = await res.json().catch(() => null);
          if (!json || json.ok === false || !json.accessToken) return false;
          localStorage.setItem(TOKEN_KEY, json.accessToken);
          if (json.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, json.refreshToken);
          return true;
        } catch (_) {
          return false;
        } finally {
          refreshPromise = null;
        }
      })();
    }
    return refreshPromise;
  }

  async function request(method, path, data = null, opts = {}) {
    const doFetch = () => {
      const token = getToken();
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const config = { method, headers, ...opts };
      if (data !== null && method !== 'GET') config.body = JSON.stringify(data);
      const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
      return fetch(url, config);
    };

    let res = await doFetch();

    // Access token истёк — пробуем один раз обновить и повторить запрос молча,
    // прежде чем показывать пользователю экран логина.
    if (res.status === 401 && !opts.noRedirect) {
      const refreshed = await trySilentRefresh();
      if (refreshed) res = await doFetch();
    }

    // 401 → перенаправить на логин (refresh не удался или недоступен)
    if (res.status === 401 && !opts.noRedirect) {
      clearAuth();
      window.location.href = '/app/login.html';
      return null;
    }

    let json;
    try { json = await res.json(); } catch { json = { ok: false, error: { message: 'Invalid response' } }; }

    if (!res.ok || json?.ok === false) {
      const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.code    = json?.error?.code || 'API_ERROR';
      err.status  = res.status;
      err.details = json?.error?.details;
      throw err;
    }

    return json;
  }

  const get    = (path, params) => {
    const url = params ? `${path}?${new URLSearchParams(params)}` : path;
    return request('GET', url);
  };
  const post   = (path, data)   => request('POST',   path, data);
  const patch  = (path, data)   => request('PATCH',  path, data);
  const put    = (path, data)   => request('PUT',    path, data);
  const del    = (path)         => request('DELETE', path);

  // ─────────────── Auth ───────────────

  const auth = {
    async login(username, password) {
      const res = await request('POST', '/auth/login', { username, password }, { noRedirect: true });
      if (res) saveAuth(res.accessToken, res.user, res.refreshToken);
      return res;
    },
    async me() { return get('/auth/me'); },
    async logout(refreshToken) {
      try { await post('/auth/logout', { refreshToken: refreshToken || getRefreshToken() }); } catch(_) {}
      clearAuth();
    },
    async changePassword(currentPassword, newPassword) {
      return post('/auth/change-password', { currentPassword, newPassword });
    },
  };

  // ─────────────── Users ───────────────

  const users = {
    list:   (params) => get('/users', params),
    get:    (id)     => get(`/users/${id}`),
    create: (data)   => post('/users', data),
    update: (id, d)  => patch(`/users/${id}`, d),
    delete: (id)     => del(`/users/${id}`),
  };

  // ─────────────── Clients ───────────────

  const clients = {
    list:   (params) => get('/clients', params),
    short:  ()       => get('/clients/short'),
    get:    (id)     => get(`/clients/${id}`),
    create: (data)   => post('/clients', data),
    update: (id, d)  => patch(`/clients/${id}`, d),
  };

  // ─────────────── Warehouses ───────────────

  const warehouses = {
    list:   ()       => get('/warehouses'),
    get:    (id)     => get(`/warehouses/${id}`),
    create: (data)   => post('/warehouses', data),
    update: (id, d)  => patch(`/warehouses/${id}`, d),
  };

  // ─────────────── Items ───────────────

  const items = {
    list:      (p) => get('/items', p),
    byBarcode: (b, clientId) => get('/items/by-barcode', { barcode: b, client_id: clientId }),
    get:       (id)=> get(`/items/${id}`),
    create:    (d) => post('/items', d),
    update:    (id,d)=>patch(`/items/${id}`, d),
    printLabel:(id,copies=1)=>post(`/items/${id}/print-label`, { copies }),
  };

  // ─────────────── Locations ───────────────

  const locations = {
    list:    (p) => get('/locations', p),
    byCode:  (code, warehouseId) => get('/locations/by-code', { code, warehouse_id: warehouseId }),
    get:     (id)=> get(`/locations/${id}`),
    create:  (d) => post('/locations', d),
    update:  (id,d)=>patch(`/locations/${id}`, d),
  };

  // ─────────────── Stock ───────────────

  const stock = {
    list:       (p) => get('/stock', p),
    byBarcode:  (b, p) => get('/stock/by-barcode', { barcode: b, ...p }),
    byLocation: (code, p) => get('/stock/by-location', { location_code: code, ...p }),
    movements:  (p) => get('/stock/movements', p),
    adjust:     (d) => post('/stock/adjust', d),
    move:       (d) => post('/stock/move', d),
  };

  // ─────────────── Inbound Orders ───────────────

  const inbound = {
    list:       (p) => get('/inbound', p),
    byBarcode:  (b) => get('/inbound/by-barcode', { barcode: b }),
    get:        (id)=> get(`/inbound/${id}`),
    create:     (d) => post('/inbound', d),
    confirm:    (id)=> post(`/inbound/${id}/confirm`),
    cancel:     (id)=> post(`/inbound/${id}/cancel`),
  };

  // ─────────────── Receiving ───────────────

  const receiving = {
    accept:          (d) => post('/receiving/accept', d),
    acceptByInbound: (d) => post('/receiving/accept-by-inbound', d),
    history:         (p) => get('/receiving/history', p),
  };

  // ─────────────── Placement ───────────────

  const placement = {
    pending:        (p) => get('/placement/pending', p),
    pendingByBarcode: (barcode, p) => get('/placement/pending/barcode', { barcode, ...p }),
    place:          (d) => post('/placement/place', d),
    batch:          (d) => post('/placement/batch', d),
    history:        (p) => get('/placement/history', p),
    suggest:        (p) => get('/placement/suggest', p),
  };

  // ─────────────── Movement ───────────────

  const movement = {
    move:     (d) => post('/movement/move', d),
    batch:    (d) => post('/movement/batch', d),
    history:  (p) => get('/movement/history', p),
    location: (p) => get('/movement/location', p),
  };

  // ─────────────── Inventory ───────────────

  const inventory = {
    tasks:        (p)      => get('/inventory/tasks', p),
    task:         (id)     => get(`/inventory/tasks/${id}`),
    createTask:   (d)      => post('/inventory/tasks', d),
    createBatch:  (d)      => post('/inventory/tasks/batch', d),
    assign:       (id, d)  => post(`/inventory/tasks/${id}/assign`, d),
    count:        (id, d)  => post(`/inventory/tasks/${id}/count`, d),
    close:        (id, d)  => post(`/inventory/tasks/${id}/close`, d),
    discrepancies:(p)      => get('/inventory/discrepancies', p),
  };

  // ─────────────── Picking ───────────────

  const picking = {
    waves:        (p) => get('/picking/waves', p),
    waveStatus:   ()  => get('/picking/wave/status'),
    takeWave:     ()  => post('/picking/wave/take'),
    closeWave:    (d) => post('/picking/wave/close', d),
    next:         (p) => get('/picking/next', p),
    scanLocation: (d) => post('/picking/scan/location', d),
    scanItem:     (d) => post('/picking/scan/item', d),
    skip:         (d) => post('/picking/skip', d),
    manualWave:   (d) => post('/picking/manual-wave', d),
    skipped:      (p) => get('/picking/tasks/skipped', p),
    requeue:      (id) => post(`/picking/tasks/${id}/requeue`),
  };

  // ─────────────── Packing ───────────────

  const packing = {
    next:    ()  => post('/packing/next'),
    current: ()  => get('/packing/current'),
    scanItem:(d) => post('/packing/scan-item', d),
    confirm: (d) => post('/packing/confirm', d),
  };

  // ─────────────── Shipping ───────────────

  const shipping = {
    board:   (p) => get('/shipping/board', p),
    details: (code) => get('/shipping/details', { shipment_code: code }),
    confirm: (d) => post('/shipping/confirm', d),
    markDelivered: (code) => post('/shipping/mark-delivered', { shipment_code: code }),
  };

  // ─────────────── Overview ("Табло") ───────────────

  const overview = {
    funnel: () => get('/overview/funnel'),
  };

  // ─────────────── WB ───────────────

  const wb = {
    accounts: {
      list:   (p)     => get('/wb/accounts', p),
      create: (d)     => post('/wb/accounts', d),
      update: (id, d) => patch(`/wb/accounts/${id}`, d),
    },
    syncOrders:  (d) => post('/wb/sync-orders', d),
    syncOrdersAll: () => post('/wb/sync-orders-all', {}),
    importItems: (d) => post('/wb/import-items', d),
    generateWave:(d) => post('/wb/generate-wave', d),
    orders:      (p) => get('/wb/orders', p),
    wbItems:     (p) => get('/wb/items', p),
  };

  // ─────────────── Printing ───────────────

  const printing = {
    printers: {
      list:      ()   => get('/printing/printers'),
      create:    (d)  => post('/printing/printers', d),
      update:    (id, d) => patch(`/printing/printers/${id}`, d),
      issueAgentKey: (id) => post(`/printing/printers/${id}/agent-key`, {}),
    },
    routes: {
      list:   ()      => get('/printing/routes'),
      create: (d)     => post('/printing/routes', d),
      update: (id, d) => patch(`/printing/routes/${id}`, d),
      delete: (id)    => del(`/printing/routes/${id}`),
    },
    jobs:      (p)     => get('/printing/jobs', p),
    updateJob: (id, d) => patch(`/printing/jobs/${id}`, d),
    reprint:   (jobId) => post('/printing/jobs/reprint', { job_id: jobId }),
  };

  // ─────────────── Workstations (рабочие места) ───────────────

  const workstations = {
    list:   ()      => get('/workstations'),
    create: (d)     => post('/workstations', d),
    update: (id, d) => patch(`/workstations/${id}`, d),
    delete: (id)    => del(`/workstations/${id}`),
    my:     ()      => get('/workstations/my'),
    select: (station_code) => post('/workstations/select', { station_code }),
    sticker: (id)   => get(`/workstations/${id}/sticker`),
  };

  // ─────────────── Seller ───────────────

  const seller = {
    profile:  ()      => get('/seller/profile'),
    inbound:  {
      list:    (p)    => get('/seller/inbound', p),
      get:     (id)   => get(`/seller/inbound/${id}`),
      create:  (d)    => post('/seller/inbound', d),
      confirm: (id)   => post(`/seller/inbound/${id}/confirm`),
    },
    stock:    (p)     => get('/seller/stock', p),
    orders:   (p)     => get('/seller/orders', p),
    shipments:(p)     => get('/seller/shipments', p),
    items:    (p)     => get('/seller/items', p),
    setItemCostPrice: (itemId, costPrice) => patch(`/seller/items/${itemId}/cost-price`, { cost_price: costPrice }),
    analytics:(p)     => get('/seller/analytics/sales', p),
    history:  (p)     => get('/seller/history', p),
    billing:  (p)     => get('/seller/billing', p),
    wbWarehouses: {
      list:        ()          => get('/seller/wb-warehouses'),
      sync:        ()          => post('/seller/wb-warehouses/sync'),
      update:      (id, data)  => patch(`/seller/wb-warehouses/${id}`, data),
      setReserve:  (reservePct)=> patch('/seller/wb-warehouses/settings/reserve', { reserve_pct: reservePct }),
    },
  };

  // ─────────────── Platform (Owner-admin) ───────────────

  const PLATFORM_TOKEN_KEY = 'wms2_platform_token';

  function getPlatformToken() { return localStorage.getItem(PLATFORM_TOKEN_KEY); }
  function savePlatformAuth(token) { localStorage.setItem(PLATFORM_TOKEN_KEY, token); }
  function clearPlatformAuth() { localStorage.removeItem(PLATFORM_TOKEN_KEY); }
  function isPlatformLoggedIn() { return !!getPlatformToken(); }

  async function platformRequest(method, path, data = null) {
    const token = getPlatformToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    return json;
  }

  const platform = {
    async login(username, password) {
      const res = await platformRequest('POST', '/auth/platform/login', { username, password });
      if (res?.token) savePlatformAuth(res.token);
      return res;
    },
    logout() { clearPlatformAuth(); },
    isLoggedIn: isPlatformLoggedIn,
    // Публичная самостоятельная регистрация — без авторизации, обычный post()
    register: (data) => post('/platform/register', data),
    tenants:  {
      list:        (p) => platformRequest('GET', `/platform/tenants${p ? '?' + new URLSearchParams(p) : ''}`),
      get:         (id)=> platformRequest('GET', `/platform/tenants/${id}`),
      create:      (d) => platformRequest('POST', '/platform/tenants', d),
      update:      (id,d)=> platformRequest('PATCH', `/platform/tenants/${id}`, d),
      setModule:   (id,d)=>platformRequest('POST', `/platform/tenants/${id}/modules`, d),
      extend:      (id,d)=>platformRequest('POST', `/platform/tenants/${id}/extend`, d),
      subscriptions:(id)=>platformRequest('GET', `/platform/tenants/${id}/subscriptions`),
      impersonate: (id)=> platformRequest('POST', `/platform/tenants/${id}/impersonate`),
    },
    plans:   () => platformRequest('GET', '/platform/plans'),
    modules: () => platformRequest('GET', '/platform/modules'),
    stats:   () => platformRequest('GET', '/platform/stats'),
  };

  // ─────────────── Export ───────────────

  window.API = {
    // Core
    get, post, patch, put, del, request,
    // Auth
    auth, getToken, getUser, saveAuth, clearAuth, isLoggedIn,
    // Modules
    users, clients, warehouses, items, locations,
    stock, inbound, receiving,
    placement, movement, inventory,
    picking, packing, shipping,
    wb, printing, overview,
    workstations,
    seller, platform,
  };

})(window);
