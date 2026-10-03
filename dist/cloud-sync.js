'use strict';
// Thin official-SDK adapter. Loading this file never creates a client or sends mail.
// All route synchronization, recovery choices, and UI remain in the main app.
(() => {
  let client = null, configIdentity = '', authSubscription = null, storageKey = '';
  let latestSession;
  const observers = new Set();

  function fail(message, code) {
    const error = new Error(message);
    error.name = 'VoyzCloudError';
    error.code = code;
    return error;
  }
  function sdkError(error) {
    if (error instanceof Error) return error;
    const result = fail(error?.message || 'Облачный запрос не выполнен.', error?.code || 'CLOUD_REQUEST_FAILED');
    for (const key of ['details', 'hint', 'status']) if (error?.[key] !== undefined) result[key] = error[key];
    return result;
  }
  function config() {
    const raw = window.VOYZ_CLOUD;
    if (!raw || typeof raw.url !== 'string' || typeof raw.publishableKey !== 'string') {
      throw fail('Облако не подключено: укажите URL Supabase и публичный ключ проекта.', 'CLOUD_NOT_CONFIGURED');
    }
    let url;
    try { url = new URL(raw.url.trim()); } catch {
      throw fail('Некорректный адрес проекта Supabase.', 'INVALID_CLOUD_CONFIG');
    }
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)
      || url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw fail('Нужен HTTPS-адрес проекта вида https://имя.supabase.co без пути и параметров.', 'INVALID_CLOUD_CONFIG');
    }
    const key = raw.publishableKey.trim();
    let publicKey = /^sb_publishable_[A-Za-z0-9_-]{10,250}$/.test(key);
    if (!publicKey && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
      try {
        const decode = value => {
          const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
          return JSON.parse(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)));
        };
        const header = decode(key.split('.')[0]), payload = decode(key.split('.')[1]);
        // Decoding only checks key type; Supabase validates the signature itself.
        publicKey = header.alg === 'HS256' && payload.role === 'anon';
      } catch { publicKey = false; }
    }
    if (!publicKey) {
      throw fail('Используйте publishable key или старый anon key. Секретные ключи в браузере запрещены.', 'INVALID_PUBLIC_KEY');
    }
    return {url: url.origin, key};
  }
  function configured() {
    try { config(); return true; } catch { return false; }
  }
  function notify(session, event) {
    const current = session || null;
    latestSession = current;
    // Defer observers outside the SDK auth lock; callbacks may call session/RPC.
    for (const callback of [...observers]) {
      setTimeout(() => { if (observers.has(callback)) callback(current, event); }, 0);
    }
  }
  function disposeClient() {
    authSubscription?.unsubscribe();
    authSubscription = null;
    if (client?.auth?.dispose) client.auth.dispose();
    else client?.auth?.stopAutoRefresh?.();
    client = null;
    configIdentity = '';
  }
  function init() {
    const current = config();
    if (typeof window.supabase?.createClient !== 'function') {
      throw fail('Не загружена библиотека Supabase. Проверьте файл vendor/supabase.min.js и обновите страницу.', 'SUPABASE_SDK_MISSING');
    }
    const identity = current.url + '\n' + current.key;
    if (client && configIdentity === identity) return client;
    disposeClient();
    storageKey = 'voyz.auth.v1.' + new URL(current.url).hostname;
    latestSession = undefined;
    client = window.supabase.createClient(current.url, current.key, {
      db: {schema: 'public'},
      auth: {
        persistSession: true,
        storageKey,
        // The default email template returns an implicit-flow session in the
        // URL hash. The official SDK consumes it and removes the credentials.
        detectSessionInUrl: true,
        // getSession/RPC refresh on demand; this adapter owns no background loop.
        autoRefreshToken: false
      }
    });
    configIdentity = identity;
    const instance = client;
    const result = client.auth.onAuthStateChange((event, session) => {
      if (client === instance) notify(session, event);
    });
    authSubscription = result?.data?.subscription || null;
    return client;
  }
  async function session() {
    const {data, error} = await init().auth.getSession();
    if (error) throw sdkError(error);
    latestSession = data?.session || null;
    return latestSession;
  }
  function onAuth(callback) {
    if (typeof callback !== 'function') throw fail('Нужен обработчик состояния входа.', 'INVALID_OBSERVER');
    observers.add(callback);
    if (latestSession !== undefined) {
      const current = latestSession;
      setTimeout(() => { if (observers.has(callback)) callback(current, 'INITIAL_SESSION'); }, 0);
    }
    return () => observers.delete(callback);
  }
  function emailAddress(value) {
    const email = String(value || '').trim();
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw fail('Введите корректный email.', 'INVALID_EMAIL');
    }
    return email;
  }
  function emailRedirect() {
    for (const candidate of [window.location?.href, window.VOYZ_CLOUD?.publicUrl]) {
      if (typeof candidate !== 'string' || candidate.length > 2048) continue;
      try {
        const url = new URL(candidate);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && local)) continue;
        return url.origin + url.pathname;
      } catch { /* A file launch uses the published site instead. */ }
    }
    throw fail('Откройте опубликованный сайт Voyz или местную копию через localhost, чтобы получить ссылку для входа.', 'INVALID_AUTH_REDIRECT');
  }
  async function signIn(email) {
    const address = emailAddress(email), emailRedirectTo = emailRedirect();
    const {data, error} = await init().auth.signInWithOtp({
      email: address, options: {shouldCreateUser: true, emailRedirectTo}
    });
    if (error) throw sdkError(error);
    return data;
  }
  async function verify(email, code) {
    const token = String(code || '').trim().replace(/\s+/g, '');
    if (!/^[0-9]{4,12}$/.test(token)) throw fail('Введите код из письма.', 'INVALID_OTP');
    const {data, error} = await init().auth.verifyOtp({email: emailAddress(email), token, type: 'email'});
    if (error) throw sdkError(error);
    latestSession = data?.session || null;
    return latestSession;
  }
  async function signOut() {
    const current = init(), currentStorageKey = storageKey;
    let error;
    try {
      const response = await current.auth.signOut({scope: 'local'});
      error = response?.error;
    } catch (caught) { error = caught; }
    finally {
      // Even offline, remove this project's local credentials only. Route data
      // belongs to the main app and must never be deleted by this adapter.
      try {
        for (const key of [currentStorageKey, currentStorageKey + '-code-verifier', currentStorageKey + '.user']) {
          window.localStorage?.removeItem(key);
        }
      } catch { /* SDK/host may provide another storage implementation. */ }
      disposeClient();
      notify(null, 'SIGNED_OUT');
    }
    if (error) throw sdkError(error);
  }
  function id(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
      throw fail('Некорректный идентификатор тура.', 'INVALID_TOUR_ID');
    }
    return value;
  }
  function revision(value, min = 0) {
    if (!Number.isSafeInteger(value) || value < min) throw fail('Некорректная ревизия тура.', 'INVALID_REVISION');
    return value;
  }
  async function rpc(name, parameters) {
    const {data, error} = await init().rpc(name, parameters);
    if (error) throw sdkError(error); // Preserve REVISION_CONFLICT exactly.
    return data;
  }
  const list = () => rpc('voyz_list_tours', {});
  const get = tourId => rpc('voyz_get_tour', {p_tour_id: id(tourId)});
  const put = (tourId, expected, document) => {
    id(tourId); revision(expected);
    if (!document || document.kind !== 'voyz-tour' || document.version !== 2 || document.id !== tourId) {
      throw fail('Нужен документ тура Voyz версии 2 с таким же идентификатором.', 'INVALID_DOCUMENT');
    }
    const copy = typeof structuredClone === 'function' ? structuredClone(document) : JSON.parse(JSON.stringify(document));
    return rpc('voyz_put_tour', {p_tour_id: tourId, p_expected: expected, p_document: copy});
  };
  const deleteTour = (tourId, expected) => rpc('voyz_delete_tour', {p_tour_id: id(tourId), p_expected: revision(expected, 1)});
  const restore = (tourId, expected) => rpc('voyz_restore_tour', {p_tour_id: id(tourId), p_expected: revision(expected, 1)});
  const createShare = (tourId, expiresAt = null) => {
    if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
      throw fail('Некорректная дата окончания доступа.', 'INVALID_EXPIRY');
    }
    return rpc('voyz_create_share', {p_tour_id: id(tourId), p_expires_at: expiresAt});
  };
  const listShares = tourId => rpc('voyz_list_shares', {p_tour_id: id(tourId)});
  const revoke = shareId => {
    if (typeof shareId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shareId)) {
      throw fail('Некорректный идентификатор ссылки.', 'INVALID_SHARE_ID');
    }
    return rpc('voyz_revoke_share', {p_share_id: shareId});
  };
  const readShare = token => {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw fail('Некорректная ссылка на тур.', 'INVALID_SHARE_TOKEN');
    return rpc('voyz_read_share', {p_token: token});
  };
  window.VoyzCloud = Object.freeze({
    configured, init, session, signIn, verify, signOut, onAuth,
    list, get, put, delete: deleteTour, restore, createShare, listShares, revoke, readShare,
    deleteTour, restoreTour: restore, revokeShare: revoke
  });
})();
