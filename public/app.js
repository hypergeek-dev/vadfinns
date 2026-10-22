const main = document.querySelector('#main');
const toastRegion = document.querySelector('#toast-region');
let csrfToken = '';
let toastTimer;

const routes = {
  '/': renderSlider,
  '/album': renderAlbum,
  '/admin': renderAdmin
};

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  history.pushState({}, '', url.pathname);
  renderRoute();
});
window.addEventListener('popstate', renderRoute);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || 'Något gick fel.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function setCurrentNav(path) {
  document.querySelectorAll('.primary-nav a').forEach((link) => {
    const current = new URL(link.href).pathname === path;
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function loading(label = 'Laddar…') {
  const wrap = el('div', 'loading');
  const spinner = el('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  wrap.append(spinner, el('span', '', label));
  main.replaceChildren(wrap);
}

function showError(message, retry) {
  main.replaceChildren();
  const wrap = el('div', 'route-error');
  wrap.append(el('h1', 'page-heading', 'Något gick fel'), el('p', '', message));
  const button = el('button', 'button primary', 'Försök igen');
  button.type = 'button';
  button.addEventListener('click', retry);
  wrap.append(button);
  main.append(wrap);
}

function notify(message, type = 'success') {
  clearTimeout(toastTimer);
  toastRegion.replaceChildren();
  const toast = el('div', `toast ${type === 'error' ? 'error' : ''}`, message);
  toastRegion.append(toast);
  toastTimer = setTimeout(() => toastRegion.replaceChildren(), 3600);
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function renderRoute() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const render = routes[path];
  setCurrentNav(path);
  if (!render) {
    document.title = 'Sidan finns inte — Vad finns?';
    const wrap = el('div', 'route-error');
    const home = el('a', '', 'Vad finns?');
    home.href = '/'; home.dataset.link = '';
    wrap.append(el('h1', 'page-heading', 'Sidan finns inte'), el('p', '', 'Gå tillbaka till maten.'), home);
    main.replaceChildren(wrap);
    return;
  }
  await render();
}

async function renderSlider() {
  document.title = 'Vad finns?';
  loading('Hämtar maten…');
  try {
    const { foods } = await api('/api/foods?available=true');
    if (!foods.length) {
      const empty = el('section', 'empty-state');
      empty.append(el('h1', 'page-heading', 'Inget finns på menyn just nu.'), el('p', '', 'Kom tillbaka och titta lite senare.'));
      main.replaceChildren(empty);
      return;
    }
    let index = 0;
    const page = el('section', 'slider-page');
    page.setAttribute('aria-label', 'Mat som finns');
    const stage = el('div', 'slider-stage');
    const figure = el('figure', 'slider-figure');
    const imageWrap = el('div', 'slider-image-wrap');
    const image = document.createElement('img');
    image.className = 'slider-image';
    imageWrap.append(image);
    figure.append(imageWrap);
    const previous = sliderButton('prev', '‹', 'Visa föregående mat');
    const next = sliderButton('next', '›', 'Visa nästa mat');
    stage.append(figure, previous, next);
    page.append(stage);
    main.replaceChildren(page);

    function update() {
      const food = foods[index];
      image.src = food.imageUrl;
      image.alt = food.name;
    }
    function move(step) { index = (index + step + foods.length) % foods.length; update(); }
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    const onKey = (event) => {
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    };
    document.addEventListener('keydown', onKey, { signal: routeSignal(page) });
    let touchStart = 0;
    stage.addEventListener('touchstart', (event) => { touchStart = event.changedTouches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', (event) => {
      const distance = event.changedTouches[0].clientX - touchStart;
      if (Math.abs(distance) > 45) move(distance > 0 ? -1 : 1);
    }, { passive: true });
    update();
  } catch (error) {
    showError(error.message, renderSlider);
  }
}

function routeSignal(owner) {
  const controller = new AbortController();
  const observer = new MutationObserver(() => {
    if (!owner.isConnected) { controller.abort(); observer.disconnect(); }
  });
  observer.observe(main, { childList: true });
  return controller.signal;
}

function sliderButton(direction, symbol, label) {
  const button = el('button', `slider-arrow ${direction}`, symbol);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  return button;
}

async function renderAlbum() {
  document.title = 'Kan du köpa? — Vad finns?';
  loading('Hämtar alla bilder…');
  try {
    const { foods } = await api('/api/foods');
    const page = el('section', 'album-page');
    const header = el('header', 'album-header');
    header.append(el('h1', 'page-heading', 'Kan du köpa?'), el('p', 'page-intro', 'Titta på allt som finns i bildbiblioteket.'));
    const grid = el('div', 'album-grid');
    grid.setAttribute('aria-label', 'Alla maträtter');
    foods.forEach((food) => grid.append(albumCard(food)));
    page.append(header, grid);
    main.replaceChildren(page);
  } catch (error) {
    showError(error.message, renderAlbum);
  }
}

function albumCard(food) {
  const figure = el('figure', 'photo-card');
  const button = el('button', 'photo-button');
  button.type = 'button';
  button.setAttribute('aria-label', `Visa ${food.name} större`);
  const image = document.createElement('img');
  image.src = food.thumbnailUrl;
  image.alt = food.name;
  image.loading = 'lazy';
  image.decoding = 'async';
  button.append(image);
  button.addEventListener('click', () => openPreview(food));
  figure.append(button, el('figcaption', '', food.name));
  return figure;
}

function openPreview(food) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('aria-label', food.name);
  const close = el('button', 'dialog-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Stäng större bild');
  const figure = el('figure', 'preview-content');
  const image = document.createElement('img');
  image.src = food.imageUrl;
  image.alt = food.name;
  figure.append(image, el('figcaption', '', food.name));
  dialog.append(close, figure);
  document.body.append(dialog);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  close.focus();
}

async function renderAdmin() {
  document.title = 'Admin — Vad finns?';
  loading('Kontrollerar behörighet…');
  try {
    const session = await api('/api/admin/session');
    csrfToken = session.csrfToken;
    await renderAdminLibrary();
  } catch (error) {
    if (error.status === 401) renderLogin();
    else showError(error.message, renderAdmin);
  }
}

function renderLogin() {
  const section = el('section', 'admin-login');
  section.append(el('h1', 'page-heading', 'Admin'), el('p', 'page-intro', 'Logga in för att ändra vad som finns.'));
  const form = document.createElement('form');
  form.noValidate = true;
  const field = el('div', 'field');
  const label = el('label', '', 'Lösenord');
  label.htmlFor = 'admin-password';
  const wrap = el('div', 'password-wrap');
  const input = document.createElement('input');
  input.id = 'admin-password'; input.name = 'password'; input.type = 'password'; input.autocomplete = 'current-password'; input.required = true;
  input.setAttribute('aria-describedby', 'login-error');
  const toggle = el('button', 'password-toggle', 'Visa');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Visa lösenord');
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Dölj' : 'Visa';
    toggle.setAttribute('aria-label', show ? 'Dölj lösenord' : 'Visa lösenord');
    input.focus();
  });
  wrap.append(input, toggle);
  const errorText = el('p', 'field-error');
  errorText.id = 'login-error';
  const submit = el('button', 'button primary login-button', 'Logga in');
  submit.type = 'submit';
  field.append(label, wrap, errorText);
  form.append(field, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorText.textContent = '';
    input.removeAttribute('aria-invalid');
    if (!input.value) {
      errorText.textContent = 'Skriv ditt lösenord.';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    submit.disabled = true;
    try {
      const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: input.value }) });
      csrfToken = result.csrfToken;
      await renderAdminLibrary();
    } catch (error) {
      errorText.textContent = error.message;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    } finally { submit.disabled = false; }
  });
  section.append(form);
  main.replaceChildren(section);
  input.focus();
}

