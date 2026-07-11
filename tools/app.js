/*
 * Протокол 0 — редактор шаблонов. UI-логика: загрузка шаблонов, генерация формы,
 * переключатель персонажей (localStorage), живое превью, копирование/скачивание кода.
 */
(function () {
  'use strict';

  const LS_CHARACTERS = 'protocol0_characters';
  const LS_ACTIVE_ID = 'protocol0_active_id';

  const state = {
    manifest: [],           // [{id, название, файл}]
    templateCache: {},      // templateId -> {ast, fields, groups, defaults}
    characters: [],         // [{id, название, templateId, данные}]
    activeId: null,
  };

  let updateTimer = null;

  // ---------------------------------------------------------------- utils

  function prettifyLabel(name) {
    const words = name.split('_').map(w => (w.toLowerCase() === 'url' ? 'URL' : w));
    if (words[0]) words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    return words.join(' ');
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (children) children.forEach(c => c && node.appendChild(c));
    return node;
  }

  function newId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------------------------------------------------------------- localStorage

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(LS_CHARACTERS);
      state.characters = raw ? JSON.parse(raw) : [];
    } catch (e) { state.characters = []; }
    state.activeId = localStorage.getItem(LS_ACTIVE_ID) || null;
  }

  function saveToStorage() {
    localStorage.setItem(LS_CHARACTERS, JSON.stringify(state.characters));
    if (state.activeId) localStorage.setItem(LS_ACTIVE_ID, state.activeId);
  }

  function getActiveCharacter() {
    return state.characters.find(c => c.id === state.activeId) || null;
  }

  // ---------------------------------------------------------------- template loading

  // Обычные fetch() без обхода кэша на некоторых серверах (например `python -m http.server`,
  // который не шлёт Cache-Control) браузер всё равно может закэшировать надолго — правки
  // в шаблоне тогда не подхватятся без жёсткой перезагрузки. cache:'no-store' + случайный
  // параметр в URL надёжно обходят это.
  function noCacheUrl(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Math.random().toString(36).slice(2);
  }

  async function loadManifest() {
    const res = await fetch(noCacheUrl('../templates/manifest.json'), { cache: 'no-store' });
    if (!res.ok) throw new Error('Не смог загрузить manifest.json (' + res.status + ')');
    state.manifest = await res.json();
  }

  async function loadTemplate(templateId) {
    if (state.templateCache[templateId]) return state.templateCache[templateId];
    const meta = state.manifest.find(t => t.id === templateId);
    if (!meta) throw new Error('Шаблон "' + templateId + '" не найден в manifest.json');
    const res = await fetch(noCacheUrl('../templates/' + meta.файл), { cache: 'no-store' });
    if (!res.ok) throw new Error('Не смог загрузить шаблон ' + meta.файл + ' (' + res.status + ')');
    const raw = await res.text();

    // Templater.parseTemplate сам вырезает HTML-комментарии перед разбором —
    // никакие {{...}} в комментариях (документация внутри шаблона) не попадут в поля формы.
    const ast = Templater.parseTemplate(raw);
    const { fields, groups } = Templater.collectFields(ast);
    const entry = { ast, fields, groups };
    state.templateCache[templateId] = entry;
    return entry;
  }

  function blankGroupItem(fieldDefs) {
    const item = {};
    fieldDefs.forEach(fd => { item[fd.name] = fd.default || ''; });
    return item;
  }

  function buildInitialData(tpl) {
    const data = {};
    tpl.fields.forEach(f => { data[f.name] = f.default || ''; });
    Object.keys(tpl.groups).forEach(g => {
      // Стартуем с ОДНИМ пустым элементом (не 0 — чтобы форма показывала, какие поля
      // вообще есть у элемента; не с готовым примером — чтобы не выглядело как чужие
      // реальные данные, которые забыли поменять).
      data[g] = [blankGroupItem(tpl.groups[g])];
    });
    return data;
  }

  // ---------------------------------------------------------------- character switcher UI

  function renderCharacterSelect() {
    const sel = document.getElementById('characterSelect');
    sel.innerHTML = '';
    if (state.characters.length === 0) {
      sel.appendChild(el('option', { text: '(нет персонажей)' }));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    state.characters.forEach(c => {
      sel.appendChild(el('option', { value: c.id, text: c.название }));
    });
    sel.value = state.activeId;
  }

  function renderTemplateSelect(selectEl) {
    selectEl.innerHTML = '';
    state.manifest.forEach(t => {
      selectEl.appendChild(el('option', { value: t.id, text: t.название }));
    });
  }

  async function switchToCharacter(id) {
    state.activeId = id;
    saveToStorage();
    const character = getActiveCharacter();
    if (!character) { renderEmptyState(); return; }
    const tpl = await loadTemplate(character.templateId);
    renderForm(tpl, character);
    scheduleUpdate();
  }

  function renderEmptyState() {
    document.getElementById('formRoot').innerHTML = '';
    document.getElementById('formRoot').appendChild(
      el('div', { class: 'empty-hint', text: 'Персонажей пока нет — нажми «＋» вверху, чтобы создать.' })
    );
    document.getElementById('previewFrame').srcdoc = '';
    document.getElementById('codeOutput').value = '';
  }

  // ---------------------------------------------------------------- form rendering

  // Готовая палитра для |color: сначала показываем эти свотчи, «Другой» открывает
  // обычный нативный выбор цвета (для чего угодно за пределами палитры).
  const COLOR_PRESETS = ['#00fbff', '#1c121d', '#a678da', '#f4e8f6', '#e39eef', '#000000', '#ffffff'];

  function isPresetColor(value) {
    return COLOR_PRESETS.some(p => p.toLowerCase() === (value || '').toLowerCase());
  }

  function buildColorInput(fieldDef, initialValue, onChange) {
    const fallback = fieldDef.default || '#0089a3';
    let value = initialValue || fallback;

    const wrap = el('div', { class: 'color-picker' });
    const row = el('div', { class: 'color-swatch-row' });

    // спрятанный нативный input[type=color] — открывается по клику на «Другой»,
    // сам по себе не виден, но именно он выдаёт итоговое значение для «своего» цвета
    const native = el('input', { type: 'color', class: 'color-native-input' });
    native.value = /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

    const otherBtn = el('button', { type: 'button', class: 'color-swatch color-swatch-other', title: 'Другой цвет', text: '?' });

    function refresh() {
      row.querySelectorAll('.color-swatch[data-color]').forEach(sw => {
        sw.classList.toggle('selected', sw.dataset.color.toLowerCase() === value.toLowerCase());
      });
      const custom = !isPresetColor(value);
      otherBtn.classList.toggle('selected', custom);
      otherBtn.style.background = custom ? value : '';
      otherBtn.textContent = custom ? '' : '?';
    }

    COLOR_PRESETS.forEach(color => {
      const sw = el('button', { type: 'button', class: 'color-swatch', title: color });
      sw.dataset.color = color;
      sw.style.background = color;
      sw.addEventListener('click', () => {
        value = color;
        native.value = color;
        refresh();
        onChange(value);
      });
      row.appendChild(sw);
    });

    otherBtn.addEventListener('click', () => native.click());
    native.addEventListener('input', () => {
      value = native.value;
      refresh();
      onChange(value);
    });

    row.appendChild(otherBtn);
    refresh();
    wrap.appendChild(row);
    wrap.appendChild(native);
    return wrap;
  }

  // Курируемая «избранная» подборка под тематику Протокола 0 — показывается сразу,
  // без поиска (быстро, тематично, не нужно листать полторы тысячи иконок). cls —
  // то, что попадёт в атрибут class целиком.
  const ICON_FEATURED = [
    { cls: 'fa-solid fa-star', label: 'Звезда' },
    { cls: 'fa-solid fa-heart', label: 'Сердце' },
    { cls: 'fa-solid fa-bookmark', label: 'Закладка' },
    { cls: 'fa-solid fa-flag', label: 'Флаг' },
    { cls: 'fa-solid fa-tag', label: 'Тег' },
    { cls: 'fa-solid fa-bell', label: 'Колокол' },
    { cls: 'fa-solid fa-gear', label: 'Шестерня' },
    { cls: 'fa-solid fa-lock', label: 'Замок' },
    { cls: 'fa-solid fa-lock-open', label: 'Открытый замок' },
    { cls: 'fa-solid fa-eye', label: 'Глаз' },
    { cls: 'fa-solid fa-eye-slash', label: 'Скрыть' },
    { cls: 'fa-solid fa-magnifying-glass', label: 'Поиск' },
    { cls: 'fa-solid fa-link', label: 'Ссылка' },
    { cls: 'fa-solid fa-globe', label: 'Глобус' },
    { cls: 'fa-solid fa-compass', label: 'Компас' },
    { cls: 'fa-solid fa-map', label: 'Карта' },
    { cls: 'fa-solid fa-book', label: 'Книга' },
    { cls: 'fa-solid fa-book-open', label: 'Открытая книга' },
    { cls: 'fa-solid fa-folder', label: 'Папка' },
    { cls: 'fa-solid fa-folder-open', label: 'Открытая папка' },
    { cls: 'fa-solid fa-images', label: 'Галерея' },
    { cls: 'fa-solid fa-image', label: 'Картинка' },
    { cls: 'fa-solid fa-camera', label: 'Камера' },
    { cls: 'fa-solid fa-music', label: 'Музыка' },
    { cls: 'fa-solid fa-video', label: 'Видео' },
    { cls: 'fa-solid fa-file', label: 'Файл' },
    { cls: 'fa-solid fa-envelope', label: 'Письмо' },
    { cls: 'fa-solid fa-comment', label: 'Комментарий' },
    { cls: 'fa-solid fa-share-nodes', label: 'Поделиться' },
    { cls: 'fa-solid fa-thumbtack', label: 'Кнопка' },
    { cls: 'fa-solid fa-calendar', label: 'Календарь' },
    { cls: 'fa-solid fa-clock', label: 'Часы' },
    { cls: 'fa-solid fa-circle-info', label: 'Инфо' },
    { cls: 'fa-solid fa-circle-check', label: 'Галочка' },
    { cls: 'fa-solid fa-circle-xmark', label: 'Крестик' },
    { cls: 'fa-solid fa-gift', label: 'Подарок' },
    { cls: 'fa-solid fa-trophy', label: 'Трофей' },
    { cls: 'fa-solid fa-medal', label: 'Медаль' },
    { cls: 'fa-solid fa-key', label: 'Ключ' },
    { cls: 'fa-solid fa-palette', label: 'Палитра' },
    { cls: 'fa-solid fa-paintbrush', label: 'Кисть' },
    { cls: 'fa-solid fa-pen-nib', label: 'Перо' },
    { cls: 'fa-solid fa-wand-magic-sparkles', label: 'Магия' },
    { cls: 'fa-solid fa-user', label: 'Пользователь' },
    { cls: 'fa-solid fa-user-group', label: 'Группа' },
    { cls: 'fa-solid fa-crown', label: 'Корона' },
    { cls: 'fa-solid fa-mask', label: 'Маска' },
    { cls: 'fa-solid fa-ghost', label: 'Призрак' },
    { cls: 'fa-solid fa-skull', label: 'Череп' },
    { cls: 'fa-solid fa-dragon', label: 'Дракон' },
    { cls: 'fa-solid fa-paw', label: 'Лапа' },
    { cls: 'fa-solid fa-feather', label: 'Перо (птица)' },
    { cls: 'fa-solid fa-hat-wizard', label: 'Шляпа волшебника' },
    { cls: 'fa-solid fa-handshake', label: 'Рукопожатие' },
    { cls: 'fa-solid fa-fire', label: 'Огонь' },
    { cls: 'fa-solid fa-bolt', label: 'Молния' },
    { cls: 'fa-solid fa-snowflake', label: 'Снежинка' },
    { cls: 'fa-solid fa-droplet', label: 'Капля' },
    { cls: 'fa-solid fa-leaf', label: 'Лист' },
    { cls: 'fa-solid fa-tree', label: 'Дерево' },
    { cls: 'fa-solid fa-mountain', label: 'Гора' },
    { cls: 'fa-solid fa-water', label: 'Вода' },
    { cls: 'fa-solid fa-sun', label: 'Солнце' },
    { cls: 'fa-solid fa-moon', label: 'Луна' },
    { cls: 'fa-solid fa-wind', label: 'Ветер' },
    { cls: 'fa-solid fa-seedling', label: 'Росток' },
    { cls: 'fa-solid fa-meteor', label: 'Метеор' },
    { cls: 'fa-solid fa-robot', label: 'Робот' },
    { cls: 'fa-solid fa-satellite', label: 'Спутник' },
    { cls: 'fa-solid fa-satellite-dish', label: 'Антенна' },
    { cls: 'fa-solid fa-rocket', label: 'Ракета' },
    { cls: 'fa-solid fa-atom', label: 'Атом' },
    { cls: 'fa-solid fa-dna', label: 'ДНК' },
    { cls: 'fa-solid fa-microchip', label: 'Микрочип' },
    { cls: 'fa-solid fa-radiation', label: 'Радиация' },
    { cls: 'fa-solid fa-biohazard', label: 'Биоопасность' },
    { cls: 'fa-solid fa-brain', label: 'Мозг' },
    { cls: 'fa-solid fa-circle-nodes', label: 'Сеть/связи' },
    { cls: 'fa-solid fa-network-wired', label: 'Сеть (кабель)' },
    { cls: 'fa-solid fa-shield', label: 'Щит' },
    { cls: 'fa-solid fa-shield-halved', label: 'Щит (гербовый)' },
    { cls: 'fa-solid fa-user-shield', label: 'Защита пользователя' },
    { cls: 'fa-solid fa-user-lock', label: 'Ограниченный доступ' },
    { cls: 'fa-solid fa-vial', label: 'Пробирка' },
    { cls: 'fa-solid fa-flask', label: 'Колба' },
    { cls: 'fa-solid fa-syringe', label: 'Шприц' },
    { cls: 'fa-solid fa-pills', label: 'Таблетки' },
    { cls: 'fa-solid fa-heart-crack', label: 'Разбитое сердце' },
    { cls: 'fa-solid fa-triangle-exclamation', label: 'Предупреждение' },
    { cls: 'fa-solid fa-skull-crossbones', label: 'Череп с костями' },
    { cls: 'fa-solid fa-ban', label: 'Запрет' },
    { cls: 'fa-solid fa-circle-exclamation', label: 'Внимание' },
    { cls: 'fa-solid fa-house', label: 'Дом' },
    { cls: 'fa-solid fa-building', label: 'Здание' },
    { cls: 'fa-solid fa-city', label: 'Город' },
    { cls: 'fa-solid fa-earth-americas', label: 'Мир/планета' },
    { cls: 'fa-solid fa-location-dot', label: 'Локация' },
    { cls: 'fa-solid fa-door-open', label: 'Открытая дверь' },
    { cls: 'fa-solid fa-archway', label: 'Арка' },
    { cls: 'fa-solid fa-landmark', label: 'Памятник' },
    { cls: 'fa-brands fa-discord', label: 'Discord' },
    { cls: 'fa-brands fa-telegram', label: 'Telegram' },
    { cls: 'fa-brands fa-x-twitter', label: 'X / Twitter' },
    { cls: 'fa-brands fa-instagram', label: 'Instagram' },
    { cls: 'fa-brands fa-tumblr', label: 'Tumblr' },
    { cls: 'fa-brands fa-deviantart', label: 'DeviantArt' },
    { cls: 'fa-brands fa-twitch', label: 'Twitch' },
    { cls: 'fa-brands fa-youtube', label: 'YouTube' },
    { cls: 'fa-brands fa-tiktok', label: 'TikTok' },
    { cls: 'fa-brands fa-patreon', label: 'Patreon' },
    { cls: 'fa-brands fa-github', label: 'GitHub' },
    { cls: 'fa-brands fa-spotify', label: 'Spotify' },
    { cls: 'fa-brands fa-bluesky', label: 'Bluesky' },
    { cls: 'fa-brands fa-pinterest', label: 'Pinterest' },
    { cls: 'fa-brands fa-facebook', label: 'Facebook' },
  ];

  let iconPickerCallback = null;

  // Полный список иконок Font Awesome Free (~1880 штук) — сжатая версия официальных
  // метаданных (только id/label/стили/поисковые термины, без SVG-путей — оригинальный
  // файл весит ~4.8МБ, наш tools/icon-list.json — ~250КБ). Грузится один раз в фоне
  // при старте инструмента (см. init()), используется только когда что-то ищут —
  // без запроса показывается компактная ICON_FEATURED.
  const iconLibrary = { list: null, loading: null };

  function loadIconLibrary() {
    if (iconLibrary.list) return Promise.resolve(iconLibrary.list);
    if (iconLibrary.loading) return iconLibrary.loading;
    iconLibrary.loading = fetch('icon-list.json')
      .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(list => { iconLibrary.list = list; return list; })
      .catch(() => { iconLibrary.list = []; return []; });
    return iconLibrary.loading;
  }

  function fullLibraryEntryToPreset(entry) {
    const style = entry.styles[0]; // solid, если есть — оно первое в метаданных FA
    return { cls: style + ' fa-' + entry.id, label: entry.label };
  }

  function renderIconGrid(filterText) {
    const grid = document.getElementById('iconPickerGrid');
    grid.innerHTML = '';
    const q = filterText.trim().toLowerCase();

    if (!q) {
      renderIconCells(grid, ICON_FEATURED);
      return;
    }

    if (!iconLibrary.list) {
      grid.appendChild(el('div', { class: 'icon-picker-empty', text: 'Загружаю полный список иконок…' }));
      loadIconLibrary().then(() => {
        // если модалка всё ещё открыта с тем же запросом — перерисовать уже по полному списку
        if (!document.getElementById('iconPickerModal').classList.contains('hidden')) {
          renderIconGrid(document.getElementById('iconPickerSearch').value);
        }
      });
      return;
    }

    const matches = iconLibrary.list.filter(entry => entry.s.includes(q));
    const list = matches.slice(0, 120).map(fullLibraryEntryToPreset);
    renderIconCells(grid, list, matches.length > 120 ? matches.length : null);
  }

  function renderIconCells(grid, list, totalMatches) {
    if (!list.length) {
      grid.appendChild(el('div', { class: 'icon-picker-empty', text: 'Ничего не найдено — впиши свой класс ниже.' }));
      return;
    }
    list.forEach(icon => {
      const cell = el('button', { type: 'button', class: 'icon-picker-cell', title: icon.cls });
      cell.appendChild(el('i', { class: icon.cls }));
      cell.appendChild(el('span', { text: icon.label }));
      cell.addEventListener('click', () => {
        if (iconPickerCallback) iconPickerCallback(icon.cls);
        closeIconPicker();
      });
      grid.appendChild(cell);
    });
    if (totalMatches) {
      grid.appendChild(el('div', { class: 'icon-picker-more', text: 'Показаны первые 120 из ' + totalMatches + ' — уточни запрос.' }));
    }
  }

  function openIconPicker(currentValue, onSelect) {
    iconPickerCallback = onSelect;
    document.getElementById('iconPickerSearch').value = '';
    document.getElementById('iconPickerCustomInput').value = currentValue || '';
    renderIconGrid('');
    document.getElementById('iconPickerModal').classList.remove('hidden');
    document.getElementById('iconPickerSearch').focus();
  }

  function closeIconPicker() {
    document.getElementById('iconPickerModal').classList.add('hidden');
    iconPickerCallback = null;
  }

  function buildIconInput(fieldDef, initialValue, onChange) {
    let value = initialValue || fieldDef.default || '';
    const wrap = el('div', { class: 'icon-picker-field' });
    const btn = el('button', { type: 'button', class: 'icon-picker-trigger' });
    const preview = el('i', { class: value || 'fa-solid fa-icons' });
    const label = el('span', { class: 'icon-picker-trigger-label', text: value || 'Выбрать иконку' });
    btn.appendChild(preview);
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      openIconPicker(value, (newVal) => {
        value = newVal;
        preview.className = value;
        label.textContent = value;
        onChange(value);
      });
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // Строит <input>/<textarea> под fieldDef (учитывает |textarea, |url, |number, |color,
  // |checkbox, |icon, и placeholder из {{поле~подсказка}} — в отличие от {{поле=дефолт}},
  // значение НЕ подставляется, только показывается серым как подсказка формата).
  // |checkbox — булево поле: значение "1" = включено, "" = выключено (используется
  // вместе с {{#поле}}...{{/поле}} в шаблоне для условных блоков — показать/скрыть
  // пункт меню, назначить вкладку стартовой и т.д.)
  function buildFieldInput(fieldDef, initialValue, onChange) {
    if (fieldDef.filter === 'checkbox') {
      const input = el('input', { type: 'checkbox', class: 'field-input-checkbox' });
      input.checked = initialValue === '1' || initialValue === true;
      input.addEventListener('change', () => onChange(input.checked ? '1' : ''));
      return input;
    }
    if (fieldDef.filter === 'color') {
      return buildColorInput(fieldDef, initialValue, onChange);
    }
    if (fieldDef.filter === 'icon') {
      return buildIconInput(fieldDef, initialValue, onChange);
    }
    let input;
    if (fieldDef.filter === 'textarea') {
      input = el('textarea', { class: 'field-textarea' });
    } else {
      const type = fieldDef.filter === 'url' ? 'url' : (fieldDef.filter === 'number' ? 'number' : 'text');
      input = el('input', { type: type, class: 'field-input' });
    }
    if (fieldDef.placeholder) input.setAttribute('placeholder', fieldDef.placeholder);
    input.value = initialValue || '';
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  function createScalarInput(fieldDef, character) {
    const isCheckbox = fieldDef.filter === 'checkbox';
    const wrap = el('label', { class: isCheckbox ? 'field-label field-label-checkbox' : 'field-label' });
    const input = buildFieldInput(fieldDef, character.данные[fieldDef.name], (val) => {
      character.данные[fieldDef.name] = val;
      scheduleUpdate();
    });
    if (isCheckbox) {
      wrap.appendChild(input);
      wrap.appendChild(el('span', { class: 'label-text', text: prettifyLabel(fieldDef.name) }));
    } else {
      wrap.appendChild(el('span', { class: 'label-text', text: prettifyLabel(fieldDef.name) }));
      wrap.appendChild(input);
    }
    return wrap;
  }

  function renderGroupItem(groupName, fieldDefs, character, index) {
    const arr = character.данные[groupName];
    const item = arr[index];
    const card = el('div', { class: 'group-item' });
    const header = el('div', { class: 'group-item-header' }, [
      el('span', { class: 'group-item-label', text: '#' + (index + 1) }),
    ]);
    const actions = el('div', { class: 'group-item-actions' });

    const btnUp = el('button', { type: 'button', title: 'Вверх', text: '↑' });
    btnUp.addEventListener('click', () => {
      if (index === 0) return;
      const tmp = arr[index - 1]; arr[index - 1] = arr[index]; arr[index] = tmp;
      rerenderCurrentForm();
    });
    const btnDown = el('button', { type: 'button', title: 'Вниз', text: '↓' });
    btnDown.addEventListener('click', () => {
      if (index === arr.length - 1) return;
      const tmp = arr[index + 1]; arr[index + 1] = arr[index]; arr[index] = tmp;
      rerenderCurrentForm();
    });
    const btnDel = el('button', { type: 'button', title: 'Удалить', text: '✕' });
    btnDel.addEventListener('click', () => {
      arr.splice(index, 1);
      rerenderCurrentForm();
    });

    actions.appendChild(btnUp);
    actions.appendChild(btnDown);
    actions.appendChild(btnDel);
    header.appendChild(actions);
    card.appendChild(header);

    fieldDefs.forEach(fd => {
      const isCheckbox = fd.filter === 'checkbox';
      const wrap = el('label', { class: isCheckbox ? 'field-label field-label-checkbox' : 'field-label' });
      const input = buildFieldInput(fd, item[fd.name], (val) => {
        item[fd.name] = val;
        scheduleUpdate();
      });
      if (isCheckbox) {
        wrap.appendChild(input);
        wrap.appendChild(el('span', { class: 'label-text', text: prettifyLabel(fd.name) }));
      } else {
        wrap.appendChild(el('span', { class: 'label-text', text: prettifyLabel(fd.name) }));
        wrap.appendChild(input);
      }
      card.appendChild(wrap);
    });

    return card;
  }

  function renderGroupBlock(groupName, fieldDefs, character) {
    const block = el('div', { class: 'group-block' });
    const titleRow = el('div', { class: 'group-title-row' }, [
      el('span', { class: 'group-title', text: prettifyLabel(groupName) }),
    ]);
    block.appendChild(titleRow);

    if (!character.данные[groupName]) character.данные[groupName] = [];
    character.данные[groupName].forEach((item, idx) => {
      block.appendChild(renderGroupItem(groupName, fieldDefs, character, idx));
    });

    const btnAdd = el('button', { type: 'button', class: 'btn btn-add', text: '+ добавить элемент' });
    btnAdd.addEventListener('click', () => {
      character.данные[groupName].push(blankGroupItem(fieldDefs));
      rerenderCurrentForm();
    });
    block.appendChild(btnAdd);

    return block;
  }

  function renderForm(tpl, character) {
    const root = document.getElementById('formRoot');
    root.innerHTML = '';

    const scalarSection = el('div', { class: 'field-section' });
    scalarSection.appendChild(el('div', { class: 'field-section-title', text: 'Основные поля' }));
    tpl.fields.forEach(fd => scalarSection.appendChild(createScalarInput(fd, character)));
    root.appendChild(scalarSection);

    Object.keys(tpl.groups).forEach(groupName => {
      root.appendChild(renderGroupBlock(groupName, tpl.groups[groupName], character));
    });
  }

  async function rerenderCurrentForm() {
    const character = getActiveCharacter();
    if (!character) return;
    const tpl = await loadTemplate(character.templateId);
    renderForm(tpl, character);
    scheduleUpdate();
  }

  // ---------------------------------------------------------------- output (preview + code)

  function buildFullDocument(fragmentHtml, title) {
    return '<!DOCTYPE html>\n<html lang="ru">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + (title || 'Протокол 0') + '</title>\n' +
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@4.6.2/dist/css/bootstrap.min.css">\n' +
      '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">\n' +
      '</head>\n<body style="margin:0;">\n' +
      fragmentHtml +
      '\n<script src="https://code.jquery.com/jquery-3.6.0.min.js"><\/script>\n' +
      '<script src="https://cdn.jsdelivr.net/npm/bootstrap@4.6.2/dist/js/bootstrap.bundle.min.js"><\/script>\n' +
      '<script>$(function () { $(\'[data-toggle="tooltip"]\').tooltip(); });<\/script>\n' +
      '</body>\n</html>\n';
  }

  async function updateOutputs() {
    const character = getActiveCharacter();
    if (!character) return;
    const tpl = await loadTemplate(character.templateId);
    const fragment = Templater.renderTemplate(tpl.ast, character.данные).trim();

    document.getElementById('codeOutput').value = fragment;
    document.getElementById('previewFrame').srcdoc = buildFullDocument(fragment, character.название);

    saveToStorage();
  }

  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(updateOutputs, 250);
  }

  // ---------------------------------------------------------------- character CRUD

  function openNewCharModal() {
    renderTemplateSelect(document.getElementById('newCharTemplate'));
    document.getElementById('newCharName').value = '';
    document.getElementById('newCharModal').classList.remove('hidden');
  }
  function closeNewCharModal() {
    document.getElementById('newCharModal').classList.add('hidden');
  }

  async function createCharacter() {
    const name = document.getElementById('newCharName').value.trim() || 'Новый персонаж';
    const templateId = document.getElementById('newCharTemplate').value;
    const tpl = await loadTemplate(templateId);
    const character = {
      id: newId(),
      название: name,
      templateId: templateId,
      данные: buildInitialData(tpl),
    };
    state.characters.push(character);
    state.activeId = character.id;
    saveToStorage();
    closeNewCharModal();
    renderCharacterSelect();
    renderForm(tpl, character);
    scheduleUpdate();
  }

  function renameCharacter() {
    const character = getActiveCharacter();
    if (!character) return;
    const name = prompt('Новое имя персонажа:', character.название);
    if (name && name.trim()) {
      character.название = name.trim();
      saveToStorage();
      renderCharacterSelect();
    }
  }

  function deleteCharacter() {
    const character = getActiveCharacter();
    if (!character) return;
    if (!confirm('Удалить «' + character.название + '»? Это необратимо.')) return;
    state.characters = state.characters.filter(c => c.id !== character.id);
    state.activeId = state.characters.length ? state.characters[0].id : null;
    saveToStorage();
    renderCharacterSelect();
    if (state.activeId) switchToCharacter(state.activeId);
    else renderEmptyState();
  }

  // ---------------------------------------------------------------- copy / download

  async function copyCode() {
    const text = document.getElementById('codeOutput').value;
    try {
      await navigator.clipboard.writeText(text);
      flashButton('btnCopyCode', 'Скопировано ✓');
    } catch (e) {
      const ta = document.getElementById('codeOutput');
      ta.select();
      flashButton('btnCopyCode', 'Выделено — жми Ctrl+C');
    }
  }

  function flashButton(id, tempText) {
    const btn = document.getElementById(id);
    const original = btn.textContent;
    btn.textContent = tempText;
    setTimeout(() => { btn.textContent = original; }, 1500);
  }

  function downloadRender() {
    const character = getActiveCharacter();
    if (!character) return;
    const fragment = document.getElementById('codeOutput').value;
    const full = buildFullDocument(fragment, character.название);
    const blob = new Blob([full], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: (character.название || 'render').replace(/\s+/g, '_') + '.html' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------- panel tabs (mobile)

  function setupTabs() {
    document.querySelectorAll('.mobile-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mobile-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
      });
    });
  }

  // переключатель Превью/Код для ПК-раскладки — отдельный от мобильных вкладок
  // (там форма всегда видна слева, крутится только правая колонка)
  function setupPaneTabs() {
    document.querySelectorAll('.pane-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pane-tab').forEach(b => b.classList.remove('active'));
        document.getElementById('panel-preview').classList.remove('pane-active');
        document.getElementById('panel-code').classList.remove('pane-active');
        btn.classList.add('active');
        document.getElementById('panel-' + btn.dataset.pane).classList.add('pane-active');
      });
    });
  }

  // ---------------------------------------------------------------- backup (export/import JSON)

  function exportBackup() {
    const payload = { protocol0Backup: 1, characters: state.characters, activeId: state.activeId };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'protokol0_backup.json' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) {
        alert('Не смог прочитать файл: это не JSON.');
        return;
      }
      const incoming = Array.isArray(data) ? data : (Array.isArray(data.characters) ? data.characters : null);
      if (!incoming) { alert('Не похоже на резервную копию Протокола 0.'); return; }

      const added = incoming.map(c => ({
        id: newId(),
        название: c.название || 'Импортированный персонаж',
        templateId: c.templateId || (state.manifest[0] && state.manifest[0].id),
        данные: c.данные || {},
      }));
      state.characters = state.characters.concat(added);
      if (added.length) state.activeId = added[0].id;
      saveToStorage();
      renderCharacterSelect();
      if (state.activeId) switchToCharacter(state.activeId);
      alert('Загружено персонажей: ' + added.length);
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------- init

  async function init() {
    setupTabs();
    setupPaneTabs();
    document.querySelector('.panel-form').classList.add('active');
    document.getElementById('panel-preview').classList.add('pane-active');
    loadIconLibrary(); // грузим в фоне заранее, чтобы к открытию попапа список уже был готов

    document.getElementById('btnNewChar').addEventListener('click', openNewCharModal);
    document.getElementById('btnNewCharCancel').addEventListener('click', closeNewCharModal);
    document.getElementById('btnNewCharCreate').addEventListener('click', createCharacter);
    document.getElementById('btnRenameChar').addEventListener('click', renameCharacter);
    document.getElementById('btnDeleteChar').addEventListener('click', deleteCharacter);
    document.getElementById('characterSelect').addEventListener('change', (e) => switchToCharacter(e.target.value));
    document.getElementById('btnCopyCode').addEventListener('click', copyCode);
    document.getElementById('btnDownloadRender').addEventListener('click', downloadRender);
    document.getElementById('btnExportData').addEventListener('click', exportBackup);
    document.getElementById('btnImportData').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importBackup(file);
      e.target.value = '';
    });

    document.getElementById('iconPickerSearch').addEventListener('input', (e) => renderIconGrid(e.target.value));
    document.getElementById('btnIconPickerCancel').addEventListener('click', closeIconPicker);
    document.getElementById('btnIconPickerApplyCustom').addEventListener('click', () => {
      const val = document.getElementById('iconPickerCustomInput').value.trim();
      if (val && iconPickerCallback) iconPickerCallback(val);
      closeIconPicker();
    });
    document.getElementById('iconPickerCustomInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnIconPickerApplyCustom').click();
    });
    document.getElementById('iconPickerModal').addEventListener('click', (e) => {
      if (e.target.id === 'iconPickerModal') closeIconPicker();
    });

    try {
      await loadManifest();
    } catch (e) {
      document.getElementById('formRoot').innerHTML =
        '<div class="empty-hint">Не смог загрузить список шаблонов: ' + e.message +
        '<br><br>Если открыт локальный файл (file://) — браузер часто блокирует чтение соседних файлов.' +
        ' Запусти локальный сервер (например <code>python -m http.server</code> в папке проекта) ' +
        'или открой инструмент через захостенную версию (GitHub Pages).</div>';
      return;
    }

    loadFromStorage();
    renderCharacterSelect();

    if (state.activeId && getActiveCharacter()) {
      await switchToCharacter(state.activeId);
    } else if (state.characters.length) {
      await switchToCharacter(state.characters[0].id);
    } else {
      renderEmptyState();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
