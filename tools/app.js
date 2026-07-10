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

  async function loadManifest() {
    const res = await fetch('../templates/manifest.json');
    if (!res.ok) throw new Error('Не смог загрузить manifest.json (' + res.status + ')');
    state.manifest = await res.json();
  }

  async function loadTemplate(templateId) {
    if (state.templateCache[templateId]) return state.templateCache[templateId];
    const meta = state.manifest.find(t => t.id === templateId);
    if (!meta) throw new Error('Шаблон "' + templateId + '" не найден в manifest.json');
    const res = await fetch('../templates/' + meta.файл);
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

  // Строит <input>/<textarea> под fieldDef (учитывает |textarea, |url, |number, |color,
  // |checkbox, и placeholder из {{поле~подсказка}} — в отличие от {{поле=дефолт}}, значение
  // НЕ подставляется, только показывается серым как подсказка формата).
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
    let input;
    if (fieldDef.filter === 'textarea') {
      input = el('textarea', { class: 'field-textarea' });
    } else if (fieldDef.filter === 'color') {
      input = el('input', { type: 'color', class: 'field-input field-input-color' });
    } else {
      const type = fieldDef.filter === 'url' ? 'url' : (fieldDef.filter === 'number' ? 'number' : 'text');
      input = el('input', { type: type, class: 'field-input' });
    }
    if (fieldDef.placeholder) input.setAttribute('placeholder', fieldDef.placeholder);
    input.value = initialValue || (fieldDef.filter === 'color' ? '#0089a3' : '');
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
      const wrap = el('label', { class: 'field-label' });
      wrap.appendChild(el('span', { class: 'label-text', text: prettifyLabel(fd.name) }));
      const input = buildFieldInput(fd, item[fd.name], (val) => {
        item[fd.name] = val;
        scheduleUpdate();
      });
      wrap.appendChild(input);
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
