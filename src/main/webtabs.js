const fs = require('fs');
const path = require('path');
const { app, ipcMain, session, shell, WebContentsView } = require('electron');
const { webFiles } = require('./webfiles');

// Official web clients, each in its own persistent session so the login survives restarts.
// All of them stay loaded in the background: their chat lists are read every few seconds and
// merged into the one list in the sidebar; opening a chat there shows that service's page.
const SERVICES = {
  tg: 'https://web.telegram.org/k/',
  wa: 'https://web.whatsapp.com/',
  ei: 'https://web.eitaa.com/',
  ba: 'https://web.bale.ai/',
  ru: 'https://web.rubika.ir/',
};
const SECOND = /^(tg|wa|ei|ba|ru)2$/; // optional second account of a service, own login and session
const baseOf = (key) => key.replace(/2$/, '');
const FOCUS = new Set(['ba', 'ru', 'wa']); // services whose own chat list is moved aside when a chat is opened from our list
const REAL_CLICK = new Set(['ru']); // services that ignore clicks made by the page: a real mouse click is sent
const RAIL = 56;      // service rail, px
const SIDEBAR = 340;  // unified chat list, px (same as #sidebar in styles.css)
const POLL_MS = 3000;
const ARCHIVE_MS = 40000; // how often the archived chats of each service are read
const ICON_SERVICES = new Set(['ei', 'ba', 'ru']); // services whose logo is taken from their own page

// Runs inside a web client: turns a blob/data picture address into a small data URL.
const TO_DATA = async function (src) {
  const b = await (await fetch(src)).blob();
  if (!b.size || b.size > 150000) return null;
  return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.onerror = () => r(null); f.readAsDataURL(b); });
}.toString();
const PERMISSIONS = new Set(['notifications', 'media', 'fullscreen', 'clipboard-sanitized-write']);

// Runs inside WhatsApp. Its pop-ups (emoji panel, attach menu, reactions) are placed as if the chat list were
// still beside the chat, so with the list moved aside they can end up partly outside the left edge of the
// window. Such a pop-up is pushed back inside; it is left alone as soon as it fits.
const FIT = function () {
  if (window.__umFit) return;
  window.__umFit = true;
  const boxes = '#expressions-panel-container, #wa-popovers-bucket';
  const run = () => {
    for (const box of document.querySelectorAll(boxes)) {
      for (const el of box.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *')) {
        const prev = Number(el.dataset.umShift || 0);
        const r = el.getBoundingClientRect();
        if (r.width < 150 || r.height < 40) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const natural = r.left - prev;
        const want = natural < 8 ? Math.ceil(8 - natural) : 0;
        if (want === prev) continue;
        if (want) { el.style.setProperty('translate', want + 'px 0'); el.dataset.umShift = String(want); }
        else { el.style.removeProperty('translate'); delete el.dataset.umShift; }
      }
    }
  };
  let timer = null;
  const later = () => { if (!timer) timer = setTimeout(() => { timer = null; run(); }, 40); };
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  window.addEventListener('resize', later);
}.toString();

// Runs inside WhatsApp: opens the attach menu of the open chat and marks the file input that takes the files
// (the one for pictures and videos, or the one for documents).
const ATTACH = async function (media) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const comp = document.querySelector('footer [contenteditable]:not([contenteditable="false"]), footer [role="textbox"]');
  const footer = comp && comp.closest('footer');
  if (!footer) return false;
  const inputs = () => [...document.querySelectorAll('input[type="file"]')];
  if (!inputs().length) {
    const btns = [...footer.querySelectorAll('button')];
    const btn = btns.find((b) => /attach|پیوست/i.test(b.getAttribute('aria-label') || '')) || btns[0];
    if (!btn) return false;
    btn.click();
    for (let i = 0; i < 15 && !inputs().length; i++) await sleep(100);
  }
  const isMedia = (i) => /image|video/i.test(i.accept || '');
  const all = inputs().filter((i) => !/webp/i.test(i.accept || '') || isMedia(i));
  const pick = media ? all.find(isMedia) : (all.find((i) => (i.accept || '*') === '*') || all.find((i) => !isMedia(i)));
  if (!pick) return false;
  for (const i of inputs()) i.removeAttribute('data-um-file');
  pick.setAttribute('data-um-file', '1');
  return true;
}.toString();

const OUTLINE = function () {
  const mask = (t) => String(t || '').replace(/\p{L}/gu, 'a');
  const out = [`url: ${location.origin}${location.pathname}`, `viewport: ${innerWidth}x${innerHeight}`];
  let count = 0;
  const walk = (el, depth) => {
    if (count++ > 6000 || depth > 30) return;
    const tag = el.tagName.toLowerCase();
    let line = '  '.repeat(depth) + tag;
    if (el.id) line += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (cls.length) line += '.' + cls.join('.');
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'id' || a.name === 'style') continue;
      if (/^(role|type|contenteditable|dir|tabindex|placeholder|aria-.*|data-.*)$/.test(a.name)) line += ` [${a.name}=${mask(a.value).slice(0, 40)}]`;
    }
    const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 40);
    if (text) line += ` "${mask(text)}"`;
    out.push(line);
    if (tag === 'svg') return;
    const seen = new Map();
    for (const k of el.children) {
      if (/^(script|style|noscript|path)$/i.test(k.tagName)) continue;
      const sig = k.tagName.toLowerCase() + '.' + (k.getAttribute('class') || '');
      const n = (seen.get(sig) || 0) + 1;
      seen.set(sig, n);
      if (n <= 3) walk(k, depth + 1);
    }
    for (const [sig, n] of seen) if (n > 3) out.push('  '.repeat(depth + 1) + `... +${n - 3} similar: ${sig}`);
  };
  walk(document.body, 0);
  return out.join('\n');
}.toString();

