import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {isPatchableTarget} from '../src/cdp.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const INJECT_PATH = path.join(REPO_ROOT, 'ui/inject.js');

function createMockDom({title = 'Antigravity', trackModalInnerHtml = false} = {}) {
  let modalInnerHtmlCalls = 0;

  function splitSelector(sel) {
    return sel.split(',').map(s => s.trim()).filter(Boolean);
  }

  function matchesSimple(el, part) {
    if (!el || el.nodeType !== 1) return false;
    const tokens = part.split(/\s+/);
    const leaf = tokens[tokens.length - 1];
    const matchLeaf = (node, tok) => {
      if (!node || node.nodeType !== 1) return false;
      if (tok === '*') return true;
      let rest = tok;
      const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
      if (tagMatch) {
        if (node.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
        rest = rest.slice(tagMatch[0].length);
      }
      while (rest.length > 0) {
        if (rest[0] === '#') {
          const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
          if (!m || node.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
          if (!m || !node.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = rest.match(/^\[([^=\]]+)(?:="([^"]*)")?\]/);
          if (!m) return false;
          const attrVal = node.getAttribute(m[1]);
          if (m[2] !== undefined ? attrVal !== m[2] : attrVal === null) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    if (!matchLeaf(el, leaf)) return false;
    if (tokens.length === 1) return true;
    let cur = el.parentElement;
    let idx = tokens.length - 2;
    while (cur && idx >= 0) {
      if (matchLeaf(cur, tokens[idx])) idx--;
      cur = cur.parentElement;
    }
    return idx < 0;
  }

  function matchesSelector(el, selector) {
    return splitSelector(selector).some(p => matchesSimple(el, p));
  }

  class MockElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.childNodes = [];
      this.parentNode = null;
      this.parentElement = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this._textContent = '';
      this._innerHTML = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.type = '';
      this.dataset = {};
      this.style = {
        setProperty: (k, v) => { this.style[k] = v; },
        removeProperty: (k) => { delete this.style[k]; },
      };
      this.classList = {
        _set: () => new Set(String(this.className || '').split(/\s+/).filter(Boolean)),
        add: (...names) => {
          const s = this.classList._set();
          for (const n of names) if (n) s.add(n);
          this.className = [...s].join(' ');
        },
        remove: (...names) => {
          const s = this.classList._set();
          for (const n of names) s.delete(n);
          this.className = [...s].join(' ');
        },
        contains: (name) => this.classList._set().has(name),
        toggle: (name, force) => {
          const s = this.classList._set();
          const has = s.has(name);
          const next = force === undefined ? !has : Boolean(force);
          if (next) s.add(name);
          else s.delete(name);
          this.className = [...s].join(' ');
          return next;
        },
      };
    }

    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', String(v)); }

    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', String(v)); }

    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.documentElement) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    get textContent() {
      if (this.children.length === 0 && this.childNodes.length === 0) return this._textContent;
      return this.childNodes.map(c => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
      this.children = [];
      this.childNodes = [];
    }

    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) {
      if (trackModalInnerHtml && (this.id === 'ag-remote-folder-modal' || this.closest('#ag-remote-folder-modal'))) {
        modalInnerHtmlCalls++;
      }
      this._innerHTML = String(v ?? '');
      if (this._innerHTML === '') {
        this.children = [];
        this.childNodes = [];
      }
    }

    setAttribute(k, v) {
      const val = String(v);
      this.attributes.set(k, val);
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = val;
      }
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }

    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') {
          this.childNodes.push({nodeType: 3, nodeValue: n, textContent: n, parentElement: this});
        } else if (n) {
          this.appendChild(n);
        }
      }
    }

    appendChild(child) {
      if (child.parentNode && child.parentNode !== this) {
        child.parentNode.removeChild?.(child);
      }
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      this.childNodes.push(child);
      return child;
    }

    removeChild(child) {
      this.children = this.children.filter(c => c !== child);
      this.childNodes = this.childNodes.filter(c => c !== child);
      if (child.parentNode === this) {
        child.parentNode = null;
        child.parentElement = null;
      }
      return child;
    }

    remove() {
      this.parentNode?.removeChild?.(this);
    }

    matches(sel) {
      return matchesSelector(this, sel);
    }

    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches && cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children || []) {
          if (matchesSelector(ch, sel)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }

    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }

    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      this.listeners.set(type, list.filter(f => f !== fn));
    }

    dispatchEvent(ev) {
      const event = ev || {type: 'click', target: this, stopPropagation() {}, preventDefault() {}};
      if (!event.target) event.target = this;
      let stopped = false;
      const origStop = event.stopPropagation?.bind(event);
      event.stopPropagation = () => { stopped = true; origStop?.(); };
      let cur = this;
      while (cur && !stopped) {
        for (const fn of cur.listeners.get(event.type) || []) {
          fn(event);
        }
        cur = cur.parentElement;
      }
    }

    click() {
      this.dispatchEvent({type: 'click', target: this, stopPropagation() {}, preventDefault() {}});
    }
  }

  const docListeners = new Map();
  const doc = {
    title,
    readyState: 'complete',
    documentElement: new MockElement('html'),
    head: new MockElement('head'),
    body: new MockElement('body'),
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => doc.documentElement.querySelector(`#${id}`),
    querySelector: (sel) => doc.documentElement.querySelector(sel),
    querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
    createTreeWalker: () => ({nextNode: () => null, currentNode: null}),
    addEventListener: (type, fn) => {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener: (type, fn) => {
      const list = docListeners.get(type) || [];
      docListeners.set(type, list.filter(f => f !== fn));
    },
    dispatchEvent: () => {},
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  return {
    doc,
    MockElement,
    getModalInnerHtmlCalls: () => modalInnerHtmlCalls,
  };
}

function createStorageMock() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

async function bootInjectInSandbox({
  title = 'Antigravity',
  port = '42000',
  hostname = '127.0.0.1',
  sshRemote = undefined,
  fetchImpl = async () => new Response('{}', {status: 200}),
  trackModalInnerHtml = false,
} = {}) {
  const source = await fs.readFile(INJECT_PATH, 'utf8');
  const {doc, MockElement, getModalInnerHtmlCalls} = createMockDom({title, trackModalInnerHtml});
  const localStorageMock = createStorageMock();
  const sessionStorageMock = createStorageMock();

  const win = {
    location: {
      hostname,
      port,
      pathname: '/',
      search: '',
      origin: `https://${hostname}:${port}`,
      href: `https://${hostname}:${port}/`,
    },
    document: doc,
    fetch: fetchImpl,
    sshRemote,
    localStorage: localStorageMock,
    sessionStorage: sessionStorageMock,
    navigator: {platform: 'MacIntel'},
    history: {
      state: null,
      pushState() {},
      replaceState() {},
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    AbortSignal,
    PopStateEvent: class PopStateEvent { constructor(t) { this.type = t; } },
    Storage: {prototype: {getItem: localStorageMock.getItem, setItem: localStorageMock.setItem, removeItem: localStorageMock.removeItem}},
    Node: {ELEMENT_NODE: 1},
    NodeFilter: {FILTER_REJECT: 2, FILTER_SKIP: 3, FILTER_ACCEPT: 1, SHOW_ELEMENT: 1, SHOW_TEXT: 4},
    Element: MockElement,
    HTMLElement: MockElement,
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    crypto,
  };
  win.window = win;
  win.self = win;

  const ctx = vm.createContext(win);
  const installFn = vm.runInContext(source, ctx);
  assert.equal(typeof installFn, 'function', 'ui/inject.js must evaluate to an install function');

  const config = {preset: 'native', localize: false, metrics: false, sshMode: 'auto'};
  const result = installFn(config, 'body {}', {}, 'sig-test-1');
  return {win, doc, result, getModalInnerHtmlCalls};
}

test('isPatchableTarget accepts Hub windows and rejects official (SSH: ...) and non-http/loopback targets', () => {
  assert.equal(
    isPatchableTarget({
      type: 'page',
      title: 'Antigravity',
      url: 'http://127.0.0.1:42000/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
    }),
    true
  );
  assert.equal(
    isPatchableTarget({
      type: 'page',
      title: 'Workspace - Jetski Web',
      url: 'https://127.0.0.1:58282/c/123',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/2',
    }, 9222),
    true
  );
  assert.equal(
    isPatchableTarget({
      type: 'page',
      title: 'Antigravity (SSH: devbox)',
      url: 'https://127.0.0.1:58282/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/3',
    }),
    false
  );
  assert.equal(
    isPatchableTarget({
      type: 'page',
      title: 'myproj - Antigravity (ssh: prod-host)',
      url: 'http://127.0.0.1:42000/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/4',
    }),
    false
  );
  assert.equal(
    isPatchableTarget({
      type: 'page',
      title: 'Antigravity',
      url: 'data:text/html,<h1>hello</h1>',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/5',
    }),
    false
  );
  assert.equal(
    isPatchableTarget({
      type: 'page',
      title: 'Antigravity',
      url: 'https://evil.example.com/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/6',
    }),
    false
  );
  assert.equal(
    isPatchableTarget({
      type: 'webview',
      title: 'Antigravity',
      url: 'https://127.0.0.1:58282/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/7',
    }),
    false
  );
});

test('importing ui/inject.js has zero side effects and install() bails out on official (SSH: ...) windows', async () => {
  const mod = await import('../ui/inject.js');
  assert.deepEqual(Object.keys(mod), []);

  const origFetch = async () => {};
  const sbTitle = await bootInjectInSandbox({
    title: 'repo - Antigravity (SSH: devbox)',
    fetchImpl: origFetch,
  });
  assert.equal(sbTitle.result, undefined);
  assert.equal(sbTitle.win.__feiAGPatch, undefined);
  assert.equal(sbTitle.win.fetch, origFetch);

  const sbHost = await bootInjectInSandbox({
    title: 'Antigravity',
    sshRemote: {currentHost: 'devbox'},
    fetchImpl: origFetch,
  });
  assert.equal(sbHost.result, undefined);
  assert.equal(sbHost.win.__feiAGPatch, undefined);
  assert.equal(sbHost.win.fetch, origFetch);
});

test('isEphemeralSummary runs in linear time (< 15ms) on 5,000-char pathological inputs and translates valid summaries', async () => {
  const sb = await bootInjectInSandbox();
  try {
    const patch = sb.win.__feiAGPatch;
    assert.equal(patch.version, '20261118-ssh-v14');
    assert.equal(patch.isEphemeralSummary('Explored 2 files, Ran 3 commands, Edited 1 artifact'), true);
    assert.equal(
      patch.computeTextTranslation('Explored 2 files, Ran 3 commands, Edited 1 artifact'),
      '已探索 2 个文件、已运行 3 条命令、已编辑 1 个交付工件'
    );
    assert.equal(patch.isEphemeralSummary('Explored files and artifacts'), true);
    assert.equal(patch.isEphemeralSummary('Explored 1 file, invalid'), false);

    const pathological1 = 'Explored ' + '1 file, '.repeat(625) + '!';
    const pathological2 = 'Explored' + ' '.repeat(5000) + '!';
    const pathological3 = 'Explored 1 file and 2 artifacts, '.repeat(160);
    assert.ok(pathological1.length > 5000);

    const t0 = performance.now();
    assert.equal(patch.isEphemeralSummary(pathological1), false);
    assert.equal(patch.isEphemeralSummary(pathological2), false);
    assert.equal(patch.isEphemeralSummary(pathological3), false);
    assert.equal(patch.computeTextTranslation(pathological1), null);
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 15, `expected < 15ms, got ${elapsedMs.toFixed(2)}ms`);
  } finally {
    sb.win.__feiAGPatch?.dispose();
  }
});

test('openRemoteFolderPickerModal prevents XSS, avoids innerHTML, and supports filter, breadcrumbs & quick-pick', async () => {
  const rpcCalls = [];
  const xssHost = '<img src=x onerror=alert(1)>';
  const xssHome = '/home/"><svg onload=alert(1)>';
  const xssDir = '<script>alert(1)</script>';
  let returnError = false;

  const sb = await bootInjectInSandbox({
    trackModalInnerHtml: true,
    fetchImpl: async (url, init) => {
      rpcCalls.push({url: String(url), headers: init?.headers, body: init?.body});
      if (String(url).endsWith('/ReadDir')) {
        if (returnError) {
          return new Response('boom', {status: 500});
        }
        return new Response(JSON.stringify({
          entries: [
            {isDir: true, name: 'alpha-repo', uri: 'file:///develop/alpha-repo'},
            {isDir: true, name: 'beta-repo', uri: 'file:///develop/beta-repo'},
            {isDir: true, name: xssDir, uri: `file:///develop/${encodeURIComponent(xssDir)}`},
          ],
        }), {status: 200});
      }
      return new Response(JSON.stringify({resourceType: 'FOLDER_TYPE_GIT_FOLDER'}), {status: 200});
    },
  });

  try {
    const patch = sb.win.__feiAGPatch;
    sb.win.__ag_update_ssh_state({
      status: 'connected',
      remoteHostname: xssHost,
      remoteHomeDir: xssHome,
      gatewayToken: 'gw-test-token-123',
      projectEnvMap: {},
      remoteProjectIds: [],
    });

    const modal = patch.openRemoteFolderPickerModal('/develop');
    await new Promise(r => setTimeout(r, 20));

    assert.equal(sb.getModalInnerHtmlCalls(), 0, 'openRemoteFolderPickerModal must not use innerHTML');
    assert.equal(modal.querySelectorAll('img').length, 0);
    assert.equal(modal.querySelectorAll('svg').length, 0);
    assert.equal(modal.querySelectorAll('script').length, 0);

    const badge = modal.querySelector('.ag-remote-modal-badge');
    assert.equal(badge.textContent, `SSH · ${xssHost}`);

    const items = modal.querySelectorAll('.ag-remote-modal-item');
    assert.equal(items.length, 3);
    assert.ok(items.some(el => el.querySelector('.ag-remote-dir-name')?.textContent === xssDir));

    // Verify gateway token sent on ReadDir RPC
    const readDirCall = rpcCalls.find(c => c.url.endsWith('/ReadDir'));
    assert.equal(readDirCall.headers['x-ag-gateway-token'], 'gw-test-token-123');

    // Verify breadcrumbs rendered
    const crumbs = modal.querySelector('#ag-remote-breadcrumbs');
    assert.ok(crumbs.querySelectorAll('.ag-remote-quick-chip').length >= 2);

    // Verify quick filter input filters .ag-remote-modal-item rows in-place
    const filterInput = modal.querySelector('#ag-remote-filter-input');
    assert.equal(filterInput.getAttribute('placeholder'), '过滤当前层目录…');
    filterInput.value = 'alpha';
    filterInput.dispatchEvent({type: 'input', target: filterInput, stopPropagation() {}});
    const visibleAfterFilter = items.filter(el => el.style.display !== 'none');
    assert.equal(visibleAfterFilter.length, 1);
    assert.equal(visibleAfterFilter[0].querySelector('.ag-remote-dir-name').textContent, 'alpha-repo');

    // Verify per-row quick select button ("选择此项") triggers CreateProject
    const pickBtn = visibleAfterFilter[0].querySelector('.ag-remote-pick-btn');
    assert.equal(pickBtn.textContent, '选择此项');
    pickBtn.click();
    await new Promise(r => setTimeout(r, 20));
    const createCall = rpcCalls.find(c => c.url.endsWith('/CreateProject'));
    assert.ok(createCall, 'quick pick button should invoke CreateProject');
    assert.equal(createCall.headers['x-ag-gateway-token'], 'gw-test-token-123');

    // Verify error message rendering is also XSS-safe
    returnError = true;
    const errModal = patch.openRemoteFolderPickerModal('/broken');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(sb.getModalInnerHtmlCalls(), 0);
    assert.ok(errModal.querySelector('.ag-remote-list-empty').textContent.includes('读取失败:'));
    errModal.remove();
  } finally {
    sb.win.__feiAGPatch?.dispose();
  }
});

test('unifiedAgFetch adds x-ag-gateway-token, clones Request bodies across retry/fallback, and cleans up fallback AbortControllers', async () => {
  const calls = [];
  let releaseFallback;
  const fallbackDeferred = new Promise(resolve => { releaseFallback = resolve; });

  const sb = await bootInjectInSandbox({
    port: '42000',
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      let bodyText = '';
      if (typeof Request !== 'undefined' && input instanceof Request) {
        assert.equal(input.bodyUsed, false, 'fallback Request body must still be usable');
        bodyText = await input.text();
      } else if (init?.body) {
        bodyText = await new Response(init.body).text();
      }
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      calls.push({url, bodyText, gwToken: headers.get('x-ag-gateway-token')});

      if (url.startsWith('https://127.0.0.1:58282/')) {
        throw new Error('ECONNREFUSED');
      }
      if (url.includes('ProjectUpdatesStream')) {
        return await fallbackDeferred;
      }
      return new Response('{"ok":true}', {status: 200});
    },
  });

  try {
    sb.win.__ag_update_ssh_state({
      status: 'error',
      gatewayToken: 'gw-secret-hex',
    });

    const unaryReq = new Request('http://127.0.0.1:42000/exa.language_server_pb.LanguageServerService/ListProjects', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({hello: 'world'}),
    });
    const res = await sb.win.fetch(unaryReq);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 3, 'primary + retry + local fallback');
    assert.equal(calls[0].gwToken, 'gw-secret-hex');
    assert.equal(calls[0].bodyText, '{"hello":"world"}');
    assert.equal(calls[1].bodyText, '{"hello":"world"}');
    assert.equal(calls[2].bodyText, '{"hello":"world"}');

    // Now test streaming RPC fallback AbortController cleanup on .finally()
    const streamReq = new Request('http://127.0.0.1:42000/exa.language_server_pb.LanguageServerService/ProjectUpdatesStream', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({stream: true}),
    });
    const streamPromise = sb.win.fetch(streamReq);
    // Wait past the 350ms retry backoff so fallback origFetch is active
    await new Promise(r => setTimeout(r, 420));
    assert.equal(sb.win.__ag_fallback_stream_controllers.size, 1);

    releaseFallback(new Response('stream-ok', {status: 200}));
    const streamRes = await streamPromise;
    assert.equal(streamRes.status, 200);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(sb.win.__ag_fallback_stream_controllers.size, 0, 'settled fallback controller must be deleted');
  } finally {
    sb.win.__feiAGPatch?.dispose();
  }
});
