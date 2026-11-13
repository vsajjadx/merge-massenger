// Run only against an isolated development profile started with --remote-debugging-port=9333.
// No messages are sent and all conversation fixtures exist only in renderer memory.
const assert = require('node:assert/strict');
const expectedVersion = require('../package.json').version;

async function main() {
  const port = Number(process.argv.slice(2).find(value => /^\d+$/.test(value)) || 9333);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page' && t.url.startsWith('file:') && /renderer\/index\.html$/.test(t.url));
  assert.ok(target, 'Development renderer is available');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const value = JSON.parse(e.data);
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    clearTimeout(request.timer);
    value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    const info = await evaluate('api.appInfo()');
    assert.ok(/(?:qa-profile|packaged-qa|lifecycle-test)/i.test(info.dataPath), 'Fixtures require a dedicated QA profile');
    const status = await evaluate(`({ready: document.readyState, loading: state.loading, theme: document.documentElement.dataset.theme, rows: document.querySelectorAll('#chatList .chat-item').length, toast: document.querySelector('#toast').textContent})`);
    console.log('Renderer state:', JSON.stringify(status));
    assert.equal(status.loading, false, 'Application initialization completes');
    const result = await evaluate(`(async () => {
      const old = {chats: state.chats, view: state.view, filter: state.filter, search: state.search, archiveOpen: state.archiveOpen, preferences: {...state.preferences}, rail: state.rail, active: state.active, webStatuses: {...state.webStatuses}};
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      try {
        state.chats = new Map([
          ['tg:test1', {id:'tg:test1',source:'tg',title:'Design team',lastText:'Review sketches',lastTs:100,unread:2,pinned:false,archived:false}],
          ['wa:test2', {id:'wa:test2',source:'wa',title:'Alice',lastText:'Hello',lastTs:200,unread:0,pinned:true,pinOrder:1,archived:false}],
          ['tg:test3', {id:'tg:test3',source:'tg',title:'Archive',lastText:'Earlier',lastTs:50,unread:0,pinned:false,archived:true}],
        ]);
        state.filter=null; state.search=''; state.archiveOpen=false; state.view='all';
        assert(sortedChats().length === 2, 'All excludes archived chats');
        assert(sortedChats()[0].id === 'wa:test2', 'Pinned chat stays first');
        state.view='unread'; assert(sortedChats().length === 1, 'Unread filter works');
        state.view='pinned'; assert(sortedChats().length === 1, 'Pinned filter works');
        state.view='archived'; assert(sortedChats().length === 1, 'Archive filter works');
        state.view='all'; state.search='sketches'; assert(sortedChats()[0].id === 'tg:test1', 'Preview search works');
        state.search='whatsapp'; assert(sortedChats()[0].id === 'wa:test2', 'Service search works');
        state.search=''; state.filter='tg'; assert(sortedChats().length === 1, 'Service filter works');
        state.filter=null;
        state.chats.set('tg:xss',{id:'tg:xss',source:'tg',title:'<img src=x onerror=alert(1)>',lastText:'<script>alert(1)</script>',lastTs:300,unread:0,pinned:false,archived:false});
        renderList(); await new Promise(requestAnimationFrame);
        assert(!document.querySelector('#chatList img[src="x"]'), 'Conversation markup is escaped');
        assert(document.querySelector('#chatList').textContent.includes('<img'), 'Escaped text remains visible');
        applyPreferences({...state.preferences,theme:'light',compact:true});
        assert(document.documentElement.dataset.theme === 'light', 'Light theme applies');
        applyPreferences({...state.preferences,theme:'dark',compact:false});
        assert(document.documentElement.dataset.theme === 'dark', 'Dark theme applies');
        state.webStatuses = {...state.webStatuses, ei: {key:'ei',state:'ready'}};
        markRail('ei');
        const refresh = document.querySelector('#refreshEitaaBtn');
        assert(!refresh.hidden && !refresh.disabled, 'Refresh Eitaa is available in Eitaa');
        state.webStatuses.ei.state='loading'; syncEitaaRefresh();
        assert(refresh.disabled && refresh.getAttribute('aria-busy')==='true', 'Refresh progress is accessible');
        state.webStatuses.ei.state='ready'; syncEitaaRefresh();
        assert(!refresh.disabled, 'Refresh is available again after loading');
        markRail('tg'); assert(refresh.hidden, 'Eitaa button stays hidden in other messengers');
        const prefs=await api.preferences();
        assert(prefs.language==='en','English is default');
        const info=await api.appInfo();
        assert(info.version===${JSON.stringify(expectedVersion)},'Version IPC agrees with package');
        return {assertions:17,version:info.version,downloadPath:prefs.downloadPath,services:(await api.webStatuses()).length};
      } finally {
        Object.assign(state, old); applyPreferences(old.preferences); markRail(old.rail); renderList();
      }
    })()`);
    console.log('UI integration passed:', JSON.stringify(result));
    if (process.argv.includes('--quit')) await evaluate('setTimeout(() => api.quit(), 100); true');
  } finally { ws.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