// Runs inside each web client. op "list": reads the chat list; op "open": clicks the chat with the given title;
// op "focus" / "unfocus": move the page's own chat list (and icon rail) out of view / back.
const LIB = function (op, arg) {
  const FA = '۰۱۲۳۴۵۶۷۸۹', AR = '٠١٢٣٤٥٦٧٨٩';
  const norm = (s) => String(s || '').replace(/[۰-۹]/g, (d) => FA.indexOf(d)).replace(/[٠-٩]/g, (d) => AR.indexOf(d)).replace(/\s+/g, ' ').trim();
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  const TIME = new RegExp('^(\\d{1,2}:\\d{2}(\\s?[ap]m)?|\\d{1,4}[\\/.\\-]\\d{1,2}([\\/.\\-]\\d{1,4})?|' + MON + '\\s\\d{1,2}(,?\\s\\d{2,4})?|\\d{1,2}\\s' + MON + '(\\s\\d{2,4})?|yesterday|today|mon|tue|wed|thu|fri|sat|sun|دیروز|امروز|شنبه|یکشنبه|دوشنبه|سه‌?شنبه|چهارشنبه|پنج‌?شنبه|جمعه)$', 'i');
  // the "Archived" entry of a chat list (not a chat: it is never listed with the chats)
  const ARCH_RE = /^(archived( chats)?|archive|آرشیو( شده)?|بایگانی( شده)?)(\s?\d{1,4})?$/i;
  // The title of an opened archive ("Archived"), on the left side of the page.
  const arcHeading = () => [...document.querySelectorAll('h1, h2, [role="heading"]')].find((e) => ARCH_RE.test(norm(e.textContent)) && e.getClientRects().length > 0 && e.getBoundingClientRect().left < innerWidth * 0.5) || null;
  // WhatsApp opens the archive as a panel over the chat list: the panel is the nearest block around the title that holds chats.
  function archiveDrawer() {
    let el = arcHeading();
    while (el && !el.querySelector('[role="listitem"]')) el = el.parentElement;
    return el;
  }
  // A Telegram-style list shows its archive as a row of its own ("Archived Chats"): not a chat, but the entry of the archive.
  const isArchRow = (el) => { const t = el.querySelector && el.querySelector('.peer-title'); return !!t && ARCH_RE.test(norm(t.textContent)); };
  const EDIT = '[contenteditable]:not([contenteditable="false"]), textarea, [role="textbox"]';

  // Telegram-style clients (Telegram, Eitaa, Rubika) have .peer-title rows; for every other client the
  // chat list is the column whose children are many similar rows.
  function rows() {
    // Telegram Web K shows the archive as its own tab (#chats-archived-container) on top of the main list:
    // rows inside it are archived chats, rows outside it are the normal ones.
    const ARC = document.querySelector('#chats-archived-container');
    const wantArc = !!(arg && arg.archived);
    if (/whatsapp/i.test(location.hostname)) {
      const drawer = archiveDrawer();
      const vis = (el) => el.getClientRects().length > 0;
      if (arg && arg.archived) return drawer ? [...drawer.querySelectorAll('[role="listitem"]')].filter(vis) : [];
      return [...document.querySelectorAll('[role="grid"] [role="row"]')].filter((el) => vis(el) && !(drawer && drawer.contains(el)));
    }
    const known = [...document.querySelectorAll('.chatlist-chat, #chatlist-container ul.chatlist > li, #folders-container ul.chatlist > li')]
      .filter((el) => el.querySelector('.peer-title') && !el.closest('rb-chat-archive, rb-chat-ads-container, #search-container, .search-group'))
      .filter((el) => !isArchRow(el))
      .filter((el) => el.getClientRects().length > 0) // lists of folders that are not open are in the page too (display: none)
      .filter((el) => !ARC || ARC.contains(el) === wantArc);
    if (wantArc && !ARC && document.querySelector('archive-dialog')) return []; // archive not opened yet
    if (known.length || ARC) return known;
    let best = null;
    for (const p of document.querySelectorAll('div, ul, section')) {
      const kids = p.children;
      if (kids.length < 4 || kids.length > 400) continue;
      const r = p.getBoundingClientRect();
      if (r.width < 150 || r.width > innerWidth * 0.95 || r.height < 200) continue;
      const tag = kids[0].tagName;
      let same = 0, text = 0;
      for (const k of kids) { if (k.tagName === tag) same++; if (norm(k.innerText)) text++; }
      if (same < kids.length * 0.8 || text < kids.length * 0.8) continue;
      const kh = kids[0].getBoundingClientRect().height;
      if (kh < 40 || kh > 150) continue;
      if (!best || kids.length > best.children.length) best = p;
    }
    return best ? [...best.children].filter((el) => !ARCH_RE.test(norm(el.innerText || el.textContent))) : [];
  }

  // The picture of the chat: the address of the avatar image inside the row (the main process turns it into a small data URL).
  const avatarOf = (row) => {
    const bad = '.peer-title, .user-last-message, .message-time';
    const imgs = [...row.querySelectorAll('img')].filter((i) => !i.closest(bad) && (i.currentSrc || i.src) && !/emoji|sticker|reaction/i.test(i.className));
    const best = imgs.find((i) => i.closest('[class*="avatar" i], avatar-element')) || imgs.find((i) => (i.clientWidth || i.width) >= 30);
    return best ? (best.currentSrc || best.src) : '';
  };

  function parse(row) {
    if (row.querySelector('.peer-title')) {
      const q = (s) => norm((row.querySelector(s) || {}).textContent);
      const title = q('.peer-title');
      return title ? { title, last: q('.user-last-message'), time: q('.message-time'), unread: parseInt(q('.dialog-subtitle-badge')) || 0, avatar: avatarOf(row) } : null;
    }
    const texts = [];
    const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { const t = norm(n.textContent); if (t) texts.push(t); }
    const ti = texts.findIndex((t) => !TIME.test(t) && !/^\d{1,3}\+?$/.test(t));
    if (ti < 0) return null;
    const title = texts.splice(ti, 1)[0];
    let time = '', unread = 0;
    const i = texts.findIndex((t) => TIME.test(t));
    if (i >= 0) time = texts.splice(i, 1)[0];
    if (texts.length > 1 && /^\d{1,3}\+?$/.test(texts[texts.length - 1])) unread = parseInt(texts.pop());
    return { title, last: texts.sort((a, b) => b.length - a.length)[0] || '', time, unread, avatar: avatarOf(row) };
  }

  // Where the click starts. The page's own click handler often sits on an inner element of the row, so an
  // event fired on the row itself never reaches it: the click starts at an inner element and travels up.
  // Telegram-style rows use the text block (a click on the .peer-title opens the profile in Rubika, a
  // click on the row does nothing); the other clients use the innermost element holding the title.
  function clickTarget(row, title) {
    if (row.querySelector('.peer-title')) return row.querySelector('.user-caption') || row;
    const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (norm(n.textContent) === title && n.parentElement) return n.parentElement;
    return row;
  }

  // The message box of the open chat: an input that lies beside the chat list, not above or below it
  // (the search box of the list is an input too and must not count).
  function composer(list) {
    const lr = list.getBoundingClientRect();
    return [...document.querySelectorAll(EDIT)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.right <= lr.left + 1 || r.left >= lr.right - 1);
    }) || null;
  }

  // Bale, Rubika and WhatsApp show their own chat list next to the open chat, which would double our list.
  // "focus" moves that column (and the narrow icon rail beside it) out of view; it stays rendered, so the
  // list can still be read. "unfocus" puts everything back for when the service is opened with its button.
  const restore = (el, attr) => {
    const old = el.dataset[attr];
    if (old) el.setAttribute('style', old); else el.removeAttribute('style');
    delete el.dataset[attr];
  };
  // Undo what "reveal" did (the page's list was forced on screen for a click).
  const restoreRev = () => { for (const el of document.querySelectorAll('[data-um-rev]')) restore(el, 'umRev'); };
  const restoreAll = () => {
    restoreRev();
    for (const el of document.querySelectorAll('[data-um-hide]')) restore(el, 'umHide');
    const col = document.querySelector('[data-um-col]');
    if (col) { restore(col, 'umStyle'); delete col.dataset.umCol; }
    const grid = document.querySelector('[data-um-grid]');
    if (grid) restore(grid, 'umGrid');
  };

  if (op === 'focus') {
    const cur = document.querySelector('[data-um-col]');
    if (cur && cur.isConnected) return true;
    restoreRev();
    const list = (rows()[0] || {}).parentElement;
    if (!list) return false;
    const comp = composer(list);
    if (!comp) return false; // no chat is open yet, nothing to make room for
    const lw = list.getBoundingClientRect().width;
    let col = list;
    while (col.parentElement && col.parentElement !== document.body && col.parentElement !== document.documentElement) {
      const par = col.parentElement;
      if (par.contains(comp)) break;
      if (par.getBoundingClientRect().width > lw * 1.6) break;
      col = par;
    }
    if (col.contains(comp)) return false;
    const box = col.getBoundingClientRect();
    const par = col.parentElement;
    // Everything else beside the column goes too: the icon rail and the thin absolutely placed divider
    // elements some clients draw between the list and the chat (WhatsApp shows them as white lines).
    for (const sib of par.children) {
      if (sib === col || sib.contains(comp) || sib.querySelector(EDIT)) continue;
      const r = sib.getBoundingClientRect();
      const pos = getComputedStyle(sib).position;
      if (r.width <= 140 || pos === 'absolute' || pos === 'fixed') {
        sib.dataset.umHide = sib.getAttribute('style') || '';
        sib.style.setProperty('display', 'none', 'important');
      }
    }
    col.dataset.umCol = '1';
    col.dataset.umStyle = col.getAttribute('style') || '';
    col.style.cssText += `;position:fixed !important;left:-${Math.ceil(box.width) + 50}px !important;top:0 !important;width:${box.width}px !important;height:${innerHeight}px !important;`;
    if (par && getComputedStyle(par).display.includes('grid')) {
      par.dataset.umGrid = par.getAttribute('style') || '';
      par.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');
    }
    return true;
  }
  if (op === 'unfocus') { restoreAll(); return true; }

  // "reveal": the page may hide its own list while a chat is open (narrow window, its own responsive layout),
  // so a real click could land on the open chat instead of the row. The list and every wrapper around it are
  // forced into view, pinned over the page and almost transparent, just for the click.
  if (op === 'reveal') {
    restoreAll();
    const list = (rows()[0] || {}).parentElement;
    if (!list) return false;
    const comp = composer(list);
    if (!comp) return true; // no chat open: the list is where the page put it
    const chain = [];
    for (let el = list; el && el !== document.body && el !== document.documentElement && !el.contains(comp); el = el.parentElement) chain.push(el);
    for (const el of chain) {
      el.dataset.umRev = el.getAttribute('style') || '';
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('translate', 'none', 'important');
      el.style.setProperty('pointer-events', 'auto', 'important');
      if (getComputedStyle(el).display === 'none') el.style.setProperty('display', 'flex', 'important');
    }
    const col = chain[chain.length - 1];
    if (col) {
      col.style.setProperty('position', 'fixed', 'important');
      col.style.setProperty('left', '0', 'important');
      col.style.setProperty('top', '0', 'important');
      col.style.setProperty('width', Math.min(innerWidth, 420) + 'px', 'important');
      col.style.setProperty('height', innerHeight + 'px', 'important');
      col.style.setProperty('z-index', '2147483000', 'important');
      col.style.setProperty('opacity', '0.01', 'important');
    }
    return true;
  }

  if (op === 'sig') { // what the page's top area (outside the list) says now: changes when another chat opens
    const list = (rows()[0] || {}).parentElement;
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n, c = 0; (n = w.nextNode()) && c < 3000; c++) {
      const t = norm(n.textContent);
      const el = n.parentElement;
      if (!t || !el || (list && list.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.top < 90 && r.bottom > 0) out.push(t);
    }
    return out.join('|');
  }
  if (op === 'chatopen') {
    const list = (rows()[0] || {}).parentElement;
    return !!(list && composer(list));
  }

  // ----- archive: the archived chats are not part of the page's normal list, they sit behind an "Archived" entry -----
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const init = { ...base, buttons: t.endsWith('down') ? 1 : 0 };
      el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(t, init));
    }
  };
  function archiveEntryEl() {
    const k = document.querySelector('archive-dialog');
    if (k) return k;
    const row = [...document.querySelectorAll('.chatlist-chat, ul.chatlist > li')].find((el) => isArchRow(el) && !el.closest('#chats-archived-container') && el.getClientRects().length > 0);
    if (row) return row;
    for (const el of document.querySelectorAll('[role="button"], button, [role="listitem"], li, a, div')) {
      if (el.children.length > 6 || el.closest('[contenteditable], #chats-archived-container')) continue;
      const t = norm(el.innerText || el.textContent);
      if (!t || t.length > 40 || !ARCH_RE.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 24 || r.height > 120 || r.left > innerWidth * 0.5 || r.top > innerHeight * 0.7) continue;
      return el;
    }
    return null;
  }
  function insideArchive() {
    if (document.querySelector('#chats-archived-container')) return true;
    if (arcHeading()) return true; // WhatsApp: the archive panel is open although the "Archived" button of the list below is still in the page
    if (document.querySelector('archive-dialog') || archiveEntryEl()) return false;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n, c = 0; (n = w.nextNode()) && c < 4000; c++) {
      const t = norm(n.textContent);
      if (!t || !ARCH_RE.test(t) || !n.parentElement) continue;
      const r = n.parentElement.getBoundingClientRect();
      if (r.width > 0 && r.top >= 0 && r.top < 110 && r.left < innerWidth * 0.5) return true;
    }
    return false;
  }
  function backEl() {
    return [...document.querySelectorAll('[aria-label], [data-icon], [data-testid]')].find((e) => {
      const r = e.getBoundingClientRect();
      const s = (e.getAttribute('aria-label') || '') + ' ' + (e.dataset.icon || '') + ' ' + (e.dataset.testid || '');
      return r.width > 0 && r.top < 110 && r.left < innerWidth * 0.5 && /back|بازگشت|برگشت/i.test(s);
    });
  }
  if (op === 'archiveBack') { // where a real mouse click has to land to leave the archive
    const b = backEl();
    if (!b) return null;
    const q = (b.closest('button, [role="button"]') || b).getBoundingClientRect();
    return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
  }
  if (op === 'archiveEntry') return !!archiveEntryEl();
  if (op === 'archiveInside') return insideArchive();
  if (op === 'archiveClick') { const el = archiveEntryEl(); if (!el) return false; press(el); return true; }
  if (op === 'archiveClose') {
    const btn = document.querySelector('#chats-archived-container .sidebar-close-button');
    if (btn) { press(btn); return true; }
    const back = backEl();
    if (back) { press(back.closest('button, [role="button"]') || back); return true; }
    for (const t of ['keydown', 'keyup']) (document.activeElement || document.body).dispatchEvent(new KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    return false;
  }

  const seen = new Set();
  const items = rows().map((el) => ({ el, chat: parse(el) })).filter((x) => x.chat).filter((x) => {
    const k = x.chat.title + '|' + x.chat.time + '|' + x.chat.last;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 80);
  if (op === 'list') return items.map((x) => x.chat);
  const hits = items.filter((x) => x.chat.title === arg.title);
  const target = hits[arg.n] || hits[0];
  if (!target) return false;
  const el = clickTarget(target.el, target.chat.title);
  if (op === 'opened') { // is this chat the one the page shows now?
    const row = target.el;
    if (/(^|\s)(is-)?(active|selected|current)(\s|$)/i.test(row.getAttribute('class') || '') || row.getAttribute('aria-selected') === 'true') return true;
    return [...document.querySelectorAll('.peer-title')].some((e) => !row.parentElement.contains(e) && e.getClientRects().length && norm(e.textContent) === arg.title);
  }
  if (op === 'rect') { // where a real mouse click has to land
    el.scrollIntoView({ block: 'nearest' });
    const q = el.getBoundingClientRect();
    if (!(q.width > 0 && q.height > 0)) return null;
    const x = Math.round(q.left + q.width / 2), y = Math.round(q.top + q.height / 2);
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!(top && target.el.contains(top)) };
  }
  const r = el.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const down = t.endsWith('down');
    const init = { ...base, buttons: down ? 1 : 0 };
    el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(t, init));
  }
  return true;
}.toString();