async function renderAdminLibrary({ preserveFocusId } = {}) {
  try {
    const { foods } = await api('/api/foods');
    const page = el('section', 'admin-page');
    const header = el('header', 'admin-header');
    const top = el('div', 'admin-topline');
    const titleGroup = el('div');
    titleGroup.append(el('h1', 'page-heading', 'Admin'), el('p', 'admin-count', `${foods.filter((food) => food.available).length} av ${foods.length} finns just nu`));
    const logout = el('button', 'button secondary', 'Logga ut');
    logout.type = 'button';
    logout.addEventListener('click', async () => {
      try { await api('/api/admin/logout', { method: 'POST' }); } finally { csrfToken = ''; renderLogin(); }
    });
    top.append(titleGroup, logout);
    header.append(top);
    page.append(header, uploadForm());
    const grid = el('div', 'admin-grid');
    grid.setAttribute('aria-label', 'Hantera matbilder');
    foods.forEach((food, index) => grid.append(adminCard(food, index, foods.length)));
    page.append(grid);
    main.replaceChildren(page);
    if (preserveFocusId) document.querySelector(`[data-focus-id="${CSS.escape(preserveFocusId)}"]`)?.focus();
  } catch (error) {
    if (error.status === 401) renderLogin();
    else showError(error.message, renderAdmin);
  }
}

