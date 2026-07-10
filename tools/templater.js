/*
 * Мини-шаблонизатор (Mustache/Handlebars-лайт), без зависимостей.
 * Полный синтаксис описан в templates/README.md.
 */

(function (global) {
  'use strict';

  function stripComments(src) {
    return src.replace(/<!--[\s\S]*?-->/g, '');
  }

  function parseVarTag(raw) {
    let rest = raw;
    let def = null;
    let placeholder = null;

    const eqIdx = rest.indexOf('=');
    const tildeIdx = rest.indexOf('~');

    if (eqIdx !== -1 && (tildeIdx === -1 || eqIdx < tildeIdx)) {
      def = rest.slice(eqIdx + 1).trim();
      rest = rest.slice(0, eqIdx);
    } else if (tildeIdx !== -1) {
      placeholder = rest.slice(tildeIdx + 1).trim();
      rest = rest.slice(0, tildeIdx);
    }

    let filter = null;
    const pipeIdx = rest.indexOf('|');
    let name = rest;
    if (pipeIdx !== -1) {
      name = rest.slice(0, pipeIdx).trim();
      filter = rest.slice(pipeIdx + 1).trim();
    }
    return { type: 'var', name: name.trim(), filter: filter, default: def, placeholder: placeholder };
  }

  function parseTemplate(srcRaw) {
    const src = stripComments(srcRaw);
    let i = 0;
    function parseNodes(insideSection) {
      const nodes = [];
      while (i < src.length) {
        const tagStart = src.indexOf('{{', i);
        if (tagStart === -1) {
          nodes.push({ type: 'text', value: src.slice(i) });
          i = src.length;
          break;
        }
        if (tagStart > i) nodes.push({ type: 'text', value: src.slice(i, tagStart) });
        const tagEnd = src.indexOf('}}', tagStart);
        if (tagEnd === -1) throw new Error('Незакрытая {{ на позиции ' + tagStart);
        const raw = src.slice(tagStart + 2, tagEnd).trim();
        i = tagEnd + 2;

        if (raw === '@index') { nodes.push({ type: 'index' }); continue; }

        if (raw.charAt(0) === '/') {
          if (insideSection) return nodes;
          continue; // "висячий" закрывающий тег на верхнем уровне — игнорируем
        }
        if (raw.indexOf('#each ') === 0) {
          const name = raw.slice(6).trim();
          const children = parseNodes(true);
          nodes.push({ type: 'section', name: name, isEach: true, children: children });
          continue;
        }
        if (raw.charAt(0) === '#') {
          // {{#поле}} — обычный булев/непустой чек. {{#поле|checkbox=1}} — то же самое,
          // но с типом и дефолтом для формы (нужно для галочек "показать"/"сделать стартовым").
          const varTag = parseVarTag(raw.slice(1));
          const children = parseNodes(true);
          nodes.push({
            type: 'section', name: varTag.name, isEach: false, children: children,
            filter: varTag.filter, default: varTag.default, placeholder: varTag.placeholder,
          });
          continue;
        }
        nodes.push(parseVarTag(raw));
      }
      return nodes;
    }
    return parseNodes(false);
  }

  function collectFields(ast) {
    const fields = [];
    const fieldNames = new Set();
    const groups = {}; // name -> [{name, filter, default, placeholder}, ...]

    function addField(list, seen, node) {
      if (node.name.indexOf('../') === 0) return;
      if (!seen.has(node.name)) {
        seen.add(node.name);
        list.push({ name: node.name, filter: node.filter, default: node.default, placeholder: node.placeholder });
      }
    }

    // {{#поле}} без |фильтра и без =дефолт/~подсказка — просто условная проверка
    // "не пусто" (например {{#текст}} вокруг картинки в посте), где настоящий тип
    // и дефолт задаёт вложенный {{поле}}. Регистрировать такое поле здесь не нужно —
    // пусть его определит вложенный var-тег. А вот {{#поле|checkbox=1}} — самостоятельное
    // булево поле (нет смысла ещё раз писать {{поле}} внутри), его регистрируем сразу.
    function hasMeta(node) {
      return node.filter !== null || node.default !== null || node.placeholder !== null;
    }

    function walkGroup(nodes) {
      const gFields = [];
      const gSeen = new Set();
      (function walk(nodes) {
        for (const node of nodes) {
          if (node.type === 'var') addField(gFields, gSeen, node);
          else if (node.type === 'section') {
            if (!node.isEach && hasMeta(node)) addField(gFields, gSeen, node);
            walk(node.children);
          }
        }
      })(nodes);
      return gFields;
    }

    (function walkTop(nodes) {
      for (const node of nodes) {
        if (node.type === 'var') {
          addField(fields, fieldNames, node);
        } else if (node.type === 'section') {
          if (node.isEach) {
            if (!groups[node.name]) groups[node.name] = walkGroup(node.children);
          } else {
            if (hasMeta(node)) addField(fields, fieldNames, node);
            walkTop(node.children);
          }
        }
      }
    })(ast);

    return { fields: fields, groups: groups };
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resolveVar(name, contextStack) {
    let n = name;
    let level = 0;
    while (n.indexOf('../') === 0) { n = n.slice(3); level++; }
    const ctx = contextStack[level] || {};
    return ctx[n];
  }

  function isTruthy(val) {
    if (Array.isArray(val)) return val.length > 0;
    if (val === undefined || val === null || val === false) return false;
    return String(val).trim() !== '';
  }

  function render(nodes, contextStack) {
    let out = '';
    for (const node of nodes) {
      if (node.type === 'text') { out += node.value; continue; }
      if (node.type === 'index') { out += (contextStack[0] && contextStack[0].__index__) || ''; continue; }
      if (node.type === 'var') {
        const val = resolveVar(node.name, contextStack);
        out += escapeHtml(val === undefined || val === null ? '' : val);
        continue;
      }
      if (node.type === 'section') {
        const val = resolveVar(node.name, contextStack);
        if (node.isEach) {
          const arr = Array.isArray(val) ? val : [];
          arr.forEach((item, idx) => {
            const itemCtx = Object.assign({}, item, { __index__: idx + 1 });
            out += render(node.children, [itemCtx].concat(contextStack));
          });
        } else if (isTruthy(val)) {
          out += render(node.children, contextStack);
        }
        continue;
      }
    }
    return out;
  }

  function renderTemplate(ast, data) {
    return render(ast, [data]);
  }

  global.Templater = {
    parseTemplate: parseTemplate,
    collectFields: collectFields,
    renderTemplate: renderTemplate,
  };
})(window);
