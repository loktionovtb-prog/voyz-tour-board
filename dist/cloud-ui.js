'use strict';
// The account cache and cloud revisions are separate from the original local board.
// No local tour is uploaded until the owner explicitly chooses to import it.
(() => {
  const $ = s => document.querySelector(s);
  const shareParameters = new URLSearchParams(location.hash.slice(1));
  const shareToken = shareParameters.get('share'), isSharedView = shareParameters.has('share');
  // Hash-only navigation reuses this document. Reload for a different shared
  // route or when entering/leaving its isolated viewer; auth hash cleanup stays
  // in the current document because it does not change the share parameter.
  window.addEventListener('hashchange', () => {
    const next = new URLSearchParams(location.hash.slice(1));
    if (next.has('share') !== isSharedView || next.get('share') !== shareToken) location.reload();
  });
  // Read only known, non-secret failure markers. The SDK owns session tokens.
  let incomingAuthFailure = shareParameters.get('error_code') === 'otp_expired'
    ? 'Ссылка для входа уже использована или срок её действия закончился. Запросите новую ссылку ниже и откройте её один раз на этом устройстве.'
    : shareParameters.has('error') || shareParameters.has('error_code')
      ? 'По этой ссылке не удалось войти. Запросите новую ссылку ниже и откройте её на этом устройстве.' : '';
  let board, cloud, session = null, account = '', metadata = null;
  let enabled = false, blocked = false, applying = false, generation = 0;
  let localImport = null, timer = null, queue = Promise.resolve(), authQueue = Promise.resolve();
  let accountSeed = '', accountCacheWasNew = false;
  let status = '', errorStatus = false, working = false, needsSetup = false;
  let dialog, shareDialog, onlineButton, shareButton, loginEmail = '';
  let loginForm, codeForm, accountArea, accountLabel, statusBox, setupArea, ownerActions;
  let pullButton, sendButton, importButton, logoutButton, shareStatus, shareList, shareResult, createShareButton;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function button(label, onClick, className = 'button') {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }
  function note(value, className = 'cloud-description') { return element('p', className, value); }
  function makeDialog(title) {
    const node = element('dialog', 'cloud-dialog');
    node.append(element('h2', '', title));
    document.body.append(node);
    return node;
  }
  function closeRow(node) {
    const row = element('div', 'dialog-actions');
    row.append(button('Закрыть', () => node.close()));
    node.append(row);
  }
  function show(node) { if (!node.open) node.showModal(); }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function fingerprint(value) {
    if (!crypto.subtle) throw new Error('Для синхронизации откройте сайт по HTTPS или через localhost.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
    return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  function projectRef() { try { return new URL(window.VOYZ_CLOUD.url).hostname.split('.')[0]; } catch { return 'unconfigured'; } }
  function usesOTP() { return window.VOYZ_CLOUD?.authMode === 'otp'; }
  function publicShareBase() {
    // A link copied from a local launch must still open on the guide's device.
    for (const candidate of [window.VOYZ_CLOUD?.publicUrl, location.href]) {
      if (typeof candidate !== 'string' || candidate.length > 2048) continue;
      try {
        const url = new URL(candidate), host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|test|invalid)$/.test(host)) continue;
        url.search = ''; url.hash = '';
        return url;
      } catch { /* Try the current public site as a fallback. */ }
    }
    return null;
  }
  function cacheScope(id = account) { return id ? projectRef() + '-' + id : ''; }
  function metaKey(id) { return 'voyz.cloud.meta.' + projectRef() + '.' + id; }
  function lastAccountKey() { return 'voyz.cloud.last.' + projectRef(); }
  function rememberAccount(value) {
    try { localStorage.setItem(lastAccountKey(), JSON.stringify({id: value.user.id, email: value.user.email || ''})); } catch { /* Account documents remain independently saved. */ }
  }
  function forgetAccount() { try { localStorage.removeItem(lastAccountKey()); } catch {} }
  function rememberedAccount() {
    try {
      const value = JSON.parse(localStorage.getItem(lastAccountKey()) || 'null');
      return value && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.email === 'string' && value.email.length <= 320 ? value : null;
    } catch { return null; }
  }
  function freshMetadata() { return {version: 1, tours: Object.create(null)}; }
  function entryFor(tourId) { return metadata && Object.hasOwn(metadata.tours, tourId) ? metadata.tours[tourId] : undefined; }
  function copyMetadata(source) { const result = freshMetadata(); for (const [id, value] of Object.entries(source.tours)) result.tours[id] = {...value}; return result; }
  function readMetadata(id) {
    try {
      const raw = JSON.parse(localStorage.getItem(metaKey(id)) || 'null');
      if (!raw || raw.version !== 1 || !raw.tours || typeof raw.tours !== 'object' || Array.isArray(raw.tours)) return null;
      const tours = Object.create(null);
      for (const [key, value] of Object.entries(raw.tours)) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(key) || !value || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.hash !== 'string' || !/^(?:[0-9a-f]{64})?$/.test(value.hash) || typeof value.deleted !== 'boolean') return null;
        tours[key] = {revision: value.revision, hash: value.hash, deleted: value.deleted};
      }
      return {version: 1, tours};
    } catch { return null; }
  }
  function writeMetadata() {
    if (!account || !metadata) return;
    // If this cannot be saved, stop before another upload can depend on it.
    try { localStorage.setItem(metaKey(account), JSON.stringify(metadata)); }
    catch { blocked = true; throw new Error('Не удалось сохранить сведения о синхронизации на этом устройстве. Отправка остановлена. Скачайте бэкап и освободите место в браузере перед продолжением.'); }
  }
  function sameContext(id, epoch) { return id === account && epoch === generation; }
  function requireContext(id, epoch) { if (!sameContext(id, epoch)) throw new Error('ACCOUNT_CHANGED'); }
  async function requireOwnerSession(id, epoch) {
    if (!navigator.onLine) throw new Error('NETWORK_OFFLINE');
    const current = await cloud.session();
    requireContext(id, epoch);
    if (current?.user?.id !== id) { await authChanged(current); throw new Error('ACCOUNT_CHANGED'); }
    session = current;
  }
  function conflictError() {
    const error = new Error('REVISION_CONFLICT');
    error.code = 'REVISION_CONFLICT';
    return error;
  }
  function isConflict(error) { return String(error?.message || '').includes('REVISION_CONFLICT'); }
  function lockWork(message) {
    document.body.classList.add('voyz-account-locked');
    let lock = $('#voyz-account-lock');
    if (!lock) {
      lock = element('section', 'cloud-account-lock'); lock.id = 'voyz-account-lock';
      lock.append(element('h2', '', 'Пространство временно закрыто'));
      const description = note('', 'cloud-account-lock-message'); description.id = 'voyz-account-lock-message'; lock.append(description);
      const row = element('div', 'cloud-actions');
      row.append(button('Скачать бэкап текущих правок', () => $('#backup-btn')?.click()), button('Обновить страницу', () => location.reload()), button('Закрыть вход на этом устройстве', logout, 'button subtle'));
      lock.append(row); document.body.append(lock);
    }
    $('#voyz-account-lock-message').textContent = message;
    lock.hidden = false;
  }
  function unlockWork() { document.body.classList.remove('voyz-account-locked'); const lock = $('#voyz-account-lock'); if (lock) lock.hidden = true; }
  function explain(error) {
    if (isConflict(error)) return 'Этот тур изменили на другом устройстве. Ваша версия сохранена здесь. Отправка остановлена. Нажмите «Сохранить обе версии и обновить», чтобы получить онлайн-версию и сохранить свою отдельной копией.';
    const authError = String(error?.code || '') + ' ' + String(error?.message || '');
    if (/rate.?limit|too many requests|for security purposes/i.test(authError)) return 'Слишком много запросов письма. Попробуйте позже: на текущем бесплатном подключении доступно до двух писем в час. Уже открытые туры остаются сохранёнными.';
    if (/email.?address.?not.?authorized|email.*not.*authorized/i.test(authError)) return 'Для входа сейчас используйте email своего аккаунта Supabase. Письма на другие адреса пока не подключены. Гиды могут открывать маршрут по общей ссылке без входа.';
    if (!navigator.onLine || /fetch|network|offline|Failed to fetch/i.test(String(error?.message || ''))) return 'Сейчас нет связи с онлайн-хранилищем. Изменения остаются на этом устройстве и будут отправлены, когда связь вернётся.';
    return error?.message || 'Не удалось связаться с онлайн-хранилищем. Ваши местные данные сохранены.';
  }
  function setStatus(message, isError = false) {
    status = message;
    errorStatus = isError;
    renderStatus();
  }
  function renderStatus() {
    if (!onlineButton) return;
    onlineButton.textContent = account ? (blocked ? 'Онлайн · внимание' : !navigator.onLine ? 'Без связи' : working ? 'Синхронизация…' : 'Онлайн') : 'Онлайн';
    onlineButton.dataset.state = errorStatus ? 'error' : account && enabled && navigator.onLine ? 'online' : 'local';
    if (statusBox) {
      statusBox.textContent = status;
      statusBox.classList.toggle('cloud-error', errorStatus);
    }
    const configured = cloud?.configured();
    loginForm.hidden = !configured || !!account;
    codeForm.hidden = !usesOTP() || !configured || !!account || !loginEmail;
    accountArea.hidden = !account;
    accountLabel.textContent = session?.user?.email ? (session.offlineOnly ? 'Сохранённые туры: ' : 'Вы вошли: ') + session.user.email : 'Ваше онлайн-пространство';
    setupArea.hidden = !account || !needsSetup;
    ownerActions.hidden = !account || needsSetup;
    pullButton.textContent = blocked ? 'Сохранить обе версии и обновить' : 'Получить обновления';
    [pullButton, sendButton, importButton, logoutButton].forEach(node => { node.disabled = working; });
    createShareButton.disabled = working || !account || !enabled || blocked || !configured;
    shareButton.disabled = false;
  }
  function serial(task) {
    const run = queue.catch(() => {}).then(async () => {
      working = true; renderStatus();
      try { return await task(); }
      catch (error) {
        if (error.message !== 'ACCOUNT_CHANGED') {
          if (isConflict(error)) blocked = true;
          setStatus(explain(error), true);
        }
        return false;
      } finally { working = false; renderStatus(); }
    });
    queue = run;
    return run;
  }
  function schedule(delay = 3000) {
    clearTimeout(timer);
    if (!account || !enabled || blocked || applying) return;
    timer = setTimeout(() => { timer = null; syncAll(); }, delay);
  }
  async function applyLibrary(library, id, epoch) {
    requireContext(id, epoch);
    applying = true;
    try { await board.setLibrary(library); }
    finally { applying = false; }
    requireContext(id, epoch);
  }
  function blankTour() {
    return board.normalizeTour({version: 1, id: board.newId(), tour: {title: 'Мой новый тур', startDate: '', endDate: ''}, days: [], view: {zoom: 1}});
  }
  function libraryFor(tours, oldActive) {
    if (!tours.length) tours.push(blankTour());
    if (tours.length > 100) throw new Error('В одном пространстве помещается 100 туров. Скачайте бэкап и уберите лишние копии перед импортом.');
    return {version: 2, kind: 'voyz-library', tours, activeTourId: tours.some(t => t.id === oldActive) ? oldActive : tours[0].id};
  }
  function localCopy(tour, occupied, suffix = ' — локальная копия') {
    const copy = structuredClone(tour);
    do { copy.id = board.newId(); } while (occupied.has(copy.id));
    occupied.add(copy.id);
    copy.tour.title = (copy.tour.title || 'Тур').slice(0, 300 - suffix.length) + suffix;
    return copy;
  }
  async function remoteRecords(id, epoch) {
    await requireOwnerSession(id, epoch);
    const list = await cloud.list();
    requireContext(id, epoch);
    if (!Array.isArray(list)) throw new Error('Онлайн-хранилище вернуло неверный список туров.');
    const output = [];
    for (let i = 0; i < list.length; i += 6) {
      const rows = await Promise.all(list.slice(i, i + 6).map(row => cloud.get(row.id)));
      requireContext(id, epoch);
      for (const row of rows) {
        if (!row) continue;
        if (!row.id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Онлайн-хранилище вернуло неверную версию тура.');
        const record = {...row};
        if (!row.deletedAt) {
          record.document = board.normalizeTour(row.document);
          if (record.document.id !== row.id) throw new Error('Идентификатор онлайн-тура не совпадает с документом.');
          record.hash = await fingerprint(record.document);
        } else record.hash = '';
        output.push(record);
      }
    }
    return output;
  }
  async function initializeAccount(importLocal) {
    if (!account || !needsSetup) return;
    const id = account, epoch = generation;
    setStatus('Открываем ваши онлайн-туры…');
    const records = await remoteRecords(id, epoch), tours = [], occupied = new Set(records.map(row => row.id));
    const nextMeta = freshMetadata();
    for (const row of records) {
      nextMeta.tours[row.id] = {revision: row.revision, hash: row.hash, deleted: !!row.deletedAt};
      if (!row.deletedAt) tours.push(row.document);
    }
    // A missing metadata key must not discard account drafts from a previous run.
    // The setup buttons explicitly include these drafts, separately from localImport.
    const accountCache = board.getLibrary(), cacheBefore = canonical(accountCache);
    if (!accountCacheWasNew || cacheBefore !== accountSeed) {
      for (const tour of accountCache.tours) {
        const online = records.find(row => row.id === tour.id && !row.deletedAt);
        if (online && await fingerprint(tour) === online.hash) continue;
        const copy = occupied.has(tour.id) ? localCopy(tour, occupied) : structuredClone(tour);
        occupied.add(copy.id); tours.push(copy);
      }
    }
    if (importLocal && localImport) {
      for (const tour of localImport.tours) {
        const copy = occupied.has(tour.id) ? localCopy(tour, occupied, ' — импорт') : structuredClone(tour);
        occupied.add(copy.id); tours.push(copy);
      }
    }
    if (canonical(board.getLibrary()) !== cacheBefore) throw new Error('Черновик менялся во время загрузки. Он сохранён здесь. Нажмите выбранную кнопку ещё раз, чтобы перенести последнюю версию.');
    const next = libraryFor(tours, importLocal ? localImport?.activeTourId : null);
    await applyLibrary(next, id, epoch);
    metadata = nextMeta;
    writeMetadata();
    needsSetup = false; enabled = true; blocked = false;
    setStatus(importLocal ? 'Местные туры добавлены к онлайн-маршрутам. Отправляем их в ваше личное пространство…' : 'Онлайн-туры загружены. Новые изменения будут сохраняться здесь и отправляться в ваш аккаунт.');
    await syncJob(id, epoch);
  }
  async function syncJob(id = account, epoch = generation) {
    if (!enabled || blocked || !id) return false;
    requireContext(id, epoch);
    if (!navigator.onLine) { setStatus('Нет связи. Изменения сохранены на этом устройстве; отправим их после подключения.'); return false; }
    await requireOwnerSession(id, epoch);
    const library = board.getLibrary(), live = new Set(library.tours.map(t => t.id));
    let sent = 0;
    for (const tour of library.tours) {
      requireContext(id, epoch);
      const hash = await fingerprint(tour), entry = entryFor(tour.id);
      requireContext(id, epoch);
      if (entry && !entry.deleted && hash === entry.hash) continue;
      let expected = entry?.revision || 0;
      if (entry?.deleted) {
        const restored = await cloud.restoreTour(tour.id, expected);
        requireContext(id, epoch);
        expected = restored.revision;
        metadata.tours[tour.id] = {revision: expected, hash: '', deleted: false};
        writeMetadata();
      }
      const result = await cloud.put(tour.id, expected, tour);
      requireContext(id, epoch);
      if (!result || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('Не удалось подтвердить версию сохранённого тура.');
      metadata.tours[tour.id] = {revision: result.revision, hash, deleted: false};
      writeMetadata(); sent++;
    }
    // Deletion is also conditional on the revision this device actually knew.
    for (const [tourId, entry] of Object.entries(metadata.tours)) {
      requireContext(id, epoch);
      if (live.has(tourId) || entry.deleted) continue;
      const result = await cloud.deleteTour(tourId, entry.revision);
      requireContext(id, epoch);
      metadata.tours[tourId] = {revision: result.revision, hash: '', deleted: true};
      writeMetadata(); sent++;
    }
    const latest = board.getLibrary();
    let pending = false;
    for (const tour of latest.tours) {
      const entry = entryFor(tour.id);
      if (!entry || entry.deleted || await fingerprint(tour) !== entry.hash) { pending = true; break; }
    }
    requireContext(id, epoch);
    if (!pending) pending = Object.keys(metadata.tours).some(tourId => !metadata.tours[tourId].deleted && !latest.tours.some(tour => tour.id === tourId));
    setStatus(pending ? 'Последние правки сохранены здесь. Отправим их через несколько секунд.' : 'Всё сохранено онлайн и на этом устройстве.' + (sent ? ' Обновлено туров: ' + sent + '.' : ''));
    if (pending) schedule();
    return !pending;
  }
  function syncAll() { return serial(() => syncJob(account, generation)); }

  async function mergeRemote(records, explicit, id, epoch) {
    // Recompute if the owner typed while hashes were being calculated.
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = board.getLibrary(), before = canonical(current), occupied = new Set([...current.tours.map(t => t.id), ...records.map(row => row.id)]);
      const tours = new Map(current.tours.map(t => [t.id, t])), nextMeta = copyMetadata(metadata), localHashes = new Map();
      let copies = 0;
      for (const tour of current.tours) localHashes.set(tour.id, await fingerprint(tour));
      requireContext(id, epoch);
      for (const row of records) {
        const local = tours.get(row.id), known = entryFor(row.id);
        const clean = local && known && !known.deleted && localHashes.get(row.id) === known.hash;
        const unchangedRemote = known && row.revision === known.revision;
        if (row.deletedAt) {
          if (local) {
            if (!clean) {
              if (!explicit) throw conflictError();
              const copy = localCopy(local, occupied); tours.set(copy.id, copy); copies++;
            }
            tours.delete(row.id);
          }
          nextMeta.tours[row.id] = {revision: row.revision, hash: '', deleted: true};
          continue;
        }
        if (local && !known && localHashes.get(row.id) === row.hash) {
          tours.set(row.id, row.document);
          nextMeta.tours[row.id] = {revision: row.revision, hash: row.hash, deleted: false};
          continue;
        }
        if (local && !clean && !unchangedRemote) {
          if (!explicit) throw conflictError();
          const copy = localCopy(local, occupied); tours.set(copy.id, copy); copies++;
        } else if (local && !clean && unchangedRemote) continue;
        // A locally deleted tour remains an outbox deletion when remote is unchanged.
        if (!local && known && !known.deleted && unchangedRemote) continue;
        if (!local && known && !known.deleted && !unchangedRemote && !explicit) throw conflictError();
        tours.set(row.id, row.document);
        nextMeta.tours[row.id] = {revision: row.revision, hash: row.hash, deleted: false};
      }
      const remoteIds = new Set(records.map(row => row.id));
      for (const [tourId, known] of Object.entries(metadata.tours)) {
        if (remoteIds.has(tourId) || known.deleted) continue;
        if (!explicit) throw conflictError();
        const local = tours.get(tourId);
        if (local) { const copy = localCopy(local, occupied); tours.set(copy.id, copy); copies++; tours.delete(tourId); }
        delete nextMeta.tours[tourId];
      }
      requireContext(id, epoch);
      if (canonical(board.getLibrary()) !== before) continue;
      const next = libraryFor([...tours.values()], current.activeTourId);
      await applyLibrary(next, id, epoch);
      metadata = nextMeta; writeMetadata();
      blocked = false;
      setStatus(copies ? 'Получена онлайн-версия. Ваши отличающиеся туры сохранены отдельными локальными копиями: ' + copies + '.' : 'Получены последние онлайн-версии. Ваши ещё не отправленные правки сохранены.');
      return true;
    }
    setStatus('Вы продолжаете редактировать маршрут. Получение обновлений отложено, чтобы сохранить ваши правки.');
    return false;
  }
  function pullAll(explicit = false) {
    return serial(async () => {
      if (!account || !enabled) return false;
      const id = account, epoch = generation;
      setStatus('Получаем изменения с других устройств…');
      const records = await remoteRecords(id, epoch);
      if (!await mergeRemote(records, explicit, id, epoch)) return false;
      return syncJob(id, epoch);
    });
  }
  async function importLocalTours() {
    if (!localImport?.tours?.length) throw new Error('Местных туров для переноса нет. Выйдите из аккаунта, создайте маршрут и войдите снова.');
    const id = account, epoch = generation, current = board.getLibrary(), occupied = new Set([...current.tours.map(t => t.id), ...Object.keys(metadata.tours)]);
    const tours = [...current.tours];
    for (const tour of localImport.tours) {
      const copy = occupied.has(tour.id) ? localCopy(tour, occupied, ' — импорт') : structuredClone(tour);
      occupied.add(copy.id); tours.push(copy);
    }
    await applyLibrary(libraryFor(tours, current.activeTourId), id, epoch);
    setStatus('Местные туры добавлены. Их исходные версии остаются в местном пространстве.');
    await syncJob(id, epoch);
  }
  async function acceptSession(next) {
    if (isSharedView) return;
    const id = next?.user?.id || '';
    session = next;
    if (id) incomingAuthFailure = '';
    if (id && id === account) { renderStatus(); return; }
    clearTimeout(timer); timer = null;
    enabled = false; blocked = false; needsSetup = false; generation++;
    if (!id) {
      account = ''; metadata = null;
      forgetAccount();
      try { if (board.namespace()) await board.enterAccount(''); }
      catch (error) {
        lockWork('Вход закрыт. Не удалось открыть местную доску, потому что последние правки ещё не записаны в браузер. Данные остаются здесь, но скрыты. Скачайте бэкап и обновите страницу.');
        throw error;
      }
      unlockWork();
      setStatus(incomingAuthFailure || 'Вы в местном пространстве. Здесь сохраняется исходная доска; онлайн-туры остаются в аккаунте.', !!incomingAuthFailure);
      if (incomingAuthFailure) show(dialog);
      return;
    }
    if (!board.namespace()) localImport = board.getLibrary();
    let opened;
    try { opened = await board.enterAccount(cacheScope(id)); }
    catch (error) {
      account = ''; metadata = null;
      lockWork('Не удалось переключить пространство аккаунта. Предыдущие данные скрыты и не будут отправляться новому пользователю. Скачайте бэкап текущих правок и обновите страницу.');
      throw error;
    }
    unlockWork();
    account = id; metadata = readMetadata(id);
    if (!next.offlineOnly) rememberAccount(next);
    if (!metadata || opened.isNew) {
      metadata = freshMetadata();
      accountCacheWasNew = opened.isNew;
      accountSeed = canonical(opened.library);
      needsSetup = true;
      setStatus('Выберите, с каких туров начать. Местные маршруты и клиенты отправляются в аккаунт только после вашего выбора.');
      show(dialog);
    } else {
      enabled = true;
      setStatus('Ваши туры открыты с этого устройства. Проверяем онлайн-обновления…');
      pullAll(false);
    }
    renderStatus();
  }
  function authChanged(next) {
    authQueue = authQueue.catch(() => {}).then(() => acceptSession(next)).catch(error => setStatus(explain(error), true));
    return authQueue;
  }
  async function logout() {
    clearTimeout(timer); timer = null; enabled = false; generation++;
    incomingAuthFailure = '';
    forgetAccount();
    let error;
    try { await cloud.signOut(); } catch (caught) { error = caught; }
    await authChanged(null);
    if (error) setStatus('Вход на этом устройстве закрыт. Онлайн-хранилище сейчас недоступно; местная доска открыта.', true);
    shareDialog.close();
  }

  function buildUI() {
    onlineButton = button('Онлайн', () => show(dialog), 'button cloud-header-button');
    onlineButton.title = 'Вход, синхронизация и другие устройства';
    const header = $('.app-header');
    header?.insertBefore(onlineButton, $('.header-actions'));
    shareButton = button('Поделиться', () => openSharing(), 'button');
    $('.section-actions')?.insertBefore(shareButton, $('#pdf-btn'));
    dialog = makeDialog('Онлайн и другие устройства');
    dialog.append(note('Войдите по email, чтобы открывать свои туры на телефоне, планшете и компьютере. Каждый аккаунт хранит маршруты и клиентов отдельно.'));
    if (!usesOTP()) dialog.append(note('Для входа используйте email своего аккаунта Supabase. Откройте письмо на том устройстве, где хотите работать, и нажмите ссылку. Гидам вход не нужен — отправьте им общий маршрут.', 'cloud-small-note'));
    statusBox = element('div', 'cloud-status'); statusBox.setAttribute('role', 'status'); dialog.append(statusBox);
    loginForm = element('form', 'cloud-form');
    const emailLabel = element('label', '', 'Ваш email'), emailInput = element('input');
    emailInput.type = 'email'; emailInput.required = true; emailInput.autocomplete = 'email'; emailInput.maxLength = 320;
    emailLabel.append(emailInput); loginForm.append(emailLabel);
    const requestCode = element('button', 'button primary', usesOTP() ? 'Получить код' : 'Прислать ссылку'); requestCode.type = 'submit'; loginForm.append(requestCode);
    loginForm.addEventListener('submit', async event => {
      event.preventDefault(); requestCode.disabled = true;
      try {
        loginEmail = emailInput.value.trim(); await cloud.signIn(loginEmail);
        incomingAuthFailure = '';
        setStatus(usesOTP() ? 'Код отправлен на ' + loginEmail + '. Введите цифры из письма.' : 'Ссылка для входа отправлена на ' + loginEmail + '. Откройте письмо на этом устройстве и нажмите ссылку. Проверьте папку «Спам», если письмо не видно.');
        if (usesOTP()) $('#voyz-login-code').focus();
      }
      catch (error) { loginEmail = ''; setStatus(explain(error), true); }
      finally { requestCode.disabled = false; renderStatus(); }
    });
    dialog.append(loginForm);
    codeForm = element('form', 'cloud-form');
    const codeLabel = element('label', '', 'Код из письма'), codeInput = element('input');
    codeInput.id = 'voyz-login-code'; codeInput.inputMode = 'numeric'; codeInput.autocomplete = 'one-time-code'; codeInput.pattern = '[0-9 ]{4,16}'; codeInput.required = true; codeInput.maxLength = 16;
    codeLabel.append(codeInput); codeForm.append(codeLabel);
    const verifyCode = element('button', 'button primary', 'Войти'); verifyCode.type = 'submit'; codeForm.append(verifyCode);
    codeForm.addEventListener('submit', async event => {
      event.preventDefault(); verifyCode.disabled = true;
      try { const next = await cloud.verify(loginEmail, codeInput.value); if (!next?.user?.id) throw new Error('Не удалось подтвердить вход. Запросите новый код.'); await authChanged(next); codeInput.value = ''; }
      catch (error) { setStatus(explain(error), true); }
      finally { verifyCode.disabled = false; renderStatus(); }
    });
    dialog.append(codeForm);
    accountArea = element('div'); accountLabel = element('div', 'cloud-account'); accountArea.append(accountLabel);
    setupArea = element('div', 'cloud-setup');
    setupArea.append(element('strong', '', 'Начать с онлайн-туров или перенести эту доску?'), note('Откроем онлайн-туры и сохраним черновики этого аккаунта; отличающиеся версии останутся отдельными копиями. Перенос также добавит местную доску вместе с её CRM. Исходная местная доска останется.'));
    const setupActions = element('div', 'cloud-actions');
    setupActions.append(button('Онлайн и черновики аккаунта', () => serial(() => initializeAccount(false)), 'button primary'), button('Перенести местные туры и CRM', () => serial(() => initializeAccount(true))));
    setupArea.append(setupActions); accountArea.append(setupArea);
    ownerActions = element('div', 'cloud-actions');
    pullButton = button('Получить обновления', () => pullAll(blocked));
    sendButton = button('Сохранить онлайн сейчас', syncAll, 'button primary');
    importButton = button('Добавить местные туры и CRM', () => {
      if (importButton.dataset.confirm !== 'yes') { importButton.dataset.confirm = 'yes'; importButton.textContent = 'Подтвердить перенос местных туров и CRM'; return; }
      importButton.dataset.confirm = ''; importButton.textContent = 'Добавить местные туры и CRM'; serial(importLocalTours);
    });
    ownerActions.append(sendButton, pullButton, importButton); accountArea.append(ownerActions);
    logoutButton = button('Выйти на этом устройстве', logout, 'button subtle'); accountArea.append(logoutButton);
    accountArea.append(note('Без связи можно продолжать работу. Отправляются только изменения текущего аккаунта. При конфликте сохраняем вашу версию и просим выбрать действие.', 'cloud-small-note'));
    dialog.append(accountArea); closeRow(dialog);
    shareDialog = makeDialog('Поделиться маршрутом');
    shareDialog.append(note('Гиды смогут смотреть маршрут, расписание, проживание, фотографии и заметки. Ссылка открывает только просмотр: список клиентов и оплаты в неё не входят.'));
    shareStatus = element('div', 'cloud-status'); shareStatus.setAttribute('role', 'status'); shareDialog.append(shareStatus);
    createShareButton = button('Создать ссылку на 30 дней', createSharing, 'button primary'); shareDialog.append(createShareButton);
    shareResult = element('div'); shareList = element('div'); shareDialog.append(shareResult, shareList);
    shareDialog.append(note('Ссылка показывает последние сохранённые онлайн-изменения. Любой, у кого есть ссылка, сможет её открыть. Доступ можно отключить ниже.', 'cloud-small-note'));
    closeRow(shareDialog);
  }
  async function openSharing() {
    shareResult.replaceChildren(); shareList.replaceChildren();
    show(shareDialog); renderStatus();
    if (!cloud.configured()) { shareStatus.textContent = 'Онлайн-хранилище ещё не подключено. Пока можно отправить PDF маршрута или изображения дней.'; return; }
    if (!account || !enabled || needsSetup) { shareStatus.textContent = 'Сначала войдите через кнопку «Онлайн» и откройте или перенесите свои туры.'; return; }
    if (blocked) { shareStatus.textContent = 'Сначала сохраните обе версии конфликта через кнопку «Онлайн». Ваш маршрут здесь сохранён.'; return; }
    if (!publicShareBase()) { shareStatus.textContent = 'Для ссылок гидов нужен опубликованный адрес сайта. Откройте онлайн-версию Voyz или подключите её адрес к этой местной копии.'; return; }
    shareStatus.textContent = 'Ссылки для тура «' + board.getLibrary().tours.find(t => t.id === board.getLibrary().activeTourId)?.tour.title + '»';
    await loadSharing();
  }
  async function loadSharing() {
    const id = account, epoch = generation, library = board.getLibrary(), tourId = library.activeTourId;
    try {
      await requireOwnerSession(id, epoch);
      const links = await cloud.listShares(tourId); requireContext(id, epoch);
      if (board.getLibrary().activeTourId !== tourId) return;
      shareList.replaceChildren();
      if (!Array.isArray(links)) throw new Error('Не удалось прочитать ссылки этого тура.');
      const active = links.filter(link => !link.revokedAt && (!link.expiresAt || Date.parse(link.expiresAt) > Date.now()));
      if (!active.length) { shareList.append(note('Действующих ссылок пока нет.', 'cloud-small-note')); return; }
      for (const link of active) {
        const item = element('div', 'cloud-share-item');
        item.append(note('Доступ до ' + (link.expiresAt ? new Date(link.expiresAt).toLocaleDateString('ru-RU') : 'отключения') + (link.createdAt ? ' · создан ' + new Date(link.createdAt).toLocaleDateString('ru-RU') : '')));
        const revoke = button('Отключить доступ', async () => {
          if (revoke.dataset.confirm !== 'yes') { revoke.dataset.confirm = 'yes'; revoke.textContent = 'Подтвердить отключение'; return; }
          revoke.disabled = true;
          try { await requireOwnerSession(id, epoch); await cloud.revoke(link.id); requireContext(id, epoch); shareStatus.textContent = 'Доступ по этой ссылке отключён.'; await loadSharing(); }
          catch (error) { shareStatus.textContent = explain(error); }
          finally { revoke.disabled = false; }
        }, 'button subtle');
        item.append(revoke); shareList.append(item);
      }
    } catch (error) { if (error.message !== 'ACCOUNT_CHANGED') shareStatus.textContent = explain(error); }
  }
  function createSharing() {
    return serial(async () => {
      if (!account || !enabled || blocked) return false;
      const url = publicShareBase();
      if (!url) throw new Error('Для ссылок гидов нужен опубликованный адрес сайта. Откройте онлайн-версию Voyz или подключите её адрес к этой местной копии.');
      const id = account, epoch = generation, tourId = board.getLibrary().activeTourId;
      shareStatus.textContent = 'Сохраняем маршрут онлайн…';
      if (!await syncJob(id, epoch)) { shareStatus.textContent = status; return false; }
      requireContext(id, epoch);
      const current = board.getLibrary().tours.find(t => t.id === tourId), entry = entryFor(tourId);
      if (!current || !entry || entry.deleted || await fingerprint(current) !== entry.hash) throw new Error('Маршрут изменился во время сохранения. Нажмите ещё раз, чтобы отправить последнюю версию.');
      const link = await cloud.createShare(tourId, new Date(Date.now() + 30 * 86400000).toISOString());
      requireContext(id, epoch);
      if (!link || !/^[0-9a-f]{64}$/.test(link.token)) throw new Error('Не удалось подтвердить новую ссылку.');
      url.hash = 'share=' + link.token;
      shareResult.replaceChildren();
      const result = element('div', 'cloud-share-result'), input = element('input', 'cloud-share-link');
      input.readOnly = true; input.value = url.href; input.setAttribute('aria-label', 'Ссылка для гидов'); input.addEventListener('focus', () => input.select());
      result.append(note('Готово. Скопируйте ссылку сейчас — полный адрес показывается только при создании.'), input);
      const row = element('div', 'cloud-actions');
      row.append(button('Копировать ссылку', async () => {
        try { await navigator.clipboard.writeText(url.href); shareStatus.textContent = 'Ссылка скопирована.'; }
        catch { input.focus(); input.select(); shareStatus.textContent = 'Выделили ссылку. Скопируйте её из поля.'; }
      }));
      const open = element('a', 'button', 'Открыть просмотр'); open.href = url.href; open.target = '_blank'; open.rel = 'noopener noreferrer'; row.append(open);
      result.append(row); shareResult.append(result);
      shareStatus.textContent = 'Ссылка создана. Клиенты и оплаты доступны только в вашем аккаунте.';
      await loadSharing(); return true;
    }).then(result => { if (!result && shareDialog.open) shareStatus.textContent = status; return result; });
  }

  function hideEditor() {
    document.body.classList.add('voyz-reading-share');
    for (const node of [...document.body.children]) if (!node.matches('script,link,.voyz-share-page')) node.classList.add('share-owner-hidden');
  }
  function sanitizedRoute(raw) {
    if (!raw || Object.prototype.hasOwnProperty.call(raw, 'crm')) throw new Error('Этот общий маршрут содержит неподходящие данные. Попросите владельца создать новую ссылку.');
    const tour = board.normalizeTour(raw);
    return {
      version: 2, kind: 'voyz-tour', id: tour.id, tour: {...tour.tour}, view: {zoom: 1},
      days: tour.days.map(day => ({id: day.id, title: day.title, description: day.description, photo: day.photo, photoCredit: day.photoCredit, lodgingName: day.lodgingName, lodgingUrl: day.lodgingUrl, noteTitle: day.noteTitle, note: day.note, planBTitle: day.planBTitle, planB: day.planB, schedule: day.schedule.map(row => ({id: row.id, time: row.time, text: row.text})), x: 0, y: 0, width: 720})),
      connections: []
    };
  }
  async function publicCache() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('voyz-public-cache', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('routes');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function cacheShare(token, value) {
    let db;
    try {
      db = await publicCache();
      await new Promise((resolve, reject) => { const transaction = db.transaction('routes', 'readwrite'); transaction.objectStore('routes').put(value, token); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
      return true;
    } catch { return false; }
    finally { db?.close(); }
  }
  async function cachedShare(token) {
    let db;
    try {
      db = await publicCache();
      return await new Promise((resolve, reject) => { const request = db.transaction('routes').objectStore('routes').get(token); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    } catch { return null; }
    finally { db?.close(); }
  }
  function shareDayDate(route, index) {
    if (!route.tour.startDate) return '';
    const day = new Date(route.tour.startDate + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + index);
    return day.toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', timeZone: 'UTC'});
  }
  function renderPublicRoute(container, route) {
    container.replaceChildren();
    container.append(element('h1', 'share-tour-title', route.tour.title || 'Путешествие Voyz'));
    const dates = [route.tour.startDate, route.tour.endDate].filter(Boolean).map(day => new Date(day + 'T12:00:00Z').toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}));
    if (dates.length) container.append(element('p', 'share-tour-dates', dates.join(' — ')));
    if (!route.days.length) { container.append(element('div', 'share-empty', 'Владелец пока собирает маршрут. Нажмите «Обновить» позже.')); return; }
    route.days.forEach((day, index) => {
      const article = element('article', 'share-day'), heading = element('div', 'share-day-heading');
      heading.append(element('div', 'share-day-number', 'ДЕНЬ ' + String(index + 1).padStart(2, '0') + (shareDayDate(route, index) ? ' · ' + shareDayDate(route, index) : '')), element('h2', 'share-day-title', day.title || 'Новый день'));
      article.append(heading);
      if (day.photo) { const image = element('img', 'share-day-photo'); image.src = day.photo; image.alt = day.title || 'Фото дня'; image.loading = 'lazy'; article.append(image); }
      const body = element('div', 'share-day-body');
      if (day.description) body.append(element('div', 'share-description', day.description));
      if (day.lodgingName || day.lodgingUrl) {
        const lodging = element('div', 'share-lodging'); lodging.append(element('div', 'share-section-label', 'ПРОЖИВАНИЕ'));
        if (day.lodgingName) lodging.append(element('strong', '', day.lodgingName));
        const url = board.safeLink(day.lodgingUrl);
        if (url) { const link = element('a', '', 'Открыть место ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; lodging.append(link); }
        else if (day.lodgingUrl) lodging.append(note(day.lodgingUrl, 'cloud-small-note'));
        body.append(lodging);
      }
      body.append(element('div', 'share-section-label', 'ПЛАН ДНЯ'));
      if (!day.schedule.length) body.append(note('План пока не заполнен.', 'cloud-small-note'));
      day.schedule.forEach(event => { const row = element('div', 'share-schedule-row'); row.append(element('div', 'share-schedule-time', event.time || '—'), element('div', 'share-schedule-text', event.text || 'Событие')); body.append(row); });
      for (const [label, content] of [[day.noteTitle || 'Заметки', day.note], [day.planBTitle || 'Заметки 2', day.planB]]) {
        if (!content) continue;
        const block = element('div', 'share-note'); block.append(element('div', 'share-section-label', label), element('div', 'share-note-text', content)); body.append(block);
      }
      if (day.photoCredit) body.append(element('p', 'share-credit', day.photoCredit));
      article.append(body); container.append(article);
    });
  }
  async function bootViewer() {
    hideEditor();
    const page = element('main', 'voyz-share-page'), shell = element('div', 'share-shell'), header = element('div', 'share-header'), image = element('img');
    image.src = 'assets/voyz-logo.png'; image.alt = 'VOYZ'; header.append(image, element('span', '', 'МАРШРУТ ДЛЯ ГИДОВ'));
    const notice = element('div', 'share-notice', 'Открываем общий маршрут…'), content = element('div'), refresh = button('Обновить', refreshViewer);
    shell.append(header, notice, refresh, content); page.append(shell); document.body.append(page);
    let refreshing = false;
    async function refreshViewer() {
      if (refreshing) return; refreshing = true; refresh.disabled = true;
      try {
        if (!/^[0-9a-f]{64}$/.test(shareToken || '')) throw new Error('Ссылка на маршрут некорректна. Попросите владельца прислать новую.');
        if (!cloud?.configured()) throw new Error('Онлайн-хранилище этой доски ещё не подключено.');
        const result = await cloud.readShare(shareToken);
        if (!result) {
          await cacheShare(shareToken, {invalid: true, time: Date.now()});
          content.replaceChildren(); throw new Error('Доступ к маршруту закончился или был отключён владельцем.');
        }
        const route = sanitizedRoute(result.document), expiresAt = result.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString();
        renderPublicRoute(content, route);
        const saved = await cacheShare(shareToken, {route, expiresAt, time: Date.now(), updatedAt: result.updatedAt || ''});
        notice.classList.remove('warning');
        notice.textContent = 'Только просмотр · клиенты и оплаты недоступны.' + (saved ? ' Этот маршрут сохранён для открытия без связи.' : ' Не удалось сохранить копию для открытия без связи.');
      } catch (error) {
        const networkFailure = !navigator.onLine || /fetch|network|offline|Failed to fetch/i.test(String(error.message || ''));
        const cached = networkFailure ? await cachedShare(shareToken) : null;
        if (cached?.route && !cached.invalid && Date.parse(cached.expiresAt) > Date.now()) {
          const route = sanitizedRoute(cached.route);
          renderPublicRoute(content, route);
          notice.textContent = 'Нет связи · сохранённая копия от ' + new Date(cached.time).toLocaleString('ru-RU') + '. После подключения нажмите «Обновить», чтобы увидеть изменения.';
        } else {
          notice.textContent = error.message || 'Не удалось открыть общий маршрут.';
          content.replaceChildren();
        }
        notice.classList.add('warning');
      } finally { refreshing = false; refresh.disabled = false; }
    }
    window.addEventListener('online', refreshViewer);
    await refreshViewer();
  }

  async function boot() {
    board = window.VoyzBoard; cloud = window.VoyzCloud;
    if (!board || !cloud) return;
    if (isSharedView) { await bootViewer(); return; }
    buildUI();
    if (!cloud.configured()) {
      setStatus('Онлайн-хранилище пока не подключено. Туры сохраняются только в этом браузере. Для телефона, планшета и ссылок гидов нужно подключить онлайн-пространство. До подключения скачивайте «Бэкап всех туров».');
      renderStatus(); return;
    }
    setStatus('Можно войти по email. Местная доска остаётся отдельной и переносится только по вашему выбору.');
    document.addEventListener('voyz-local-saved', event => {
      if (!account || !enabled || blocked || applying || event.detail?.namespace !== cacheScope()) return;
      setStatus(navigator.onLine ? 'Правки сохранены здесь. Отправим онлайн через несколько секунд.' : 'Нет связи. Правки сохранены на этом устройстве.');
      schedule();
    });
    window.addEventListener('online', () => { if (account && enabled && !blocked) pullAll(false); });
    window.addEventListener('offline', () => { if (account) setStatus('Нет связи. Продолжайте работу: правки сохраняются на этом устройстве.'); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && account && enabled && !blocked) { clearTimeout(timer); timer = null; syncAll(); } });
    cloud.onAuth((next, event) => { if (event !== 'TOKEN_REFRESHED' || next?.user?.id !== account) authChanged(next); else { session = next; renderStatus(); } });
    try { await authChanged(await cloud.session()); }
    catch (error) {
      const offline = !navigator.onLine || /fetch|network|offline|Failed to fetch/i.test(String(error.message || ''));
      const remembered = offline ? rememberedAccount() : null;
      if (remembered) {
        await authChanged({user: remembered, offlineOnly: true});
        setStatus('Нет связи с входом. Открыты сохранённые туры этого аккаунта. Правки остаются на устройстве; онлайн-доступ будет проверен после подключения.');
      } else setStatus(explain(error), true);
    }
  }
  if (isSharedView) hideEditor();
  if (window.VoyzBoard) boot();
  else document.addEventListener('voyz-ready', boot, {once: true});
})();