function uploadForm() {
  const form = document.createElement('form');
  form.className = 'upload-panel';
  form.noValidate = true;
  const nameField = el('div', 'field');
  const nameLabel = el('label', '', 'Namn på maten'); nameLabel.htmlFor = 'new-food-name';
  const name = document.createElement('input'); name.id = 'new-food-name'; name.name = 'name'; name.type = 'text'; name.maxLength = 80; name.placeholder = 'Till exempel pannkakor';
  nameField.append(nameLabel, name);
  const imageField = el('div', 'field');
  const imageLabel = el('label', '', 'Ny bild'); imageLabel.htmlFor = 'new-food-image';
  const image = document.createElement('input'); image.id = 'new-food-image'; image.name = 'image'; image.type = 'file'; image.accept = 'image/jpeg,image/png,image/webp'; image.required = true; image.className = 'file-field';
  image.setAttribute('aria-describedby', 'upload-error');
  imageField.append(imageLabel, image);
  const submit = el('button', 'button primary', 'Lägg till bild'); submit.type = 'submit';
  const errorText = el('p', 'field-error'); errorText.id = 'upload-error';
  form.append(nameField, imageField, submit, errorText);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorText.textContent = '';
    image.removeAttribute('aria-invalid');
    if (!image.files[0]) { errorText.textContent = 'Välj en bild.'; image.setAttribute('aria-invalid', 'true'); image.focus(); return; }
    submit.disabled = true;
    const data = new FormData(); data.set('image', image.files[0]); data.set('name', name.value);
    try {
      await api('/api/admin/foods', { method: 'POST', body: data });
      notify('Bilden har lagts till.');
      await renderAdminLibrary();
    } catch (error) { errorText.textContent = error.message; image.setAttribute('aria-invalid', 'true'); image.focus(); }
    finally { submit.disabled = false; }
  });
  return form;
}