class WebTabs {
  constructor(win, onChats, onAccounts, onNotice, onIcon) {
    this.win = win;
    this.files = webFiles(onNotice || (() => {}));
    this.onChats = onChats;
    this.onAccounts = onAccounts;
    this.onIcon = onIcon || (() => {});
    this.accountsFile = path.join(app.getPath('userData'), 'accounts.json');
    this.views = new Map();
    this.last = new Map();
    this.currentKey = null;
    this.focused = new Set(); // services opened from our list: their own list stays out of view
    this.busy = new Map();    // services with a chat being opened right now: the poll leaves their layout alone
    this.timer = null;
    this.hadChats = new Set(); // services whose chat list has been read at least once this session
    this.polling = false;
    this.fails = new Map();        // consecutive failed reads per service
    this.empty = new Map();        // consecutive empty reads per service (after chats had been seen)
    this.loadingSince = new Map(); // since when a page has been "loading"
    this.reloaded = new Map();     // last automatic reload per service
    this.archived = new Map();     // key -> archived chats read last
    this.arcMiss = new Map();
    this.noArchive = new Set();    // services whose archive could not be left again: it is not read any more
    this.nextArchive = new Map();
    this.archiveBusy = new Set();  // services whose archive is open right now (for a scan)
    this.avatarCache = new Map();  // key|address -> data URL ('' when it could not be read)
    this.sentAvatar = new Map();   // key|title -> address of the picture last sent to the window
    this.icons = new Map();        // logo (data URL) of Eitaa, Bale, Rubika
    // Files dropped on a WhatsApp page (see webpreload.js).
    ipcMain.on('um:wa-drop', (e, paths) => {
      const own = [...this.views].some(([k, v]) => baseOf(k) === 'wa' && !v.webContents.isDestroyed() && v.webContents.id === e.sender.id);
      const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && fs.existsSync(p) && fs.statSync(p).isFile()).slice(0, 30) : [];
      if (own && list.length) this.sendFiles(e.sender, list).catch((err) => this.files.notify(`WhatsApp: the files could not be attached (${err.message})`));
    });
    win.on('resize', () => this.layout());
    win.on('maximize', () => this.layout());
    win.on('unmaximize', () => this.layout());
    win.on('closed', () => {
      clearInterval(this.timer);
      for (const v of this.views.values()) v.webContents.close();
      this.views.clear();
    });
  }

  start() {
    let extra = [];
    try { extra = JSON.parse(fs.readFileSync(this.accountsFile, 'utf8')).filter((k) => SECOND.test(k)); } catch { /* none enabled yet */ }
    for (const key of [...Object.keys(SERVICES), ...extra]) this.create(key);
    this.layout();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    setTimeout(() => this.warmUp(), 12000);
  }

  // Fallback for pages that still do not fill their chat list while parked: every service that has not shown a
  // chat yet is brought on screen for a moment, one after the other (what opening each one by hand did), then put away.
  async warmUp() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const key of [...this.views.keys()]) {
      if (this.win.isDestroyed() || this.hadChats.has(key)) continue;
      if (this.currentKey) return; // the user opened a service: leave the layout alone
      const view = this.views.get(key);
      if (!view || view.webContents.isDestroyed()) continue;
      this.show(key, false);
      for (let i = 0; i < 8 && !this.hadChats.has(key); i++) { await sleep(500); await this.poll(); }
      if (this.currentKey === key) this.hide();
    }
  }

  create(key) {
    const ses = session.fromPartition('persist:' + key);
    // Some web clients refuse a user agent that says "Electron".
    const appToken = app.getName().replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ses.setUserAgent(ses.getUserAgent().replace(new RegExp(`\\s(Electron|${appToken})/\\S+`, 'gi'), ''));
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(PERMISSIONS.has(permission)));

    const view = new WebContentsView({ webPreferences: { session: ses, preload: path.join(__dirname, 'webpreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    view.webContents.loadURL(SERVICES[baseOf(key)]).catch(() => {});
    // The chat list of a page that finished loading is read soon, not after the next 3 s tick.
    view.webContents.on('did-finish-load', () => {
      setTimeout(() => this.poll(), 1500); setTimeout(() => this.poll(), 5000);
      setTimeout(() => this.grabIcon(key).catch(() => {}), 3000);
    });
    view.webContents.on('page-favicon-updated', (_e, icons) => {
      const url = (icons || []).filter((u) => /^https?:/i.test(u)).pop();
      if (url) this.grabIcon(key, url).catch(() => {});
    });
    // A page that crashed, hangs or lost its connection is reloaded instead of staying dead until the app is restarted.
    view.webContents.on('render-process-gone', () => setTimeout(() => this.reload(key, 'crashed', true), 2000));
    view.webContents.on('unresponsive', () => setTimeout(() => { if (!view.webContents.isDestroyed()) this.reload(key, 'unresponsive'); }, 20000));
    view.webContents.on('did-fail-load', (_e, code, _d, _u, isMainFrame) => {
      if (isMainFrame && code !== -3) setTimeout(() => this.reload(key, 'load failed', true), 15000);
    });
    if (baseOf(key) === 'wa') view.webContents.on('did-finish-load', () => view.webContents.executeJavaScript(`(${FIT})()`).catch(() => {}));
    this.files.attach(key, view.webContents, ses);
    this.win.contentView.addChildView(view);
    // A hidden view (setVisible(false)) makes the page report document.hidden: the web clients then do not render
    // or fill their chat list until the view has been shown once, so chats of services that were never opened were
    // missing. The view stays visible and is parked off-screen instead (see park/layout).
    view.setVisible(true);
    this.views.set(key, view);
    this.park(view);
    return view;
  }

  // Runs one LIB operation in the page; gives up after `ms` so that one stuck page cannot block the others.
  js(wc, op, arg, ms = 6000) {
    let timer;
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); });
    return Promise.race([wc.executeJavaScript(`(${LIB})(${JSON.stringify(op)}, ${JSON.stringify(arg || null)})`), limit]).finally(() => clearTimeout(timer));
  }

  reload(key, why, force = false) {
    const view = this.views.get(key);
    if (!view || view.webContents.isDestroyed()) return;
    const last = this.reloaded.get(key) || 0;
    if (!force && Date.now() - last < 60000) return;
    this.reloaded.set(key, Date.now());
    this.fails.set(key, 0); this.empty.set(key, 0);
    this.archiveBusy.delete(key);
    view.webContents.reload();
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.views].map(([key, view]) => this.pollOne(key, view).catch(() => {})));
    } finally { this.polling = false; }
  }

  async pollOne(key, view) {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    if (wc.isLoading()) {
      const since = this.loadingSince.get(key) || Date.now();
      this.loadingSince.set(key, since);
      if (Date.now() - since > 90000) { this.loadingSince.delete(key); this.reload(key, 'stuck loading', true); }
      return;
    }
    this.loadingSince.delete(key);
    if (this.archiveBusy.has(key)) return;
    // The page may re-render and drop the moved column: keep it out of the way while a chat is open.
    if (this.focused.has(key) && !this.busy.get(key)) await this.js(wc, 'focus').catch(() => {});

    let chats;
    try { chats = (await this.js(wc, 'list')) || []; this.fails.set(key, 0); } catch {
      const n = (this.fails.get(key) || 0) + 1;
      this.fails.set(key, n);
      if (n >= 4) this.reload(key, 'no answer');
      return;
    }
    const before = this.last.get(key);
    if (chats.length) { this.hadChats.add(key); this.empty.set(key, 0); }
    else if (before && before !== '[]') {
      // The page is redrawing, or lost its connection: keep showing the last list for a while, and reload it if it stays empty.
      const n = (this.empty.get(key) || 0) + 1;
      this.empty.set(key, n);
      if (n === 60) this.reload(key, 'empty for 3 minutes');
      if (n < 5) return;
    }

    // Archived chats: read now and then, never while the service is on screen or a chat is being opened.
    if (this.hadChats.has(key) && !this.noArchive.has(key) && key !== this.currentKey && !this.busy.get(key) && Date.now() >= (this.nextArchive.get(key) || 0)) {
      this.nextArchive.set(key, Date.now() + ARCHIVE_MS);
      await this.scanArchive(key, wc).catch(() => {});
    }

    const merged = chats.concat(this.archived.get(key) || []);
    const json = JSON.stringify(merged);
    if (json === before) return;
    this.last.set(key, json);
    await this.pictures(key, wc, merged);
    this.onChats(key, merged.map((c) => {
      const { avatar, ...rest } = c;
      const data = avatar ? this.avatarCache.get(key + '|' + avatar) : '';
      const id = key + '|' + c.title;
      if (data && this.sentAvatar.get(id) !== avatar) { this.sentAvatar.set(id, avatar); return { ...rest, avatar: data }; }
      return rest;
    }));
  }

  // The archived chats of a service: the archive is opened, read and closed again (the page is parked, nobody sees it).
  async scanArchive(key, wc) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!(await this.js(wc, 'archiveEntry'))) {
      const miss = (this.arcMiss.get(key) || 0) + 1;
      this.arcMiss.set(key, miss);
      if (miss >= 3) this.archived.set(key, []); // no archive entry in the list: nothing is archived
      return;
    }
    this.arcMiss.set(key, 0);
    this.archiveBusy.add(key);
    let rows = null;
    try {
      await this.js(wc, 'archiveClick');
      for (let i = 0; i < 10 && !rows; i++) {
        await sleep(400);
        if (this.currentKey === key || wc.isDestroyed()) break;
        if (!(await this.js(wc, 'archiveInside').catch(() => false))) continue;
        await sleep(600);
        const r = await this.js(wc, 'list', { archived: true }).catch(() => null);
        if (r && r.length) rows = r;
      }
    } finally {
      await this.leaveArchive(key, wc);
    }
    if (rows) this.archived.set(key, rows.map((c) => ({ ...c, archived: true })));
  }

  async leaveArchive(key, wc) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let i = 0; i < 4; i++) {
        if (wc.isDestroyed() || !(await this.js(wc, 'archiveInside').catch(() => false))) break;
        await this.js(wc, 'archiveClose').catch(() => {});
        await sleep(600);
      }
      // WhatsApp ignores the click made by the page: its back arrow is pressed with a real mouse click
      for (let i = 0; i < 2 && !wc.isDestroyed() && (await this.js(wc, 'archiveInside').catch(() => false)); i++) {
        const pt = await this.js(wc, 'archiveBack').catch(() => null);
        if (pt) {
          wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
          wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        }
        await sleep(600);
      }
      // Still inside the archive: the page is loaded again (it opens on its normal list) and its archive is not read any more.
      if (!wc.isDestroyed() && (await this.js(wc, 'archiveInside').catch(() => false))) {
        this.noArchive.add(key);
        this.archived.set(key, []);
        this.reload(key, 'stuck in the archive', true);
      }
    } finally { this.archiveBusy.delete(key); }
  }

  // Profile pictures: blob/data addresses are read inside the page, normal addresses with the page's own session.
  async pictures(key, wc, chats) {
    let budget = 15;
    for (const src of new Set(chats.map((c) => c.avatar).filter(Boolean))) {
      const id = key + '|' + src;
      if (this.avatarCache.has(id) || budget <= 0) continue;
      budget--;
      let data = '';
      try {
        if (/^(blob|data):/i.test(src)) data = (await Promise.race([wc.executeJavaScript(`(${TO_DATA})(${JSON.stringify(src)})`), new Promise((r) => setTimeout(() => r(''), 4000))])) || '';
        else if (/^https?:/i.test(src)) data = await this.fetchData(wc.session, src, 150000);
      } catch { data = ''; }
      this.avatarCache.set(id, data);
      if (this.avatarCache.size > 800) for (const k of [...this.avatarCache.keys()].slice(0, 200)) this.avatarCache.delete(k);
    }
  }

  async fetchData(ses, url, max) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await ses.fetch(url, { signal: ctl.signal });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok || !/^image\//i.test(type)) return '';
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length && buf.length <= max ? `data:${type};base64,${buf.toString('base64')}` : '';
    } catch { return ''; } finally { clearTimeout(timer); }
  }

  // Logo of Eitaa, Bale and Rubika: the icon of the service's own page.
  async grabIcon(key, known) {
    const base = baseOf(key);
    const view = this.views.get(key);
    if (!ICON_SERVICES.has(base) || this.icons.has(base) || !view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    const urls = known ? [known] : [];
    if (!known) {
      let links = [];
      try { links = await wc.executeJavaScript(`[...document.querySelectorAll('link[rel*="icon" i]')].map((l) => ({ href: l.href, sizes: l.getAttribute('sizes') || '', rel: l.rel }))`); } catch { /* page not ready */ }
      const score = (c) => (/apple/i.test(c.rel) ? 1000 : 0) + (parseInt(c.sizes) || 0) + (/\.svg/i.test(c.href) ? 500 : 0);
      for (const c of links.filter((l) => /^https?:/i.test(l.href)).sort((a, b) => score(b) - score(a))) urls.push(c.href);
      try { urls.push(new URL('/favicon.ico', wc.getURL()).href); } catch { /* no url yet */ }
    }
    for (const url of urls.slice(0, 5)) {
      const data = await this.fetchData(wc.session, url, 200000);
      if (data) { this.icons.set(base, data); this.onIcon(base, data); return; }
    }
  }

  extra() { return [...this.views.keys()].filter((k) => SECOND.test(k)); }

  enable(key) {
    if (!SECOND.test(key) || this.views.has(key)) return this.extra();
    this.create(key);
    this.layout();
    return this.saveExtra();
  }

  disable(key) {
    const view = this.views.get(key);
    if (!SECOND.test(key) || !view) return this.extra();
    if (this.currentKey === key) this.hide();
    this.files.detach(view.webContents.id);
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(key);
    this.last.delete(key);
    this.focused.delete(key);
    this.onChats(key, []);
    return this.saveExtra();
  }

  saveExtra() {
    const list = this.extra();
    fs.writeFileSync(this.accountsFile, JSON.stringify(list));
    this.onAccounts(list);
    return list;
  }

  async open(key, title, n, archived) {
    this.busy.set(key, (this.busy.get(key) || 0) + 1);
    try { await this.openInner(key, title, n, archived); } finally {
      this.busy.set(key, this.busy.get(key) - 1);
      // an archived chat that could not be opened must not leave the archive open (and the poll blocked)
      const view = this.views.get(key);
      if (archived && view && !view.webContents.isDestroyed() && this.archiveBusy.has(key)) await this.leaveArchive(key, view.webContents);
    }
  }

  async openInner(key, title, n, archived) {
    // a scan of the archive in progress has to finish first (it is quick)
    for (let i = 0; i < 40 && this.archiveBusy.has(key); i++) await new Promise((r) => setTimeout(r, 200));
    this.show(key, false);
    const view = this.views.get(key);
    const wc = view.webContents;
    const call = (op, arg) => wc.executeJavaScript(`(${LIB})(${JSON.stringify(op)}, ${JSON.stringify(arg || null)})`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const arg = { title, n: n || 0, archived: !!archived };
    if (archived) { // the chat is in the archive: open the archive first, the chat is clicked there, the archive is left afterwards
      this.archiveBusy.add(key);
      await call('archiveClick').catch(() => {});
      for (let i = 0; i < 12; i++) { await sleep(300); if (await call('archiveInside').catch(() => false)) break; }
      await sleep(500);
    }
    const click = async () => {
      const pt = await call('rect', arg).catch(() => null);
      if (!pt) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      return true;
    };

    if (REAL_CLICK.has(baseOf(key))) {
      // These clients only react to a real mouse click, and the row has to be under the pointer: the page's list
      // is forced into view for a moment, the row is clicked, and the click is checked (the page's header must show
      // the chat). If the chat did not change the click is repeated; the second retry first presses Escape to close
      // the open chat, which also brings the list back in the page's narrow layout.
      let opened = false;
      const sig0 = await call('sig').catch(() => '');
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        if (attempt === 2) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          await sleep(200);
        }
        await call('reveal').catch(() => {});
        let pt = null;
        for (let i = 0; i < 10; i++) { // the layout needs a moment after the list is forced into view
          if (i) await sleep(50);
          pt = await call('rect', arg).catch(() => null);
          if (pt && pt.hit) break;
        }
        if (!pt) throw new Error('Chat not found in the web page, open it from the service button');
        wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
        wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        // Done as soon as the page's top area changed (another chat) or the page marks this chat as open.
        for (let i = 0; i < 14 && !opened; i++) {
          await sleep(60);
          opened = (await call('sig').catch(() => sig0)) !== sig0 || !!(await call('opened', arg).catch(() => true));
        }
      }
    } else {
      const ok = await call('open', arg);
      if (!ok) throw new Error('Chat not found in the web page, open it from the service button');
    }

    if (archived) {
      await sleep(400);
      await this.leaveArchive(key, wc);
    }

    if (FOCUS.has(baseOf(key))) {
      this.focused.add(key);
      if (!REAL_CLICK.has(baseOf(key))) {
        await sleep(700);
        // Some clients ignore the click made from the page; then a real mouse click is sent to the row.
        const isOpen = await call('chatopen').catch(() => true);
        if (!isOpen) await click();
      }
      // The chat takes a moment to appear; the list can only be moved aside once its message box exists.
      for (let i = 0; i < 24; i++) {
        if (wc.isDestroyed()) return;
        if (await call('focus').catch(() => false)) break;
        await sleep(120);
      }
    }
  }

  // restore: opened with its own button, so the service's full page (with its own list) is shown
  show(key, restore = true) {
    if (!this.views.has(key)) return;
    this.hide();
    this.currentKey = key;
    const view = this.views.get(key);
    if (restore && FOCUS.has(baseOf(key))) {
      this.focused.delete(key);
      view.webContents.executeJavaScript(`(${LIB})('unfocus')`).catch(() => {});
    }
    view.setVisible(true);
    view.setBounds(this.onScreen());
    this.win.contentView.addChildView(view); // moves it on top
    view.webContents.focus();
  }

  hide() {
    const v = this.views.get(this.currentKey);
    if (v) this.park(v);
    this.currentKey = null;
  }

  // Same size as when shown (the page lays out its list normally), pushed to the right so that only a 1 px strip
  // stays inside the window: a view lying completely outside is not rendered, one with a visible strip is.
  park(view) {
    view.setVisible(true);
    const [w] = this.win.getContentSize();
    view.setBounds({ ...this.onScreen(), x: w - 1 });
  }

  onScreen() {
    const [w, h] = this.win.getContentSize();
    return { x: RAIL + SIDEBAR, y: 0, width: Math.max(0, w - RAIL - SIDEBAR), height: h };
  }

  // Attaches files to the open WhatsApp chat: the attach menu is opened in the page and the files are put into its
  // file input, as if they had been picked in the file dialog.
  async sendFiles(wc, paths) {
    const media = paths.every((p) => /\.(jpe?g|png|gif|webp|bmp|heic|mp4|mov|m4v|webm|3gp)$/i.test(p));
    if (!(await wc.executeJavaScript(`(${ATTACH})(${media})`))) throw new Error('open a chat first');
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 0 });
    const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[data-um-file]' });
    if (!nodeId) throw new Error('no file input');
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: paths });
  }

  // Opens the service with its full page and tries to open its own menu (where its settings are).
  async settings(key) {
    const view = this.views.get(key);
    if (!view) return;
    this.show(key, true);
    await new Promise((r) => setTimeout(r, 300));
    await view.webContents.executeJavaScript(`(function () {
      const click = (el) => { if (!el) return false; for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 })); return true; };
      return click(document.querySelector('.sidebar-header .btn-menu-toggle, .sidebar-tools-button')) || click(document.querySelector('button[aria-label="Settings"], [data-icon="settings"]'));
    })()`).catch(() => false);
  }

  // Saves an anonymised outline of the open page (tags, classes, attributes; letters in texts are
  // replaced by "a") so the chat list and message elements of that web client can be located.
  async inspect() {
    const view = this.views.get(this.currentKey);
    if (!view) throw new Error('Open a service from the left buttons first');
    const outline = await view.webContents.executeJavaScript(`(${OUTLINE})()`);
    const file = path.join(app.getPath('desktop'), `${this.currentKey}-structure.txt`);
    fs.writeFileSync(file, outline);
    return file;
  }

  layout() {
    for (const [key, v] of this.views) {
      if (key === this.currentKey) v.setBounds(this.onScreen()); else this.park(v);
    }
  }
}

module.exports = { WebTabs, LIB };
