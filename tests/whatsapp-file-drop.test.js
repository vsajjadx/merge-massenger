const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDrop(inputs) {
  const handlers = {};
  const events = [];
  class DataTransfer {
    constructor() {
      this._files = [];
      this.items = { add: (file) => this._files.push(file) };
    }
    get files() { return this._files; }
  }
  class Event {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  const document = {
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') return inputs;
      return [];
    },
  };
  const window = {
    addEventListener(type, fn) { handlers[type] = fn; },
  };
  const sandbox = {
    window,
    document,
    location: { hostname: 'web.whatsapp.com' },
    DataTransfer,
    Event,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    RegExp,
    console,
    require(id) {
      assert.equal(id, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld() {},
          executeInMainWorld() {},
        },
        ipcRenderer: { invoke: async () => null, send() {} },
        webUtils: {},
      };
    },
  };
  for (const input of inputs) input.dispatchEvent = (event) => events.push({ input, event });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/webpreload.js'), 'utf8'), sandbox, {
    filename: path.join(__dirname, '../src/main/webpreload.js'),
  });
  return { drop: handlers.drop, events };
}

function input(accept, multiple = true) { return { accept, multiple, files: null }; }

test('WhatsApp drops documents into the document input, not the image input', async () => {
  const image = input('image/*,video/*');
  const documentInput = input('*/*');
  const h = loadDrop([image, documentInput]);
  const file = { name: 'report.pdf', type: 'application/pdf' };
  h.drop({
    dataTransfer: { types: ['Files'], files: [file] },
    preventDefault() {}, stopImmediatePropagation() {},
  });
  await Promise.resolve();
  assert.equal(image.files, null);
  assert.deepEqual(documentInput.files, [file]);
  assert.equal(h.events.length, 2);
});

test('WhatsApp drops images into the media input even when a document input is also present', async () => {
  const image = input('image/*,video/*');
  const documentInput = input('*/*');
  const h = loadDrop([image, documentInput]);
  const file = { name: 'photo.png', type: 'image/png' };
  h.drop({
    dataTransfer: { types: ['Files'], files: [file] },
    preventDefault() {}, stopImmediatePropagation() {},
  });
  await Promise.resolve();
  assert.deepEqual(image.files, [file]);
  assert.equal(documentInput.files, null);
  assert.equal(h.events.length, 2);
});