function adminCard(food, index, total) {
  const card = el('article', `admin-card${food.available ? ' is-available' : ''}`);
  const toggle = el('button', 'availability-toggle');
  toggle.type = 'button';
  toggle.dataset.focusId = `toggle-${food.id}`;
  toggle.setAttribute('aria-pressed', String(food.available));
  toggle.setAttribute('aria-label', `${food.name}: ${food.available ? 'finns' : 'finns inte'}. Ändra till ${food.available ? 'finns inte' : 'finns'}.`);
  const image = document.createElement('img'); image.src = food.thumbnailUrl; image.alt = food.name; image.loading = 'lazy';
  const badge = el('span', 'availability-badge', food.available ? '✓ Finns' : 'Inte nu');
  toggle.append(image, badge);
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await api(`/api/admin/foods/${food.id}`, { method: 'PATCH', body: JSON.stringify({ available: !food.available }) });
      notify(food.available ? `${food.name} är inte tillgänglig nu.` : `${food.name} finns nu.`);
      await renderAdminLibrary({ preserveFocusId: `toggle-${food.id}` });
    } catch (error) { notify(error.message, 'error'); toggle.disabled = false; }
  });

  const nameForm = document.createElement('form'); nameForm.className = 'name-form'; nameForm.noValidate = true;
  const name = document.createElement('input'); name.type = 'text'; name.value = food.name; name.maxLength = 80; name.setAttribute('aria-label', `Namn på ${food.name}`);
  const save = el('button', 'icon-button', '✓'); save.type = 'submit'; save.setAttribute('aria-label', `Spara namnet för ${food.name}`);
  nameForm.append(name, save);
  nameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value) { name.setAttribute('aria-invalid', 'true'); notify('Namnet får inte vara tomt.', 'error'); name.focus(); return; }
    save.disabled = true;
    try { await api(`/api/admin/foods/${food.id}`, { method: 'PATCH', body: JSON.stringify({ name: value }) }); notify('Namnet har sparats.'); await renderAdminLibrary(); }
    catch (error) { notify(error.message, 'error'); save.disabled = false; }
  });

  const actions = el('div', 'admin-card-actions');
  const order = el('div', 'order-actions');
  const up = moveButton(food, 'up', '↑', 'Flytta tidigare', index === 0);
  const down = moveButton(food, 'down', '↓', 'Flytta senare', index === total - 1);
  order.append(up, down);
  const replace = el('label', 'replace-label', 'Byt bild');
  const replaceInput = document.createElement('input'); replaceInput.type = 'file'; replaceInput.accept = 'image/jpeg,image/png,image/webp'; replaceInput.setAttribute('aria-label', `Byt bild för ${food.name}`);
  replaceInput.addEventListener('change', async () => {
    if (!replaceInput.files[0]) return;
    const data = new FormData(); data.set('image', replaceInput.files[0]);
    replace.classList.add('is-busy');
    try { await api(`/api/admin/foods/${food.id}/image`, { method: 'POST', body: data }); notify('Bilden har bytts.'); await renderAdminLibrary(); }
    catch (error) { notify(error.message, 'error'); replace.classList.remove('is-busy'); }
  });
  replace.append(replaceInput);
  const remove = el('button', 'button ghost-danger', 'Ta bort'); remove.type = 'button';
  remove.addEventListener('click', () => confirmRemoval(food));
  actions.append(order, replace, remove);
  card.append(toggle, nameForm, actions);
  return card;
}

function moveButton(food, direction, symbol, label, disabled) {
  const button = el('button', 'icon-button', symbol); button.type = 'button'; button.disabled = disabled; button.setAttribute('aria-label', `${label}: ${food.name}`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await api(`/api/admin/foods/${food.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }); await renderAdminLibrary({ preserveFocusId: `toggle-${food.id}` }); }
    catch (error) { notify(error.message, 'error'); button.disabled = false; }
  });
  return button;
}

function confirmRemoval(food) {
  const dialog = document.createElement('dialog'); dialog.className = 'dialog confirm-dialog';
  const title = el('h2', '', `Ta bort ${food.name}?`); title.id = `remove-title-${food.id}`;
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.append(title, el('p', '', 'Bilden tas bort från hela biblioteket. Det går inte att ångra.'));
  const actions = el('div', 'dialog-actions');
  const cancel = el('button', 'button secondary', 'Avbryt'); cancel.type = 'button';
  const remove = el('button', 'button danger', 'Ta bort'); remove.type = 'button';
  cancel.addEventListener('click', () => dialog.close());
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try { await api(`/api/admin/foods/${food.id}`, { method: 'DELETE' }); dialog.close(); notify(`${food.name} har tagits bort.`); await renderAdminLibrary(); }
    catch (error) { notify(error.message, 'error'); remove.disabled = false; }
  });
  actions.append(cancel, remove); dialog.append(actions); document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal(); cancel.focus();
}

renderRoute();
