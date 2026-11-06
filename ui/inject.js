(function install(config, css, dictionary, signature) {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) return;
  const PATCH_VERSION = '20261104-ssh-v12';

  if (typeof window.__ag_multiplexer_booted_before_main === 'undefined') {
    window.__ag_multiplexer_booted_before_main = document.readyState === 'loading';
  }

  // Discover local CSRF token early if running on local Mac port
  function detectPageCsrfToken() {
    if (window.__APP_CONFIG__?.csrfToken && typeof window.__APP_CONFIG__.csrfToken === 'string') {
      return window.__APP_CONFIG__.csrfToken;
    }
    if (window.csrfToken && typeof window.csrfToken === 'string') return window.csrfToken;
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const m = (s.textContent || '').match(/"csrfToken"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
      }
    } catch {}
    return '';
  }

  if (location.port && location.port !== '58282' && location.port !== '58285') {
    window.__ag_local_mac_port = Number(location.port);
    const detectedCsrf = detectPageCsrfToken();
    if (detectedCsrf) window.__ag_local_mac_csrf = detectedCsrf;
  }

  // Install unified window.fetch multiplexer so local and remote SSH projects & conversations coexist in one window
  function installUnifiedFetchMultiplexer() {
    const origFetch = window.__ag_orig_fetch || window.fetch.bind(window);
    window.__ag_orig_fetch = origFetch;
    window.__ag_fetch_multiplexer_active = true;
    if (!window.__ag_fallback_stream_controllers) {
      window.__ag_fallback_stream_controllers = new Set();
    }

    window.fetch = async function unifiedAgFetch(input, init) {
      let isStreamingRpc = false;
      let muxUrl = '';
      let nextInit = null;
      try {
        const urlStr = typeof input === 'string' ? input : (input?.url || String(input));
        const rpcMarker = '/exa.language_server_pb.LanguageServerService/';
        const markerIdx = urlStr.indexOf(rpcMarker);
        if (markerIdx !== -1) {
          const curSsh = window.__ag_ssh_state || {};
          // If user explicitly chose local-only mode and is on local Mac port, use native local fetch
          if (curSsh.mode === 'local' && location.port !== '58282') {
            return origFetch(input, init);
          }

          if (!window.__ag_local_mac_csrf && location.port !== '58282') {
            const c = detectPageCsrfToken();
            if (c) window.__ag_local_mac_csrf = c;
          }

          if (typeof window.__ag_sync_active_env === 'function') {
            try { window.__ag_sync_active_env(); } catch {}
          }

          const rpcPath = urlStr.slice(markerIdx);
          isStreamingRpc =
            rpcPath.includes('ProjectUpdatesStream') ||
            rpcPath.includes('JetboxSubscribeToSummaries');
          muxUrl = `https://127.0.0.1:58282${rpcPath}`;
          const headers = new Headers(
            init?.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
          );
          headers.set('x-ag-client', 'unified-browser');
          headers.set('x-ag-target-env', window.__ag_active_env || 'local');
          if (window.__ag_active_project_id) {
            headers.set('x-ag-active-project', String(window.__ag_active_project_id));
          }

          const localPort =
            location.port && location.port !== '58282'
              ? location.port
              : String(window.__ag_local_mac_port || curSsh.localMacPort || '');
          const localCsrf =
            location.port && location.port !== '58282'
              ? (window.__ag_local_mac_csrf || detectPageCsrfToken() || '')
              : (curSsh.localMacCsrfToken || window.__ag_local_mac_csrf || '');

          if (localPort) headers.set('x-ag-local-port', String(localPort));
          if (localCsrf) headers.set('x-ag-local-csrf', String(localCsrf));

          nextInit = {
            ...(init || {}),
            headers,
          };
          if (typeof Request !== 'undefined' && input instanceof Request && !init?.body && input.body) {
            nextInit.method = nextInit.method || input.method;
            nextInit.body = input.body;
            nextInit.duplex = 'half';
          }
          return await origFetch(muxUrl, nextInit);
        }
      } catch (err) {
        if (muxUrl && nextInit) {
          try {
            await new Promise(r => setTimeout(r, 350));
            return await origFetch(muxUrl, nextInit);
          } catch {}
        }
        if (location.port !== '58282') {
          if (isStreamingRpc && typeof AbortController !== 'undefined') {
            const fbCtrl = new AbortController();
            window.__ag_fallback_stream_controllers.add(fbCtrl);
            const origSig = init?.signal || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
            const combinedSignal =
              origSig && typeof AbortSignal?.any === 'function'
                ? AbortSignal.any([origSig, fbCtrl.signal])
                : fbCtrl.signal;
            return origFetch(input, {...(init || {}), signal: combinedSignal});
          }
          return origFetch(input, init);
        }
        throw err;
      }
      return origFetch(input, init);
    };
  }

  installUnifiedFetchMultiplexer();

  const previous = window.__feiAGPatch;
  if (previous?.signature === signature && window.__ag_patch_version === PATCH_VERSION) {
    previous.sync?.();
    return previous.health();
  }
  previous?.dispose();

  let disposed = false;
  let timer = 0;
  let observer;
  let metricsResizeObserver;
  let observedBottomRow = null;
  let state = {
    preset: config.preset,
    localize: config.localize,
    metrics: config.metrics !== false,
    sshMode: config.sshMode || 'auto',
  };

  let cachedSshState = null;
  if (!window.__ag_ssh_state) {
    try {
      const rawCached = sessionStorage.getItem('__ag_ssh_state_cache');
      if (rawCached) {
        const parsedCached = JSON.parse(rawCached);
        if (parsedCached && typeof parsedCached === 'object' && Date.now() - (parsedCached.updatedAt || 0) < 60000) {
          cachedSshState = parsedCached;
        }
      }
    } catch {}
  }

  let sshState = window.__ag_ssh_state || cachedSshState || {
    mode: config.sshMode || 'auto',
    envFilter: 'all',
    status: 'connecting',
    activeHost: null,
    latencyMs: 0,
    routeLatencies: {},
    localMacPort: window.__ag_local_mac_port || 0,
    localMacCsrfToken: window.__ag_local_mac_csrf || '',
    localHttpsPort: 58282,
    localHttpPort: 58283,
    localBridgePort: 58284,
    remoteHostname: 'remote-host',
    remoteHomeDir: '/home/user',
    csrfToken: '',
    hasAuth: true,
    sidecarPorts: [],
    projectEnvMap: {},
    localProjectIds: [],
    remoteProjectIds: [],
    cloudProjectIds: [],
    remoteCascadeIds: [],
    remoteCascadeIdsSet: new Set(),
    localCascadeIds: [],
    localCascadeIdsSet: new Set(),
    cascadeProjectMap: {},
    lastError: '',
  };
  if (Array.isArray(sshState.remoteCascadeIds)) {
    sshState.remoteCascadeIdsSet = new Set(sshState.remoteCascadeIds);
  }
  if (Array.isArray(sshState.localCascadeIds)) {
    sshState.localCascadeIdsSet = new Set(sshState.localCascadeIds);
  }
  window.__ag_ssh_state = sshState;

  if (!window.__ag_active_env) {
    window.__ag_active_env = Number(location.port) === 58282 ? 'remote' : 'local';
  }

  function isRemoteWindow() {
    const port = Number(location.port);
    return Boolean(window.__ag_is_ssh_remote) || port === 58282 || (sshState.localHttpsPort > 0 && port === sshState.localHttpsPort);
  }

  if (isRemoteWindow()) {
    window.__ag_is_ssh_remote = true;
  }

  function sendSshAction(payload) {
    try {
      if (typeof window.__agSshAction === 'function') {
        window.__agSshAction(JSON.stringify(payload || {}));
      }
    } catch {}
  }

  function resolveProjectEnvInfo(projectId) {
    if (!projectId) {
      return {env: window.__ag_active_env || 'local', name: '', uri: '', host: 'Mac'};
    }
    const map = sshState.projectEnvMap || {};
    if (map[projectId]) return map[projectId];
    const cloudList = Array.isArray(sshState.cloudProjectIds) ? sshState.cloudProjectIds : [];
    if (cloudList.includes(projectId)) {
      return {
        env: 'cloud',
        name: projectId,
        uri: '',
        host: 'Cloud',
      };
    }
    const remoteList = Array.isArray(sshState.remoteProjectIds) ? sshState.remoteProjectIds : [];
    if (
      projectId === 'ssh-default-cli-project' ||
      remoteList.includes(projectId)
    ) {
      return {
        env: 'remote',
        name: projectId === 'ssh-default-cli-project' ? `${sshState.remoteHostname || 'remote-host'} (home)` : projectId,
        uri: `file://${sshState.remoteHomeDir || '/home/user'}`,
        host: sshState.remoteHostname || 'remote-host',
      };
    }
    return {
      env: 'local',
      name: projectId,
      uri: '',
      host: 'Mac',
    };
  }

  function findMatchingProjectIdsByName(label) {
    if (!label) return [];
    const trimmed = label
      .replace(/SSH\s*·\s*\S+/g, '')
      .replace(/☁️?\s*云端/g, '')
      .replace(/本机/g, '')
      .trim();
    if (!trimmed) return [];
    const map = sshState.projectEnvMap || {};
    const exact = [];
    const prefix = [];
    for (const [pid, info] of Object.entries(map)) {
      if (!info || !info.name) continue;
      if (info.name === trimmed) exact.push(pid);
      else if (trimmed.startsWith(info.name)) prefix.push(pid);
    }
    return exact.length > 0 ? exact : prefix;
  }

  function findProjectIdByName(label, preferredEnv = '') {
    const matches = findMatchingProjectIdsByName(label);
    if (matches.length === 0) return '';
    if (matches.length === 1) return matches[0];
    if (window.__ag_active_project_id && matches.includes(window.__ag_active_project_id)) {
      return window.__ag_active_project_id;
    }
    const wantEnv =
      preferredEnv ||
      (sshState.envFilter === 'remote' || sshState.envFilter === 'local' ? sshState.envFilter : '') ||
      window.__ag_active_env ||
      '';
    if (wantEnv) {
      const envMatch = matches.find((pid) => resolveProjectEnvInfo(pid).env === wantEnv);
      if (envMatch) return envMatch;
    }
    return matches[0];
  }

  function syncActiveEnvFromUrl() {
    try {
      const cMatch = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      if (cMatch) {
        const cid = cMatch[1];
        const cascadeMap = sshState.cascadeProjectMap || {};
        const rowEl = document.querySelector(`[data-sidebar-row-id="${cid}"], [data-cascade-id="${cid}"]`);
        const domPid =
          rowEl?.getAttribute('data-ag-project-id') ||
          rowEl?.getAttribute('data-sidebar-section-id') ||
          rowEl?.closest('[data-ag-project-id], [data-sidebar-section-id]')?.getAttribute('data-sidebar-section-id') ||
          '';
        const validDomPid =
          domPid && domPid !== 'main-section-header' && domPid !== 'standalone' && domPid !== 'pinned' && !domPid.startsWith('convgroup:')
            ? domPid
            : '';
        const pid = validDomPid || cascadeMap[cid] || '';
        if (pid && pid !== 'outside-of-project') {
          const info = resolveProjectEnvInfo(pid);
          window.__ag_active_env = info.env;
          window.__ag_active_project_id = pid;
          return;
        }
        const rowEnv = rowEl?.getAttribute('data-ag-env');
        if (rowEnv === 'remote' || rowEnv === 'local') {
          window.__ag_active_env = rowEnv;
          return;
        }
        if (sshState.remoteCascadeIdsSet ? sshState.remoteCascadeIdsSet.has(cid) : (Array.isArray(sshState.remoteCascadeIds) && sshState.remoteCascadeIds.includes(cid))) {
          window.__ag_active_env = 'remote';
          window.__ag_active_project_id = cascadeMap[cid] || 'ssh-default-cli-project';
          return;
        }
        if (sshState.localCascadeIdsSet ? sshState.localCascadeIdsSet.has(cid) : (Array.isArray(sshState.localCascadeIds) && sshState.localCascadeIds.includes(cid))) {
          window.__ag_active_env = 'local';
          if (
            window.__ag_active_project_id &&
            resolveProjectEnvInfo(window.__ag_active_project_id).env === 'remote'
          ) {
            window.__ag_active_project_id = 'default-cli-project';
          }
          return;
        }
      }
      const params = new URLSearchParams(location.search);
      const sec = params.get('section') || params.get('project');
      if (sec) {
        const info = resolveProjectEnvInfo(sec);
        window.__ag_active_env = info.env;
        window.__ag_active_project_id = sec;
        return;
      }
      if (location.pathname === '/') {
        const trigger = document.querySelector('[data-testid="project-selector-trigger"]');
        if (trigger) {
          const explicitPid = trigger.getAttribute('data-ag-project-id') || '';
          const pid = explicitPid || findProjectIdByName(trigger.textContent || '');
          if (pid) {
            const info = resolveProjectEnvInfo(pid);
            window.__ag_active_env = info.env;
            window.__ag_active_project_id = pid;
          }
        }
      }
    } catch {}
  }

  window.__ag_sync_active_env = syncActiveEnvFromUrl;
  syncActiveEnvFromUrl();

  // Route modes are roles; the actual ssh host aliases come from the daemon (sshState.routeHosts).
  const routeHostLabel = role => sshState.routeHosts?.[role] ? ` · ${sshState.routeHosts[role]}` : '';
  const wslDistroLabelFor = mode => {
    if (mode === 'direct') return `direct${routeHostLabel('direct')} (直连 · 低延迟)`;
    if (mode === 'tunnel') return `tunnel${routeHostLabel('tunnel')} (跳板隧道 · 跨网段稳定)`;
    return 'auto (智能双路: 直连优先 → 隧道保底)';
  };
  const parseDistroMode = raw => {
    const v = String(raw || 'auto');
    if (v.startsWith('tunnel')) return 'tunnel';
    if (v.startsWith('direct')) return 'direct';
    return 'auto';
  };

  function installRemoteShims() {
    if (isRemoteWindow()) {
      window.__ag_is_ssh_remote = true;
      try {
        window.languageServer = {
          getCsrfToken: async () => sshState.csrfToken || window.__APP_CONFIG__?.csrfToken || '',
          getHttpPort: async () => sshState.localHttpPort || 58283,
          getHttpsPort: async () => sshState.localHttpsPort || Number(location.port) || 58282,
          restartAndConnect: async () => {
            sendSshAction({action: 'restart-remote'});
          },
        };
      } catch {}
    }

    window.__agExtensions = {
      sendAuthorities(authorities) {
        window.__ag_last_authorities = authorities;
        try { window.extensions?.sendAuthorities?.(authorities); } catch {}
        try {
          if (typeof window.__agSyncSidecarAuthorities === 'function') {
            window.__agSyncSidecarAuthorities(JSON.stringify(authorities || {}));
          }
        } catch {}
      },
    };

    const getActiveWslDistroLabel = () => {
      if (sshState.status !== 'connected' && !isRemoteWindow()) return null;
      return wslDistroLabelFor(sshState.mode);
    };

    const buildWslState = async () => ({
      available: true,
      activeDistro: getActiveWslDistroLabel(),
      distros: [
        {name: wslDistroLabelFor('auto'), isDefault: sshState.mode === 'auto'},
        {name: wslDistroLabelFor('direct'), isDefault: sshState.mode === 'direct'},
        {name: wslDistroLabelFor('tunnel'), isDefault: sshState.mode === 'tunnel'},
      ],
      config: {
        enabled: sshState.status === 'connected' || isRemoteWindow(),
        distro: wslDistroLabelFor(sshState.mode),
      },
    });

    window.__agWsl = {
      getState: buildWslState,
      getInfo: buildWslState,
      getConfig: async () => ({
        enabled: sshState.status === 'connected' || isRemoteWindow(),
        distro: sshState.mode === 'local' ? 'auto' : sshState.mode,
      }),
      setConfig: async cfg => {
        const parsedMode = parseDistroMode(cfg?.distro);
        if (cfg?.enabled) {
          sendSshAction({action: 'set-mode', mode: parsedMode});
        } else {
          sendSshAction({action: 'set-mode', mode: 'local'});
        }
        return {success: true};
      },
      checkProvisioned: async () => ({provisioned: true}),
      provision: async () => ({success: true}),
      connect: async distro => {
        if (distro === '' || distro === null || distro === undefined || distro === 'local') {
          sendSshAction({action: 'set-mode', mode: 'local'});
          return {success: true, mode: 'local'};
        }
        const parsedMode = parseDistroMode(distro);
        sendSshAction({action: 'set-mode', mode: parsedMode});
        return {success: true, mode: parsedMode, port: sshState.localHttpsPort || 58282, csrfToken: sshState.csrfToken || ''};
      },
      disconnect: async () => {
        sendSshAction({action: 'set-mode', mode: 'local'});
        return {success: true};
      },
      getStatus: async () => ({
        connected: sshState.status === 'connected' || isRemoteWindow(),
        distro: sshState.activeHost || sshState.mode,
        port: sshState.localHttpsPort || 58282,
      }),
      onProvisionProgress: () => () => {},
      onStateChanged: () => () => {},
    };
  }

  installRemoteShims();

  window.__ag_update_ssh_state = function(nextSshState) {
    if (!nextSshState || typeof nextSshState !== 'object') return;
    sshState = {
      ...sshState,
      ...nextSshState,
      remoteCascadeIdsSet: new Set(Array.isArray(nextSshState.remoteCascadeIds) ? nextSshState.remoteCascadeIds : (sshState.remoteCascadeIds || [])),
      localCascadeIdsSet: new Set(Array.isArray(nextSshState.localCascadeIds) ? nextSshState.localCascadeIds : (sshState.localCascadeIds || [])),
    };
    window.__ag_ssh_state = sshState;
    state.sshMode = sshState.mode || state.sshMode;
    try {
      const {remoteCascadeIdsSet: _r, localCascadeIdsSet: _l, ...serializableState} = sshState;
      sessionStorage.setItem('__ag_ssh_state_cache', JSON.stringify(serializableState));
    } catch {}
    if (sshState.status === 'connected' && window.__ag_fallback_stream_controllers?.size) {
      for (const ctrl of [...window.__ag_fallback_stream_controllers]) {
        try { ctrl.abort(); } catch {}
      }
      window.__ag_fallback_stream_controllers.clear();
    }
    installRemoteShims();
    decorateSidebarProjects();
    syncActiveEnvFromUrl();
    renderSshSidebarCard();
    updateSettingsSshControls();
    if (sshState.status === 'connected') setTimeout(() => healRemoteProjectResourceCache(), 600);
  };

  // ---- Self-heal for 2.29.0+ resolveProjectResources cache --------------------------------------
  // The frontend resolves each project's folders via ResolveFolder once and caches the result per
  // projectId (RTK Query `projectsApi`, no refetch). If that happens while the remote language_server is
  // still starting (e.g. right after an app update), every remote folder is cached as the error fallback
  // {type:0, uri} (no vcsType) and the composer's branch/worktree selector disappears for the session.
  // We detect those poisoned entries for remote projects and patch them in place via the slice's own
  // `queryResultPatched` reducer once the remote side answers.
  let agReduxStoreRef = null;
  function findAgReduxStore() {
    if (agReduxStoreRef) return agReduxStoreRef;
    try {
      const rootEl = document.getElementById('root') || document.body?.firstElementChild;
      if (!rootEl) return null;
      const key = Object.keys(rootEl).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
      let fiber = key ? rootEl[key] : null;
      if (fiber?.stateNode?.current) fiber = fiber.stateNode.current;
      const stack = [fiber];
      let n = 0;
      while (stack.length && n < 300000) {
        const f = stack.pop();
        n++;
        if (!f) continue;
        const st = f.memoizedProps?.store;
        if (st && typeof st.getState === 'function' && typeof st.dispatch === 'function' && st.getState()?.projectsApi) {
          agReduxStoreRef = st;
          return st;
        }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    } catch {}
    return null;
  }

  async function resolveRemoteFolderForHeal(uri) {
    try {
      const fetchFn = window.__ag_orig_fetch || window.fetch;
      const res = await fetchFn('https://127.0.0.1:58282/exa.language_server_pb.LanguageServerService/ResolveFolder', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-ag-force-target': 'remote',
          'x-ag-client': 'unified-browser-heal',
        },
        body: JSON.stringify({folderUri: uri}),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const rt = String(j?.resourceType || '');
      if (!rt) return null;
      const vt = String(j?.vcsType || '');
      const vcsType = /GIT$/.test(vt) ? 1 : 0;
      if (/GIT_FOLDER$/.test(rt)) return {type: 1, uri, vcsType};
      if (/NORMAL_FOLDER$/.test(rt)) return {type: 0, uri, vcsType};
      return null;
    } catch {
      return null;
    }
  }

  const healCooldown = new Map();
  let healInFlight = false;
  async function healRemoteProjectResourceCache() {
    if (healInFlight || disposed) return;
    if (sshState.status !== 'connected' && !isRemoteWindow()) return;
    const store = findAgReduxStore();
    const queries = store?.getState()?.projectsApi?.queries;
    if (!queries) return;
    healInFlight = true;
    try {
      for (const [key, sub] of Object.entries(queries)) {
        if (!sub || sub.status !== 'fulfilled' || !Array.isArray(sub.data)) continue;
        if (sub.endpointName && sub.endpointName !== 'resolveProjectResources') continue;
        if (resolveProjectEnvInfo(key).env !== 'remote') continue;
        const now = Date.now();
        if (now - (healCooldown.get(key) || 0) < 15000) continue;
        const patches = [];
        for (let i = 0; i < sub.data.length; i++) {
          const item = sub.data[i];
          // Error fallback marker from projectManagementService.resolveFolder: {type:0, uri} without vcsType
          if (!item || item.type !== 0 || item.vcsType !== undefined || typeof item.uri !== 'string' || !item.uri.startsWith('file://')) continue;
          healCooldown.set(key, now);
          const resolved = await resolveRemoteFolderForHeal(item.uri);
          if (resolved) patches.push({op: 'replace', path: [i], value: resolved});
        }
        if (patches.length) {
          store.dispatch({type: 'projectsApi/queries/queryResultPatched', payload: {queryCacheKey: key, patches}});
        }
      }
    } catch {} finally {
      healInFlight = false;
    }
  }
  if (window.__agHealProjectsTimer) clearInterval(window.__agHealProjectsTimer);
  window.__agHealProjectsTimer = setInterval(() => {
    if (disposed) {
      clearInterval(window.__agHealProjectsTimer);
      return;
    }
    healRemoteProjectResourceCache();
  }, 5000);

  const PRESETS = {
    HIGH_CONTRAST: 'high-contrast',
    CLAUDE_PUREWHITE: 'claude-desktop-purewhite',
    VINTAGE_DEEP: 'vintage-deep',
    LEGACY_WARM_WHITE: 'chuanban-warm-white',
    LEGACY_OFFICIAL: 'claude-desktop-official',
    LEGACY_CHUANBAN: 'absoulutely-chuanban',
  };
  const ALL_CUSTOM_PRESETS = new Set(Object.values(PRESETS));

  function resolveFlavorPreset(flavor) {
    if (!flavor) return null;
    if (flavor === PRESETS.HIGH_CONTRAST || flavor === PRESETS.LEGACY_WARM_WHITE || flavor === '高对比版')
      return PRESETS.HIGH_CONTRAST;
    if (flavor === PRESETS.CLAUDE_PUREWHITE || flavor === PRESETS.LEGACY_OFFICIAL || flavor === 'ClaudeDesktop 净白')
      return PRESETS.CLAUDE_PUREWHITE;
    if (flavor === PRESETS.VINTAGE_DEEP || flavor === PRESETS.LEGACY_CHUANBAN || flavor === '复古深色')
      return PRESETS.VINTAGE_DEEP;
    if (flavor === 'native' || flavor === 'Default Light')
      return 'native';
    return null;
  }

  function migrateAndSyncStorage() {
    try {
      const stored = Storage.prototype.getItem.call(localStorage, 'theme-preset-light');
      if (ALL_CUSTOM_PRESETS.has(stored)) {
        try { Storage.prototype.setItem.call(localStorage, 'theme-preset-light', 'Default Light'); } catch {}
      }
      const flavor = Storage.prototype.getItem.call(localStorage, 'theme-color-flavor');
      const mapped = resolveFlavorPreset(flavor);
      if (mapped && mapped !== state.preset) {
        state.preset = mapped;
      }
    } catch {}
  }

  if (!window.__ag_preset_hooked) {
    window.__ag_preset_hooked = true;
    try {
      const originalGet = Storage.prototype.getItem.bind(localStorage);
      const originalSet = Storage.prototype.setItem.bind(localStorage);
      localStorage.getItem = function(k) {
        const val = originalGet(k);
        if (k === 'theme-preset-light' && ALL_CUSTOM_PRESETS.has(val)) {
          return 'Default Light';
        }
        return val;
      };
      localStorage.setItem = function(k, v) {
        if (k === 'theme-preset-light' && ALL_CUSTOM_PRESETS.has(v)) {
          v = 'Default Light';
        }
        originalSet(k, v);
        if (k === 'theme-preset-light' || k === 'theme-mode' || k === 'theme-color-flavor') {
          if (k === 'theme-color-flavor') {
            const mapped = resolveFlavorPreset(v);
            if (mapped && window.__feiAGPatch) window.__feiAGPatch.setState({preset: mapped});
          } else {
            setTimeout(() => window.__feiAGPatch?.sync?.(), 50);
          }
        }
      };
    } catch {}
  }

  migrateAndSyncStorage();

  // ---- i18n engine (ported from chuanban-antigravity-theme-patch v5.0.0 core/runtime.js) ----------
  // Whole-document translation with an exclusion list, WeakMap-reversible text nodes, data-ag-orig-*
  // reversible attributes (title / placeholder / aria-label) and dirty-root incremental scanning.
  if (!window.__ag_orig_text_map) window.__ag_orig_text_map = new WeakMap();
  const origTextMap = window.__ag_orig_text_map;

  const protectedSelector = [
    'script', 'style', 'noscript', 'code', 'pre', 'kbd', 'samp', '[class*="language-"]',
    '.monaco-editor', '.xterm', '.prose', '.markdown', '[class*="markdown"]',
    '[class*="chat-message"]', '[data-message-content]', '[data-message-id]',
    '.md-divider-spacing', '[data-testid="planner-response-text"]', '[data-testid="user-input-step"]',
    'input', 'textarea', '[contenteditable]', '[data-lexical-editor]',
    '[class*="group/file-title"]', '[class*="file-title"]', '[class*="file-path"]', '[data-path]',
    '[data-testid="project-header"]', '[data-testid="project-selector-trigger"] span',
    '[data-testid="branch-pill-label"]',
    '[data-testid="conversation-row-sidebar"]', 'a[href^="/c/"]',
    '[data-testid="model-selector-trigger"]', '#fei-ag-controls',
    '#ag-live-metrics-pill', '#ag-live-metrics-tooltip', '#ag-ssh-sidebar-card',
    '#ag-remote-folder-modal', '.ag-proj-env-badge', '#ag-sidebar-add-remote-btn',
  ].join(',');

  const styleId = 'ag-custom-fonts';
  const attr = 'data-ag-preset';
  const legacyAttr = 'data-fei-ag-preset';

  const RE_HAS_CJK = /[\u4e00-\u9fa5]/;
  const RE_PURE_ALPHA = /^\s*[a-zA-Z]+\s*$/;
  const RE_HAS_ALPHA = /[a-zA-Z]/;
  const RE_FILES_CHANGED = /^(\d+)\s+files?\s+changed$/i;
  const RE_TOOLS = /^(\d+)\s+tools?$/i;
  const RE_DEMOTED = /^(\d+)\s+demoted$/i;
  const RE_EXCLUDED = /^(\d+)\s+excluded$/i;
  const RE_TOOLS_EXCLUDED = /^(\d+)\s+tools?\s+excluded$/i;
  const RE_ACTIVE_CONVS = /^(\d+)\s+active\s+conversations?$/i;
  const RE_SEE_ALL = /^See all\s*\((\d+)\)$/i;
  const RE_SHOW_BREAKDOWNS = /^Show\s+(\d+)\s+breakdowns?$/i;
  const RE_PERM_DELETE = /^Permanently delete\s+(.*)\s+including\s+(\d+)\s+active\s+conversations\.?$/i;
  const RE_WORKED_FOR = /^Worked for\s+(\d+[smhd])$/i;
  const RE_THOUGHT_FOR = /^Thought for\s+(\d+[smhd])$/i;
  const RE_USED_LIMIT = /^You have used (some|all|most) of your (weekly|5-hour|five-hour|daily) limit,?\s*it will fully refresh in (.*)\.?$/i;
  const RE_NOT_USED_LIMIT = /^You have not used any of your (weekly|5-hour|five-hour|daily) limit\.?$/i;
  const RE_ARIA_BRANCH = /^Branch, current:\s*(.*)$/i;
  const RE_ARIA_PROJECT = /^Select project, current:\s*(.*)$/i;
  const LIMIT_TYPE_MAP = {weekly: '每周', '5-hour': '5 小时', 'five-hour': '5 小时', daily: '每日'};

  function lookupDict(key) {
    return Object.prototype.hasOwnProperty.call(dictionary, key) && typeof dictionary[key] === 'string' ? dictionary[key] : undefined;
  }

  function computeTextTranslation(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let replacement = lookupDict(trimmed);
    if (replacement === undefined && trimmed.endsWith('.')) {
      const withoutDot = lookupDict(trimmed.slice(0, -1));
      if (withoutDot !== undefined) replacement = withoutDot.endsWith('。') ? withoutDot : withoutDot + '。';
    }
    if (replacement !== undefined) {
      if (RE_HAS_CJK.test(replacement) && RE_PURE_ALPHA.test(raw)) return replacement;
      return raw.replace(trimmed, replacement);
    }
    if (!RE_HAS_ALPHA.test(trimmed)) return null;
    const c0 = trimmed.charCodeAt(0);
    if (c0 >= 48 && c0 <= 57) {
      if (RE_FILES_CHANGED.test(trimmed)) return raw.replace(RE_FILES_CHANGED, '$1 个文件变更');
      if (RE_TOOLS.test(trimmed)) return raw.replace(RE_TOOLS, '$1 个工具');
      if (RE_DEMOTED.test(trimmed)) return raw.replace(RE_DEMOTED, '$1 项已降级');
      if (RE_EXCLUDED.test(trimmed)) return raw.replace(RE_EXCLUDED, '$1 项已排除');
      if (RE_TOOLS_EXCLUDED.test(trimmed)) return raw.replace(RE_TOOLS_EXCLUDED, '$1 个工具已排除');
      if (RE_ACTIVE_CONVS.test(trimmed)) return raw.replace(RE_ACTIVE_CONVS, '$1 个进行中的会话');
      return null;
    }
    const firstUpper = trimmed[0].toUpperCase();
    if (firstUpper === 'S') {
      if (RE_SEE_ALL.test(trimmed)) return raw.replace(RE_SEE_ALL, '查看全部 ($1)');
      if (RE_SHOW_BREAKDOWNS.test(trimmed)) return raw.replace(RE_SHOW_BREAKDOWNS, '展开明细 ($1 项)');
    } else if (firstUpper === 'P') {
      if (RE_PERM_DELETE.test(trimmed)) return raw.replace(RE_PERM_DELETE, '永久删除 $1 及 $2 个进行中的会话。');
    } else if (firstUpper === 'W') {
      if (RE_WORKED_FOR.test(trimmed)) return raw.replace(RE_WORKED_FOR, '已工作 $1');
    } else if (firstUpper === 'T') {
      if (RE_THOUGHT_FOR.test(trimmed)) return raw.replace(RE_THOUGHT_FOR, '已思考 $1');
    } else if (firstUpper === 'Y') {
      const mUsed = trimmed.match(RE_USED_LIMIT);
      if (mUsed) {
        const degree = {some: '部分', all: '全部', most: '大部分'}[mUsed[1].toLowerCase()] || mUsed[1];
        const type = LIMIT_TYPE_MAP[mUsed[2].toLowerCase()] || mUsed[2];
        const timeStr = mUsed[3].replace(/\.$/, '')
          .replace(/(\d+)\s*days?/gi, '$1 天').replace(/(\d+)\s*hours?/gi, '$1 小时')
          .replace(/(\d+)\s*minutes?/gi, '$1 分钟').replace(/(\d+)\s*seconds?/gi, '$1 秒')
          .replace(/,\s*/g, ' ').trim();
        return '您已消耗' + degree + type + '额度，将在 ' + timeStr + ' 后完全重置。';
      }
      const mNotUsed = trimmed.match(RE_NOT_USED_LIMIT);
      if (mNotUsed) return '您尚未消耗任何' + (LIMIT_TYPE_MAP[mNotUsed[1].toLowerCase()] || mNotUsed[1]) + '额度。';
    }
    return null;
  }

  // Kept for callers that expect the old string -> string helper
  const translated = text => computeTextTranslation(text) ?? text;

  const excluded = node => !!node?.closest?.(protectedSelector);

  function translateTextNode(node) {
    const currentVal = node.nodeValue;
    if (!currentVal) return;
    const rec = origTextMap.get(node);
    if (rec && rec.lastVal === currentVal && rec.sig === signature) return;
    const origRaw = rec && rec.lastVal === currentVal ? rec.origRaw : currentVal;
    const nextVal = computeTextTranslation(origRaw);
    if (nextVal !== null) {
      origTextMap.set(node, {origRaw, lastVal: nextVal, sig: signature});
      if (node.nodeValue !== nextVal) node.nodeValue = nextVal;
    } else if (rec && rec.lastVal === currentVal) {
      node.nodeValue = origRaw;
      origTextMap.delete(node);
    }
  }

  function translateSingleAttr(el, attrName, origDataAttr, resolver) {
    const cur = el.getAttribute(attrName);
    if (!cur) return;
    const savedOrig = el.getAttribute(origDataAttr);
    const savedLast = el.getAttribute(origDataAttr + '-last');
    const origVal = savedOrig && savedLast === cur ? savedOrig : cur;
    const trimmed = origVal.trim();
    const nextVal = resolver ? resolver(trimmed) : (lookupDict(trimmed) ?? null);
    if (typeof nextVal === 'string') {
      el.setAttribute(origDataAttr, origVal);
      el.setAttribute(origDataAttr + '-last', nextVal);
      if (cur !== nextVal) el.setAttribute(attrName, nextVal);
    } else if (savedOrig && savedLast === cur) {
      el.setAttribute(attrName, savedOrig);
      el.removeAttribute(origDataAttr);
      el.removeAttribute(origDataAttr + '-last');
    }
  }

  function translateElementAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    translateSingleAttr(el, 'title', 'data-ag-orig-title', null);
    translateSingleAttr(el, 'placeholder', 'data-ag-orig-placeholder', null);
    translateSingleAttr(el, 'aria-label', 'data-ag-orig-aria-label', atrim => {
      const hit = lookupDict(atrim);
      if (hit !== undefined) return hit;
      const mBranch = atrim.match(RE_ARIA_BRANCH);
      if (mBranch) {
        const bName = mBranch[1].trim();
        return '分支，当前：' + (bName === 'Select branch' ? '选择分支' : bName);
      }
      const mProj = atrim.match(RE_ARIA_PROJECT);
      if (mProj) {
        const pName = mProj[1].trim();
        return '选择项目，当前：' + (pName === 'No project' ? '未关联项目' : pName);
      }
      return null;
    });
  }

  const walkerFilter = {
    acceptNode(node) {
      if (node.nodeType === 1) {
        if (node.matches && node.matches(protectedSelector)) return NodeFilter.FILTER_REJECT;
        if (node.hasAttribute('title') || node.hasAttribute('aria-label') || node.hasAttribute('placeholder')) {
          translateElementAttrs(node);
        }
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  };

  function translateRoot(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (root.parentElement && !excluded(root.parentElement)) translateTextNode(root);
      return;
    }
    if (root.nodeType !== 1 || excluded(root)) return;
    if (root.hasAttribute('title') || root.hasAttribute('aria-label') || root.hasAttribute('placeholder')) {
      translateElementAttrs(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkerFilter);
    while (walker.nextNode()) translateTextNode(walker.currentNode);
  }

  function restoreTranslations(root = document.body) {
    if (!root) return;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const rec = origTextMap.get(node);
        if (rec && node.nodeValue === rec.lastVal) {
          node.nodeValue = rec.origRaw;
          origTextMap.delete(node);
        }
      }
      for (const el of root.querySelectorAll('[data-ag-orig-title], [data-ag-orig-placeholder], [data-ag-orig-aria-label]')) {
        for (const key of ['title', 'placeholder', 'aria-label']) {
          const o = `data-ag-orig-${key}`;
          if (!el.hasAttribute(o)) continue;
          if (el.getAttribute(key) === el.getAttribute(o + '-last')) el.setAttribute(key, el.getAttribute(o));
          el.removeAttribute(o);
          el.removeAttribute(o + '-last');
        }
      }
    } catch {}
  }

  // Dirty-root incremental translation: MutationObserver feeds roots; sync() flushes them.
  const dirtyI18nRoots = new Set();
  let needFullI18nScan = true;

  function flushI18n() {
    if (!state.localize) {
      dirtyI18nRoots.clear();
      return;
    }
    if (needFullI18nScan || dirtyI18nRoots.size > 200) {
      needFullI18nScan = false;
      dirtyI18nRoots.clear();
      translateRoot(document.body);
      return;
    }
    if (dirtyI18nRoots.size === 0) return;
    const roots = [...dirtyI18nRoots];
    const rootSet = new Set(roots);
    dirtyI18nRoots.clear();
    for (const r of roots) {
      if (!r || !r.isConnected) continue;
      let covered = false;
      for (let p = r.parentNode; p; p = p.parentNode) if (rootSet.has(p)) { covered = true; break; }
      if (!covered) {
        try { translateRoot(r); } catch {}
      }
    }
  }

  function setState(next) {
    state = {...state, ...next};
    if (next.preset) {
      try {
        if (next.preset === 'native') Storage.prototype.removeItem.call(localStorage, 'theme-color-flavor');
        else Storage.prototype.setItem.call(localStorage, 'theme-color-flavor', next.preset);
      } catch {}
    }
    if (!state.localize) restoreTranslations();
    else needFullI18nScan = true;
    sync();
  }

  // --- §5.6 交互式远程 SSH 目录浏览器弹窗 (支持在任意窗口直接浏览远程服务器目录并添加为侧边栏项目) ---
  async function callRemoteRpcJson(methodName, payloadObj = {}) {
    const fn = window.__ag_orig_fetch || window.fetch;
    const res = await fn(`https://127.0.0.1:58282/exa.language_server_pb.LanguageServerService/${methodName}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-ag-force-target': 'remote',
      },
      body: JSON.stringify(payloadObj),
    });
    if (!res.ok) {
      throw new Error(`RPC ${methodName} failed (${res.status})`);
    }
    return await res.json();
  }

  function openRemoteFolderPickerModal(initialPath) {
    let modal = document.getElementById('ag-remote-folder-modal');
    if (modal) modal.remove();

    const homeDir = sshState.remoteHomeDir || '/home/user';
    let currentPath = initialPath || homeDir;
    let showHidden = false;
    const hostName = sshState.remoteHostname || 'remote-host';

    modal = document.createElement('div');
    modal.id = 'ag-remote-folder-modal';
    modal.className = 'ag-remote-modal-backdrop';
    modal.innerHTML = [
      '<div class="ag-remote-modal-dialog" role="dialog" aria-label="打开远程 SSH 目录">',
      '  <div class="ag-remote-modal-hdr">',
      '    <div class="ag-remote-modal-title-row">',
      `      <span class="ag-remote-modal-badge">SSH · ${hostName}</span>`,
      '      <span class="ag-remote-modal-title">选择远程服务器目录添加到侧边栏</span>',
      '    </div>',
      '    <button type="button" class="ag-remote-modal-close" id="ag-remote-modal-close" title="关闭">✕</button>',
      '  </div>',
      '  <div class="ag-remote-modal-Quick">',
      '    <span class="ag-remote-quick-lbl">常用路径:</span>',
      `    <button type="button" class="ag-remote-quick-chip" data-path="${homeDir}">${homeDir}</button>`,
      '    <button type="button" class="ag-remote-quick-chip" data-path="/develop">/develop</button>',
      '    <button type="button" class="ag-remote-quick-chip" data-path="/data">/data</button>',
      '    <button type="button" class="ag-remote-quick-chip" data-path="/tmp">/tmp</button>',
      '    <button type="button" class="ag-remote-quick-chip" data-path="/">/</button>',
      '  </div>',
      '  <div class="ag-remote-modal-pathbar">',
      '    <button type="button" class="ag-ssh-btn ag-ssh-btn-secondary" id="ag-remote-up-btn" title="返回上级目录">⬆️ 上级</button>',
      '    <input type="text" id="ag-remote-path-input" class="ag-remote-path-input" spellcheck="false" />',
      '    <button type="button" class="ag-ssh-btn ag-ssh-btn-secondary" id="ag-remote-go-btn">跳转</button>',
      '    <label class="ag-remote-hidden-lbl"><input type="checkbox" id="ag-remote-hidden-chk" />显示隐藏项</label>',
      '  </div>',
      '  <div class="ag-remote-modal-list" id="ag-remote-dir-list"></div>',
      '  <div class="ag-remote-modal-ftr">',
      '    <span class="ag-remote-modal-status" id="ag-remote-modal-status"></span>',
      '    <div class="ag-remote-modal-ftr-btns">',
      '      <button type="button" class="ag-ssh-btn ag-ssh-btn-secondary" id="ag-remote-cancel-btn">取消</button>',
      '      <button type="button" class="ag-ssh-btn ag-ssh-btn-primary" id="ag-remote-confirm-btn">✅ 添加当前目录到项目侧栏</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');

    document.body.appendChild(modal);

    const pathInput = modal.querySelector('#ag-remote-path-input');
    const listEl = modal.querySelector('#ag-remote-dir-list');
    const statusEl = modal.querySelector('#ag-remote-modal-status');
    const hiddenChk = modal.querySelector('#ag-remote-hidden-chk');
    const confirmBtn = modal.querySelector('#ag-remote-confirm-btn');

    const normalizeDirPath = (p) => {
      let s = String(p || '/').trim();
      if (!s.startsWith('/')) s = '/' + s;
      if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '');
      return s || '/';
    };

    const loadDirectory = async (targetPath) => {
      currentPath = normalizeDirPath(targetPath);
      pathInput.value = currentPath;
      statusEl.textContent = `正在读取 ${hostName}:${currentPath} …`;
      listEl.innerHTML = '<div class="ag-remote-list-empty">正在读取远程目录…</div>';

      try {
        const uriNoSlash = currentPath === '/' ? 'file:///' : `file://${currentPath}`;
        const res = await callRemoteRpcJson('ReadDir', {uri: uriNoSlash});
        const entries = Array.isArray(res?.entries) ? res.entries : [];
        const dirs = [];
        for (const e of entries) {
          const isDirectory =
            e?.isDir === true ||
            e?.fileType === 'FILE_TYPE_DIRECTORY' ||
            e?.fileType === 2;
          if (!isDirectory) continue;
          const rawPath = e?.uri
            ? decodeURIComponent(String(e.uri).replace(/^file:\/\//, ''))
            : '';
          const name =
            e?.name ||
            (rawPath ? rawPath.replace(/\/+$/, '').split('/').pop() : '');
          if (!name || name === '.' || name === '..') continue;
          if (!showHidden && name.startsWith('.')) continue;
          const childPath =
            rawPath || (currentPath === '/' ? `/${name}` : `${currentPath}/${name}`);
          dirs.push({name, childPath});
        }
        dirs.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

        listEl.innerHTML = '';
        if (dirs.length === 0) {
          listEl.innerHTML = '<div class="ag-remote-list-empty">当前目录下无子文件夹（可直接点击下方按钮添加此目录）</div>';
        } else {
          for (const d of dirs) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ag-remote-dir-row ag-remote-modal-item';
            row.innerHTML = [
              '<span class="ag-remote-dir-icon">📁</span>',
              `<span class="ag-remote-dir-name">${d.name}</span>`,
              `<span class="ag-remote-dir-sub">${d.childPath}</span>`,
            ].join('');
            row.addEventListener('click', () => loadDirectory(d.childPath));
            listEl.appendChild(row);
          }
        }
        statusEl.textContent = `已加载 ${dirs.length} 个子目录 · 当前选中: ${currentPath}`;
      } catch (err) {
        listEl.innerHTML = `<div class="ag-remote-list-empty">读取失败: ${err.message}</div>`;
        statusEl.textContent = '请检查目录权限或路径是否存在';
      }
    };

    modal.querySelector('#ag-remote-modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#ag-remote-cancel-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    modal.querySelector('#ag-remote-up-btn').addEventListener('click', () => {
      if (currentPath === '/') return;
      const idx = currentPath.lastIndexOf('/');
      const parent = idx <= 0 ? '/' : currentPath.slice(0, idx);
      loadDirectory(parent);
    });

    modal.querySelector('#ag-remote-go-btn').addEventListener('click', () => {
      loadDirectory(pathInput.value);
    });

    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadDirectory(pathInput.value);
      } else if (e.key === 'Escape') {
        modal.remove();
      }
    });

    hiddenChk.addEventListener('change', () => {
      showHidden = hiddenChk.checked;
      loadDirectory(currentPath);
    });

    for (const chip of modal.querySelectorAll('.ag-remote-quick-chip')) {
      chip.addEventListener('click', () => {
        loadDirectory(chip.getAttribute('data-path') || homeDir);
      });
    }

    confirmBtn.addEventListener('click', async () => {
      const targetDir = normalizeDirPath(pathInput.value || currentPath);
      confirmBtn.disabled = true;
      confirmBtn.textContent = '正在添加远程项目…';
      statusEl.textContent = `正在向 ${hostName} 注册项目 ${targetDir} …`;
      try {
        const folderUri = `file://${targetDir}`;
        const normTargetUri = folderUri.replace(/\/+$/, '');
        const map = sshState.projectEnvMap || {};
        let existingProjId = '';
        let hasSameName = false;
        const pathParts = targetDir.split('/').filter(Boolean);
        let folderName = pathParts[pathParts.length - 1] || hostName;
        for (const [pid, info] of Object.entries(map)) {
          if (!info) continue;
          const normInfoUri = (info.uri || '').replace(/\/+$/, '');
          if (info.env === 'remote' && normInfoUri && normInfoUri === normTargetUri) {
            existingProjId = pid;
            break;
          }
          if (info.name === folderName) {
            hasSameName = true;
          }
        }
        if (hasSameName && pathParts.length >= 2) {
          folderName = `${pathParts[pathParts.length - 2]}/${folderName}`;
        }

        let targetProjId = existingProjId;
        if (!targetProjId) {
          targetProjId =
            typeof crypto?.randomUUID === 'function'
              ? crypto.randomUUID()
              : `remote-${Date.now()}`;
          const resolvedFolder = await callRemoteRpcJson('ResolveFolder', {folderUri}).catch(() => null);
          const isGitRepo =
            resolvedFolder?.resourceType === 'FOLDER_TYPE_GIT_FOLDER' ||
            resolvedFolder?.resourceType === 2 ||
            resolvedFolder?.vcsType === 'VCS_TYPE_GIT';
          await callRemoteRpcJson('CreateProject', {
            project: {
              id: targetProjId,
              name: folderName,
              projectResources: {
                resources: [isGitRepo ? {gitFolder: {folderUri}} : {folderUri}],
              },
              isWorkspaceOnly: true,
            },
          });
          sshState.projectEnvMap = {
            ...(sshState.projectEnvMap || {}),
            [targetProjId]: {
              env: 'remote',
              name: folderName,
              uri: folderUri,
              host: hostName,
            },
          };
          if (Array.isArray(sshState.remoteProjectIds) && !sshState.remoteProjectIds.includes(targetProjId)) {
            sshState.remoteProjectIds.push(targetProjId);
          }
        }

        sendSshAction({action: 'refresh-projects'});
        modal.remove();
        window.__ag_active_env = 'remote';
        if (targetProjId) {
          window.__ag_active_project_id = targetProjId;
          const nextUrl = new URL(location.origin + '/');
          nextUrl.searchParams.set('section', targetProjId);
          history.pushState({}, '', nextUrl);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
        setTimeout(() => decorateSidebarProjects(), 250);
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '✅ 添加当前目录到项目侧栏';
        statusEl.textContent = `创建项目失败: ${err.message}`;
      }
    });

    loadDirectory(currentPath);
    return modal;
  }

  window.__ag_open_remote_folder_picker = openRemoteFolderPickerModal;

  // --- §5.7 侧边栏统一项目列表环境徽章 ([本机] / [SSH · host] / [☁️ 云端]) 与顶栏控制卡片 ---
  function decorateSidebarProjects() {
    if (disposed) return;
    const sidebar = document.querySelector('[aria-label="Sidebar"]');
    if (!sidebar) return;

    const filterVal = sshState.envFilter || 'all';
    if (document.documentElement.getAttribute('data-ag-env-filter') !== filterVal) {
      document.documentElement.setAttribute('data-ag-env-filter', filterVal);
    }

    // Add quick "🌐+" remote folder button next to the native "+" button on Projects header
    const addLocalProjBtn = sidebar.querySelector('[data-testid="sidebar-add-project-button"]');
    if (addLocalProjBtn && addLocalProjBtn.parentElement) {
      addLocalProjBtn.title = '打开并添加本机 Mac 目录到项目列表';
      if (!addLocalProjBtn.dataset.agHooked) {
        addLocalProjBtn.dataset.agHooked = '1';
        addLocalProjBtn.addEventListener('click', () => {
          window.__ag_use_remote_picker = false;
        }, true);
      }

      let addRemoteBtn = document.getElementById('ag-sidebar-add-remote-btn');
      if (!addRemoteBtn) {
        addRemoteBtn = document.createElement('button');
        addRemoteBtn.type = 'button';
        addRemoteBtn.id = 'ag-sidebar-add-remote-btn';
        addRemoteBtn.className = 'ag-sidebar-add-remote-btn';
        addRemoteBtn.textContent = '🌐+';
        addRemoteBtn.title = `浏览并添加远程 SSH (${sshState.remoteHostname || 'remote-host'}) 目录到项目列表`;
        addRemoteBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openRemoteFolderPickerModal();
        });
        addLocalProjBtn.parentElement.insertBefore(addRemoteBtn, addLocalProjBtn);
      }
    }

    const firstDrop = sidebar.querySelector('div[data-sidebar-section-drop-id]');
    const listContainer = firstDrop?.parentElement;
    if (listContainer) {
      let currentSectionEnv = '';
      let currentSectionPid = '';
      for (const child of listContainer.children) {
        if (!(child instanceof HTMLElement)) continue;
        const dropId = child.getAttribute('data-sidebar-section-drop-id');
        if (dropId) {
          if (dropId === 'main-section-header' || dropId === 'standalone' || dropId === 'pinned' || dropId.startsWith('convgroup:')) {
            currentSectionEnv = '';
            currentSectionPid = '';
            child.removeAttribute('data-ag-env');
            continue;
          }
          currentSectionPid = dropId;
          const info = resolveProjectEnvInfo(dropId);
          currentSectionEnv = info.env || 'local';
          if (child.getAttribute('data-ag-env') !== currentSectionEnv) {
            child.setAttribute('data-ag-env', currentSectionEnv);
          }

          const headerBtn = child.querySelector('button[data-testid="project-header"]');
          if (headerBtn) {
            if (headerBtn.getAttribute('data-ag-env') !== currentSectionEnv) {
              headerBtn.setAttribute('data-ag-env', currentSectionEnv);
            }
            if (headerBtn.getAttribute('data-ag-project-id') !== dropId) {
              headerBtn.setAttribute('data-ag-project-id', dropId);
            }

            const cleanPath = (info.uri || '').replace(/^file:\/\//, '');
            const wantTitle =
              currentSectionEnv === 'cloud'
                ? `☁️ 官方云端项目 (${info.name || dropId})`
                : currentSectionEnv === 'remote'
                  ? `🌐 远程 SSH 项目 (${info.host || 'remote-host'}:${cleanPath || sshState.remoteHomeDir || '/home/user'})`
                  : `💻 本机 Mac 项目 (${cleanPath || '~'})`;
            if (headerBtn.getAttribute('title') !== wantTitle) {
              headerBtn.setAttribute('title', wantTitle);
            }

            const labelContainer = headerBtn.firstElementChild;
            if (labelContainer) {
              let badge = labelContainer.querySelector('.ag-proj-env-badge');
              if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ag-proj-env-badge';
                labelContainer.appendChild(badge);
              }
              if (badge.getAttribute('data-env') !== currentSectionEnv) {
                badge.setAttribute('data-env', currentSectionEnv);
              }
              const wantBadgeText =
                currentSectionEnv === 'cloud'
                  ? '☁️ 云端'
                  : currentSectionEnv === 'remote'
                    ? `SSH · ${info.host || 'remote-host'}`
                    : '本机';
              if (badge.textContent !== wantBadgeText) {
                badge.textContent = wantBadgeText;
              }
            }
          }
        } else {
          const rowSecId = child.getAttribute('data-sidebar-section-id') || currentSectionPid;
          if (
            rowSecId &&
            rowSecId !== 'main-section-header' &&
            rowSecId !== 'standalone' &&
            rowSecId !== 'pinned' &&
            !rowSecId.startsWith('convgroup:')
          ) {
            const rowInfo = resolveProjectEnvInfo(rowSecId);
            const rowEnv = rowInfo.env || currentSectionEnv || 'local';
            if (child.getAttribute('data-ag-env') !== rowEnv) {
              child.setAttribute('data-ag-env', rowEnv);
            }
            if (child.getAttribute('data-ag-project-id') !== rowSecId) {
              child.setAttribute('data-ag-project-id', rowSecId);
            }
          } else {
            const rowCid = child.getAttribute('data-sidebar-row-id') || '';
            const cascadeMap = sshState.cascadeProjectMap || {};
            const mappedPid = rowCid ? cascadeMap[rowCid] || '' : '';
            const isRemRow =
              (mappedPid && resolveProjectEnvInfo(mappedPid).env === 'remote') ||
              (rowCid && (sshState.remoteCascadeIdsSet ? sshState.remoteCascadeIdsSet.has(rowCid) : (Array.isArray(sshState.remoteCascadeIds) && sshState.remoteCascadeIds.includes(rowCid))));
            if (rowCid) {
              const rowEnv = isRemRow ? 'remote' : 'local';
              if (child.getAttribute('data-ag-env') !== rowEnv) {
                child.setAttribute('data-ag-env', rowEnv);
              }
              if (mappedPid && child.getAttribute('data-ag-project-id') !== mappedPid) {
                child.setAttribute('data-ag-project-id', mappedPid);
              }
            } else {
              child.removeAttribute('data-ag-env');
            }
          }
        }
      }
    }

    // Decorate composer project selector items if open, disambiguating duplicate names by occurrence order
    const seenNameCounts = new Map();
    for (const item of document.querySelectorAll('[data-testid="project-selector-item"]')) {
      if (!(item instanceof HTMLElement)) continue;
      let pid = item.getAttribute('data-ag-project-id') || '';
      if (!pid) {
        const rawLabel = (item.textContent || '').trim();
        const matches = findMatchingProjectIdsByName(rawLabel);
        if (matches.length === 1) {
          pid = matches[0];
        } else if (matches.length > 1) {
          const count = seenNameCounts.get(rawLabel) || 0;
          seenNameCounts.set(rawLabel, count + 1);
          pid = matches[Math.min(count, matches.length - 1)];
        }
      }
      if (pid) {
        const info = resolveProjectEnvInfo(pid);
        item.setAttribute('data-ag-project-id', pid);
        item.setAttribute('data-ag-env', info.env || 'local');
      }
    }
  }

  function renderSshSidebarCard() {
    if (disposed) return null;
    const newConvBtn =
      document.querySelector('[data-testid="new-conversation-button"]') ||
      document.querySelector('[aria-label="Sidebar"] a[href="/"]') ||
      document.querySelector('[aria-label="Sidebar"]')?.firstElementChild?.firstElementChild;
    if (!newConvBtn || !newConvBtn.parentElement) return null;
    const container = newConvBtn.parentElement;

    let card = document.getElementById('ag-ssh-sidebar-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'ag-ssh-sidebar-card';
      card.innerHTML = [
        '<div class="ag-ssh-hdr">',
        '  <div class="ag-ssh-title-wrap">',
        '    <span class="ag-ssh-dot" id="ag-ssh-dot"></span>',
        '    <span class="ag-ssh-env-title" id="ag-ssh-env-title"></span>',
        '  </div>',
        '  <span class="ag-ssh-badge" id="ag-ssh-badge"></span>',
        '</div>',
        '<div class="ag-ssh-env-filter-bar" id="ag-ssh-env-filter-bar" role="group" aria-label="工作区环境筛选">',
        '  <button type="button" class="ag-ssh-filter-pill" data-env-filter="all">全部</button>',
        '  <button type="button" class="ag-ssh-filter-pill" data-env-filter="local">💻 本机</button>',
        '  <button type="button" class="ag-ssh-filter-pill" data-env-filter="remote">🌐 远程 SSH</button>',
        '</div>',
        '<div class="ag-ssh-route-row">',
        '  <span class="ag-ssh-route-lbl">线路</span>',
        '  <select id="ag-ssh-mode-select" aria-label="SSH 远程线路模式">',
        '    <option value="auto">⚡ 智能双路 (直连 → 隧道)</option>',
        '    <option value="direct">🚀 直连</option>',
        '    <option value="tunnel">🛡️ 跳板隧道</option>',
        '    <option value="local">💻 仅本机 (暂停隧道)</option>',
        '  </select>',
        '  <button type="button" class="ag-ssh-btn ag-ssh-btn-icon" id="ag-ssh-refresh-btn" title="重探双路延迟并刷新本机+远程项目列表">↻</button>',
        '</div>',
        '<div class="ag-ssh-actions">',
        '  <button type="button" class="ag-ssh-btn ag-ssh-btn-primary" id="ag-ssh-primary-btn"></button>',
        '  <button type="button" class="ag-ssh-btn ag-ssh-btn-secondary" id="ag-ssh-secondary-btn"></button>',
        '</div>',
      ].join('');

      const filterBar = card.querySelector('#ag-ssh-env-filter-bar');
      filterBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-env-filter]');
        if (!btn) return;
        e.stopPropagation();
        const nextFilter = btn.getAttribute('data-env-filter') || 'all';
        sshState.envFilter = nextFilter;
        document.documentElement.setAttribute('data-ag-env-filter', nextFilter);
        renderSshSidebarCard();
        decorateSidebarProjects();
        sendSshAction({action: 'set-env-filter', filter: nextFilter});
      });

      const modeSelect = card.querySelector('#ag-ssh-mode-select');
      modeSelect.addEventListener('change', e => {
        e.stopPropagation();
        const nextMode = modeSelect.value;
        state.sshMode = nextMode;
        sendSshAction({action: 'set-mode', mode: nextMode});
      });

      const primaryBtn = card.querySelector('#ag-ssh-primary-btn');
      primaryBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (sshState.mode === 'local') {
          sendSshAction({action: 'set-mode', mode: 'auto'});
        }
        openRemoteFolderPickerModal();
      });

      const secondaryBtn = card.querySelector('#ag-ssh-secondary-btn');
      secondaryBtn.addEventListener('click', e => {
        e.stopPropagation();
        window.__ag_use_remote_picker = false;
        const addProjBtn = document.querySelector('[data-testid="sidebar-add-project-button"]');
        if (addProjBtn) {
          addProjBtn.click();
        } else {
          const homeBtn = document.querySelector('[data-testid="new-conversation-button"]');
          if (homeBtn) homeBtn.click();
          setTimeout(() => {
            window.__ag_use_remote_picker = false;
            document.querySelector('[data-testid="sidebar-add-project-button"]')?.click();
          }, 150);
        }
      });

      const refreshBtn = card.querySelector('#ag-ssh-refresh-btn');
      refreshBtn.addEventListener('click', e => {
        e.stopPropagation();
        sendSshAction({action: 'reconnect'});
        sendSshAction({action: 'refresh-projects'});
      });

      container.insertBefore(card, newConvBtn);
    } else if (card.parentElement !== container) {
      container.insertBefore(card, newConvBtn);
    }

    const activeEnv = window.__ag_active_env || 'local';
    card.setAttribute('data-remote', activeEnv === 'remote' ? '1' : '0');
    card.setAttribute('data-status', sshState.status || 'idle');

    const dot = card.querySelector('#ag-ssh-dot');
    const titleEl = card.querySelector('#ag-ssh-env-title');
    const badgeEl = card.querySelector('#ag-ssh-badge');
    const modeSelect = card.querySelector('#ag-ssh-mode-select');
    const primaryBtn = card.querySelector('#ag-ssh-primary-btn');
    const secondaryBtn = card.querySelector('#ag-ssh-secondary-btn');
    if (modeSelect) {
      // Show which ssh alias each route uses as a tooltip, without putting aliases in the code.
      for (const opt of modeSelect.options) {
        const host = sshState.routeHosts?.[opt.value];
        opt.title = host ? `ssh ${host}` : '';
      }
    }

    if (dot) {
      dot.className = 'ag-ssh-dot ' + (
        sshState.status === 'connected'
          ? 'is-remote-ok'
          : (sshState.mode === 'local' ? 'is-local' : 'is-warn')
      );
    }

    if (titleEl) {
      const hostLabel = sshState.remoteHostname || 'remote-host';
      const wantTitle =
        sshState.mode === 'local'
          ? '本机 macOS 工作区'
          : `本机 Mac + SSH · ${hostLabel}`;
      if (titleEl.textContent !== wantTitle) titleEl.textContent = wantTitle;
    }

    if (badgeEl) {
      let wantBadge = '';
      if (sshState.status === 'connected' && sshState.activeHost) {
        const rtt = sshState.latencyMs > 0 ? ` · ${sshState.latencyMs}ms` : '';
        wantBadge = `${sshState.activeHost}${rtt}`;
        badgeEl.title = `已连接远程开发机 ${sshState.remoteHostname || 'remote-host'} (${sshState.activeHost}${rtt})`;
      } else if (sshState.status === 'connecting' || sshState.status === 'reconnecting') {
        wantBadge = '隧道连接中…';
        badgeEl.title = '正在探测并连接远程 SSH 开发机…';
      } else if (sshState.mode === 'local') {
        wantBadge = '仅本机';
        badgeEl.title = '';
      } else if (sshState.status === 'error') {
        wantBadge = '连接异常';
        badgeEl.title = sshState.lastError || '';
      } else {
        wantBadge = '待命';
        badgeEl.title = '';
      }
      if (badgeEl.textContent !== wantBadge) badgeEl.textContent = wantBadge;
    }

    const localCount = Array.isArray(sshState.localProjectIds) ? sshState.localProjectIds.length : 0;
    const remoteCount = Array.isArray(sshState.remoteProjectIds) ? sshState.remoteProjectIds.length : 0;
    const curFilter = sshState.envFilter || 'all';
    for (const pill of card.querySelectorAll('.ag-ssh-filter-pill')) {
      const f = pill.getAttribute('data-env-filter');
      pill.classList.toggle('is-active', f === curFilter);
      if (f === 'all') {
        const txt = localCount + remoteCount > 0 ? `全部 (${localCount + remoteCount})` : '全部';
        if (pill.textContent !== txt) pill.textContent = txt;
      } else if (f === 'local') {
        const txt = localCount > 0 ? `💻 本机 (${localCount})` : '💻 本机';
        if (pill.textContent !== txt) pill.textContent = txt;
      } else if (f === 'remote') {
        const txt = remoteCount > 0 ? `🌐 远程 (${remoteCount})` : '🌐 远程 SSH';
        if (pill.textContent !== txt) pill.textContent = txt;
      }
    }

    if (modeSelect && document.activeElement !== modeSelect) {
      const targetVal = sshState.mode || state.sshMode || 'auto';
      if (modeSelect.value !== targetVal) modeSelect.value = targetVal;
    }

    if (primaryBtn) {
      const wantPrimary = '🌐+ 远程目录';
      if (primaryBtn.textContent !== wantPrimary) primaryBtn.textContent = wantPrimary;
      primaryBtn.title = `浏览远程服务器 ${sshState.remoteHostname || 'remote-host'}:${sshState.remoteHomeDir || '/home/user'} 并添加到同一侧边栏`;
    }

    if (secondaryBtn) {
      secondaryBtn.style.display = 'inline-flex';
      const wantSecondary = '📁+ 本机目录';
      if (secondaryBtn.textContent !== wantSecondary) secondaryBtn.textContent = wantSecondary;
      secondaryBtn.title = '打开本机 macOS Finder 选择目录并添加到同一侧边栏';
    }

    return card;
  }

  function updateSettingsSshControls() {
    const control = document.getElementById('fei-ag-controls');
    if (!control) return;
    const sshSel = control.querySelector('#fei-ag-ssh-select');
    if (sshSel && document.activeElement !== sshSel) {
      sshSel.value = sshState.mode || state.sshMode || 'auto';
    }
    const sshBtn = control.querySelector('#fei-ag-ssh-switch-btn');
    if (sshBtn) {
      sshBtn.textContent = '🌐 打开远程 SSH 目录';
    }
  }

  function controls() {
    const settings = document.querySelector('.settings-modal-container');
    if (!settings) return;
    const heading = [...settings.querySelectorAll('h2')].find(el => ['Appearance', '外观'].includes(el.textContent.trim()));
    if (!heading || !heading.getClientRects().length) return;
    const header = heading.parentElement?.parentElement?.parentElement;
    if (!header) return;
    let control = document.getElementById('fei-ag-controls');
    if (!control) {
      control = document.createElement('section');
      control.id = 'fei-ag-controls';
      control.setAttribute('aria-label', '界面补丁');
      const label = document.createElement('label');
      label.append('配色');
      const select = document.createElement('select');
      select.id = 'fei-ag-preset-select';
      for (const [value, name] of [['high-contrast','高对比版'],['claude-desktop-purewhite','Claude Desktop 净白'],['vintage-deep','复古纸色'],['native','原生主题（不覆盖）']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
      }
      select.addEventListener('change', () => setState({preset: select.value}));
      label.append(select); control.append(label);
      const localeLabel = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.id = 'fei-ag-localize'; checkbox.type = 'checkbox';
      checkbox.addEventListener('change', () => setState({localize: checkbox.checked}));
      localeLabel.append(checkbox, '常用界面汉化'); control.append(localeLabel);

      const sshLabel = document.createElement('label');
      sshLabel.append('SSH 远程');
      const sshSelect = document.createElement('select');
      sshSelect.id = 'fei-ag-ssh-select';
      for (const [value, name] of [
        ['auto', '智能双路 (直连 → 隧道)'],
        ['direct', '直连'],
        ['tunnel', '跳板隧道'],
        ['local', '仅本机'],
      ]) {
        const option = document.createElement('option'); option.value = value; option.textContent = name; sshSelect.append(option);
      }
      sshSelect.addEventListener('change', () => {
        state.sshMode = sshSelect.value;
        sendSshAction({action: 'set-mode', mode: sshSelect.value});
      });
      sshLabel.append(sshSelect);
      control.append(sshLabel);

      const sshSwitchBtn = document.createElement('button');
      sshSwitchBtn.type = 'button';
      sshSwitchBtn.id = 'fei-ag-ssh-switch-btn';
      sshSwitchBtn.className = 'ag-ssh-btn ag-ssh-btn-primary';
      sshSwitchBtn.addEventListener('click', () => {
        openRemoteFolderPickerModal();
      });
      control.append(sshSwitchBtn);

      header.after(control);
    }
    control.querySelector('#fei-ag-preset-select').value = state.preset;
    control.querySelector('#fei-ag-localize').checked = state.localize;
    updateSettingsSshControls();
  }

  // --- §5.5 模型名称同行实时指标栏（TPS / TTFT / 256k 上下文水位 / Token 消耗） ---
  function extractCascadeId() {
    try {
      const m = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      if (m) return m[1];
      const q = new URLSearchParams(window.location.search).get('cascadeId');
      if (q && /^[0-9a-f-]{36}$/i.test(q)) return q;
    } catch {}
    return '';
  }

  function ensureMetricsTooltip() {
    let tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt && document.body) {
      tt = document.createElement('div');
      tt.id = 'ag-live-metrics-tooltip';
      document.body.appendChild(tt);
    } else if (tt && tt.parentElement !== document.body && document.body) {
      document.body.appendChild(tt);
    }
    return tt;
  }

  const MIDDLE_MIN_WIDTH_PX = 150;

  function findFooterRow(box) {
    if (!box) return null;
    const rows = box.querySelectorAll('div.flex.w-full.items-center.justify-between');
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.querySelector('[data-testid="model-selector-trigger"], [data-testid="send-button"]')) {
        return r;
      }
    }
    return rows[rows.length - 1] || null;
  }

  function measureNaturalLeftWidth(leftGroup) {
    let w = 0;
    for (let i = 0; i < leftGroup.children.length; i++) {
      const ch = leftGroup.children[i];
      if (ch.id === 'ag-live-metrics-pill') continue;
      const cw = Math.max(ch.offsetWidth || 0, ch.scrollWidth || 0);
      if (cw > 0) w += cw;
    }
    return w;
  }

  function ensureMetricsPill(forceLayout = false) {
    if (window.__ag_pill_resize_observer) {
      try { window.__ag_pill_resize_observer.disconnect(); } catch {}
      window.__ag_pill_resize_observer = null;
    }
    if (!state.metrics) {
      const existing = document.getElementById('ag-live-metrics-pill');
      if (existing) existing.style.display = 'none';
      return null;
    }
    const box = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!box) return null;
    const bottomRow = findFooterRow(box);
    if (!bottomRow || !bottomRow.children[0]) return null;
    const leftGroup = bottomRow.children[0];
    const rightGroup = bottomRow.children[1] || null;

    if (bottomRow.classList.contains('ag-footer-row-wrap')) {
      bottomRow.classList.remove('ag-footer-row-wrap');
    }
    if (leftGroup.style.flex) leftGroup.style.removeProperty('flex');
    if (rightGroup && rightGroup.style.flex) rightGroup.style.removeProperty('flex');

    let pill = document.getElementById('ag-live-metrics-pill');
    if (pill && (pill.getAttribute('data-v') !== '3' || pill.classList.contains('ag-pill-middle') || pill.classList.contains('ag-pill-wrapped'))) {
      pill.classList.remove('ag-pill-middle', 'ag-pill-wrapped');
    }
    let isNewPill = false;
    if (!pill) {
      isNewPill = true;
      pill = document.createElement('div');
      pill.id = 'ag-live-metrics-pill';
      pill.setAttribute('data-v', '3');
      pill.innerHTML = '<span id="ag-live-metrics-text"></span>';
      pill.addEventListener('mouseenter', () => {
        const tt = ensureMetricsTooltip();
        if (!tt || !tt.innerHTML) return;
        const r = pill.getBoundingClientRect();
        const ttWidth = Math.min(440, Math.max(370, tt.offsetWidth || 400));
        const left = Math.max(12, Math.min(r.left, window.innerWidth - ttWidth - 16));
        const bottomPx = Math.min(window.innerHeight - r.top + 8, window.innerHeight - (tt.offsetHeight || 220) - 12);
        tt.style.left = left + 'px';
        tt.style.bottom = Math.max(8, bottomPx) + 'px';
        tt.setAttribute('data-visible', '1');
      });
      pill.addEventListener('mouseleave', () => {
        const tt = document.getElementById('ag-live-metrics-tooltip');
        if (tt) tt.removeAttribute('data-visible');
      });
    }

    if (observedBottomRow !== bottomRow && typeof ResizeObserver !== 'undefined') {
      metricsResizeObserver?.disconnect();
      observedBottomRow = bottomRow;
      window.__ag_last_row_width = -1;
      metricsResizeObserver = new ResizeObserver(() => {
        if (disposed || window.__ag_metrics_raf) return;
        window.__ag_metrics_raf = requestAnimationFrame(() => {
          window.__ag_metrics_raf = 0;
          const w = bottomRow.clientWidth || 0;
          if (w > 0 && Math.abs(w - (window.__ag_last_row_width || 0)) >= 1) {
            window.__ag_last_row_width = w;
            ensureMetricsPill(true);
          }
        });
      });
      metricsResizeObserver.observe(bottomRow);
    }

    const isMountedHere =
      pill.parentElement === leftGroup || (bottomRow.parentElement && pill.parentElement === bottomRow.parentElement);
    if (!forceLayout && !isNewPill && isMountedHere) {
      return pill;
    }

    const rowW = bottomRow.clientWidth || 0;
    window.__ag_last_row_width = rowW;
    const leftW = measureNaturalLeftWidth(leftGroup);
    const rightW = rightGroup ? (rightGroup.offsetWidth || 0) : 0;
    const availMiddleW = rowW - leftW - rightW - 14;
    const useBottomRow = rowW > 0 && availMiddleW < MIDDLE_MIN_WIDTH_PX;
    const rowMode = useBottomRow ? 'bottom' : 'middle';

    if (bottomRow.getAttribute('data-ag-row-mode') !== rowMode) {
      bottomRow.setAttribute('data-ag-row-mode', rowMode);
    }
    if (pill.getAttribute('data-ag-row-mode') !== rowMode) {
      pill.setAttribute('data-ag-row-mode', rowMode);
    }
    pill.setAttribute('data-narrow', useBottomRow ? '1' : '0');

    if (useBottomRow) {
      const cardParent = bottomRow.parentElement;
      if (cardParent && (pill.parentElement !== cardParent || pill.previousElementSibling !== bottomRow)) {
        bottomRow.after(pill);
      }
    } else {
      if (pill.parentElement !== leftGroup) {
        leftGroup.appendChild(pill);
      }
    }

    return pill;
  }

  window.__ag_ensure_metrics_pill_fn = ensureMetricsPill;

  window.__ag_render_metrics = function(payload) {
    try {
      if (!state.metrics) return;
      window.__ag_last_metrics = payload;
      const currentId = extractCascadeId();
      const pill = ensureMetricsPill(false);
      const ttEl = ensureMetricsTooltip();
      if (!pill) return;
      if (!currentId || !payload || !payload.hasData || payload.cascadeId !== currentId) {
        if (pill.style.display !== 'none') pill.style.display = 'none';
        if (ttEl) ttEl.removeAttribute('data-visible');
        return;
      }
      const textEl = pill.querySelector('#ag-live-metrics-text');
      let textChanged = false;
      if (textEl && textEl.innerHTML !== payload.inlineHtml) {
        textEl.innerHTML = payload.inlineHtml;
        textChanged = true;
      }
      if (ttEl && ttEl.innerHTML !== payload.tooltipHtml) {
        ttEl.innerHTML = payload.tooltipHtml;
      }
      if (pill.style.display !== 'inline-flex') {
        pill.style.display = 'inline-flex';
        textChanged = true;
      }
      if (textChanged) {
        ensureMetricsPill(true);
      }
    } catch {}
  };

  window.__ag_update_live_metrics = window.__ag_render_metrics;

  function checkRouteAndMountMetrics() {
    if (disposed) return;
    try {
      syncActiveEnvFromUrl();
      syncPageType();
      if (!state.metrics) {
        const existing = document.getElementById('ag-live-metrics-pill');
        if (existing) existing.style.display = 'none';
        return;
      }
      const cid = extractCascadeId();
      const pill = document.getElementById('ag-live-metrics-pill');
      if (!cid) {
        window.__ag_watched_cascade_id = '';
        if (pill && pill.style.display !== 'none') pill.style.display = 'none';
        const ttEl = document.getElementById('ag-live-metrics-tooltip');
        if (ttEl) ttEl.removeAttribute('data-visible');
        return;
      }
      if (cid !== window.__ag_watched_cascade_id) {
        window.__ag_watched_cascade_id = cid;
        if (pill && (!window.__ag_last_metrics || window.__ag_last_metrics.cascadeId !== cid)) {
          pill.style.display = 'none';
        }
        if (typeof window.__agRequestMetrics === 'function') {
          window.__agRequestMetrics(cid);
        }
      } else if (cid) {
        const mounted = ensureMetricsPill(false);
        if (window.__ag_last_metrics && window.__ag_last_metrics.cascadeId === cid) {
          if (mounted && mounted.style.display === 'none' && window.__ag_last_metrics.hasData) {
            window.__ag_render_metrics(window.__ag_last_metrics);
          }
        } else if (typeof window.__agRequestMetrics === 'function') {
          window.__agRequestMetrics(cid);
        }
      }
    } catch {}
  }

  function sync() {
    if (disposed || !document.head || !document.body) return;
    let style = document.getElementById(styleId);
    if (!style) { style = document.createElement('style'); style.id = styleId; document.head.append(style); }
    if (style.textContent !== css) style.textContent = css;
    if (state.preset === 'native') {
      document.documentElement.removeAttribute(attr);
      document.documentElement.removeAttribute(legacyAttr);
    } else {
      if (document.documentElement.getAttribute(attr) !== state.preset)
        document.documentElement.setAttribute(attr, state.preset);
      if (document.documentElement.getAttribute(legacyAttr) !== state.preset)
        document.documentElement.setAttribute(legacyAttr, state.preset);
    }
    controls();
    decorateSidebarProjects();
    syncActiveEnvFromUrl();
    renderSshSidebarCard();
    syncRootFeatureAttrs();
    flushI18n();
    checkRouteAndMountMetrics();
  }

  // Root attributes consumed by chuanban v5.0.0 theme.css (wax-seal C/A/B states, ClearType, font-size vars)
  function applyThemeVars(varsObj) {
    const vars = varsObj && typeof varsObj === 'object' ? varsObj : {};
    const prevKeys = Array.isArray(window.__ag_applied_theme_vars) ? window.__ag_applied_theme_vars : [];
    for (const k of prevKeys) if (!(k in vars)) document.documentElement.style.removeProperty(k);
    const nextKeys = [];
    for (const [k, v] of Object.entries(vars)) {
      if (!k.startsWith('--')) continue;
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        document.documentElement.style.setProperty(k, String(v).trim());
        nextKeys.push(k);
      } else {
        document.documentElement.style.removeProperty(k);
      }
    }
    if (vars['--ag-chat-font-size']) document.documentElement.setAttribute('data-ag-custom-font-size', 'true');
    else document.documentElement.removeAttribute('data-ag-custom-font-size');
    window.__ag_applied_theme_vars = nextKeys;
  }

  function syncRootFeatureAttrs() {
    const root = document.documentElement;
    const waxSeal = config.modules?.composerWaxSeal === false ? 'off' : 'on';
    if (root.getAttribute('data-ag-wax-seal') !== waxSeal) root.setAttribute('data-ag-wax-seal', waxSeal);
    const os = /Win/i.test(navigator.platform || '') ? 'win32' : /Mac/i.test(navigator.platform || '') ? 'darwin' : 'linux';
    if (root.getAttribute('data-ag-os') !== os) root.setAttribute('data-ag-os', os);
    const sigVars = JSON.stringify(config.themeVars || {});
    if (window.__ag_theme_vars_sig !== sigVars) {
      window.__ag_theme_vars_sig = sigVars;
      applyThemeVars(config.themeVars || {});
    }
    syncPageType();
  }

  function syncPageType() {
    try {
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      const hasBranchPillInBox = !!box?.querySelector(
        '[data-testid="branch-pill-trigger"], [aria-label^="Select project"], [aria-label^="选择项目"]'
      );
      const isHome =
        hasBranchPillInBox ||
        !!document.querySelector('[data-testid="home-greeting"]') ||
        location.pathname === '/' ||
        !location.pathname.startsWith('/c/');
      const pageType = isHome ? 'home' : 'chat';
      if (document.documentElement.getAttribute('data-ag-page-type') !== pageType) {
        document.documentElement.setAttribute('data-ag-page-type', pageType);
      }
    } catch {}
  }

  // Cmd/Ctrl + - / = / 0 zoom shortcuts (native handling is unreliable in the Antigravity shell)
  window.__ag_zoom_keydown_fn = e => {
    if (disposed || config.modules?.deadlockHealer === false) return;
    const zoom = window.electronNative;
    if (!zoom?.zoomIn || !zoom?.zoomOut) return;
    const isMac = /Mac/i.test(navigator.platform || '');
    const modKey = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!modKey || e.altKey) return;
    if (!e.shiftKey && (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      e.preventDefault(); e.stopPropagation(); zoom.zoomOut();
    } else if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault(); e.stopPropagation(); zoom.zoomIn();
    } else if (!e.shiftKey && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') && zoom.zoomReset) {
      e.preventDefault(); e.stopPropagation(); zoom.zoomReset();
    }
  };
  if (!window.__ag_zoom_guard_installed) {
    window.__ag_zoom_guard_installed = true;
    window.addEventListener('keydown', e => window.__ag_zoom_keydown_fn?.(e), true);
  }

  function schedule() {
    if (timer || disposed) return;
    timer = setTimeout(() => { timer = 0; sync(); }, 100);
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;

    const sectionLink = target.closest('a[href*="section="], a[href*="project="]');
    const convRow = target.closest('div[data-sidebar-row-id], div[data-sidebar-section-id]');
    const projSelectorItem = target.closest('[data-testid="project-selector-item"]');
    const projectSection = target.closest('div[data-sidebar-section-drop-id]');

    let nextPid = '';
    if (sectionLink) {
      try {
        const linkUrl = new URL(sectionLink.getAttribute('href') || '', location.origin);
        nextPid = linkUrl.searchParams.get('section') || linkUrl.searchParams.get('project') || '';
      } catch {}
    } else if (convRow) {
      const explicitPid = convRow.getAttribute('data-ag-project-id') || '';
      const secId = convRow.getAttribute('data-sidebar-section-id') || '';
      const rowCid = convRow.getAttribute('data-sidebar-row-id') || '';
      const mappedPid = rowCid && sshState.cascadeProjectMap ? sshState.cascadeProjectMap[rowCid] || '' : '';
      const candidatePid =
        explicitPid ||
        (secId && secId !== 'main-section-header' && secId !== 'standalone' && secId !== 'pinned' && !secId.startsWith('convgroup:')
          ? secId
          : '') ||
        mappedPid;
      if (candidatePid) {
        nextPid = candidatePid;
      } else {
        const rowEnv =
          convRow.getAttribute('data-ag-env') ||
          (rowCid && (sshState.remoteCascadeIdsSet ? sshState.remoteCascadeIdsSet.has(rowCid) : (Array.isArray(sshState.remoteCascadeIds) && sshState.remoteCascadeIds.includes(rowCid))) ? 'remote' : 'local');
        window.__ag_active_env = rowEnv;
        window.__ag_active_project_id = rowEnv === 'remote' ? 'ssh-default-cli-project' : 'default-cli-project';
        renderSshSidebarCard();
      }
    } else if (projSelectorItem) {
      nextPid = projSelectorItem.getAttribute('data-ag-project-id') || findProjectIdByName(projSelectorItem.textContent || '');
      if (nextPid) {
        const trigger = document.querySelector('[data-testid="project-selector-trigger"]');
        if (trigger) trigger.setAttribute('data-ag-project-id', nextPid);
      }
    } else if (projectSection && !location.pathname.startsWith('/c/')) {
      const pid = projectSection.getAttribute('data-sidebar-section-drop-id') || '';
      if (pid && pid !== 'main-section-header' && pid !== 'standalone' && pid !== 'pinned' && !pid.startsWith('convgroup:')) {
        nextPid = pid;
      }
    }

    if (nextPid) {
      const info = resolveProjectEnvInfo(nextPid);
      window.__ag_active_env = info.env;
      window.__ag_active_project_id = nextPid;
      renderSshSidebarCard();
    }

    if (config.settingsGuard && target.closest('[data-testid="settings-button"]')) {
      const url = new URL(location.href);
      if (url.searchParams.get('settingsOpen') === 'true' && !document.querySelector('.settings-modal-container, [role="dialog"]')) {
        url.searchParams.delete('settingsOpen');
        url.searchParams.delete('settingsScreen');
        history.replaceState(history.state, '', url);
      }
    }
    const option = target.closest('[role="option"]');
    if (option && document.querySelector('.settings-modal-container')) {
      const name = option.textContent.trim();
      if (['Default Light','Default Dark','Catppuccin','Gruvbox Material','One Light','One Dark','Solarized'].includes(name))
        setState({preset: 'native'});
    }
    schedule();
  }

  function start() {
    if (disposed) return;
    sync();
    sendSshAction({action: 'get-state'});
    observer = new MutationObserver(mutations => {
      let needSync = false;
      for (const m of mutations) {
        const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
        if (!el || el.id === styleId) continue;
        if (el.closest?.('#ag-ssh-sidebar-card, #ag-remote-folder-modal, .ag-proj-env-badge, #ag-sidebar-add-remote-btn')) continue;
        const inSidebar = !!el.closest?.('[aria-label="Sidebar"]');
        const isExcluded = excluded(el);
        if (inSidebar || !isExcluded) needSync = true;
        if (isExcluded || !state.localize) continue;
        if (m.type === 'characterData') {
          dirtyI18nRoots.add(m.target);
        } else if (m.type === 'attributes') {
          if (m.attributeName === 'title' || m.attributeName === 'aria-label' || m.attributeName === 'placeholder') {
            try { translateElementAttrs(el); } catch {}
          }
        } else if (m.type === 'childList') {
          for (const n of m.addedNodes) if (n.nodeType === 1 || n.nodeType === 3) dirtyI18nRoots.add(n);
        }
      }
      if (needSync || dirtyI18nRoots.size) schedule();
    });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'aria-label', 'title', 'placeholder', 'data-state'],
      });
      document.addEventListener('click', onClick, true);
      if (!window.__ag_history_route_hooked) {
        window.__ag_history_route_hooked = true;
        try {
          const origPush = history.pushState.bind(history);
          const origReplace = history.replaceState.bind(history);
          history.pushState = function(...args) {
            const ret = origPush(...args);
            try { window.__ag_on_route_change?.(); } catch {}
            return ret;
          };
          history.replaceState = function(...args) {
            const ret = origReplace(...args);
            try { window.__ag_on_route_change?.(); } catch {}
            return ret;
          };
          window.addEventListener('popstate', () => {
            try { window.__ag_on_route_change?.(); } catch {}
          });
        } catch {}
      }
      window.__ag_on_route_change = checkRouteAndMountMetrics;
      if (window.__ag_metrics_route_watcher) clearInterval(window.__ag_metrics_route_watcher);
      window.__ag_metrics_route_watcher = setInterval(checkRouteAndMountMetrics, 1500);
      window.__ag_watched_cascade_id = '';
      checkRouteAndMountMetrics();
  }

  window.__ag_patch_version = PATCH_VERSION;
  window.__feiAGPatch = {
    signature,
    version: PATCH_VERSION,
    state: () => ({...state}),
    sshState: () => {
      const {remoteCascadeIdsSet: _r, localCascadeIdsSet: _l, ...rest} = sshState;
      return {
        ...rest,
        isRemoteWindow: isRemoteWindow(),
        activeEnv: window.__ag_active_env || 'local',
        activeProjectId: window.__ag_active_project_id || '',
        multiplexerActive: Boolean(window.__ag_fetch_multiplexer_active),
      };
    },
    health: () => ({
      signature,
      version: window.__ag_patch_version,
      style: !!document.getElementById(styleId),
      preset: state.preset,
      localize: state.localize,
      metrics: state.metrics,
      sshMode: sshState.mode || state.sshMode,
      sshStatus: sshState.status,
      sshActiveHost: sshState.activeHost,
      isRemoteWindow: isRemoteWindow(),
      multiplexerActive: Boolean(window.__ag_fetch_multiplexer_active),
    }),
    sync,
    setState,
    translateRoot,
    ensureMetricsPill,
    renderSshSidebarCard,
    decorateSidebarProjects,
    openRemoteFolderPickerModal,
    findProjectIdByName,
    resolveProjectEnvInfo,
    sendSshAction,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      observer?.disconnect();
      metricsResizeObserver?.disconnect();
      if (window.__ag_metrics_route_watcher) {
        clearInterval(window.__ag_metrics_route_watcher);
        delete window.__ag_metrics_route_watcher;
      }
      delete window.__ag_on_route_change;
      document.removeEventListener('DOMContentLoaded', start);
      document.removeEventListener('click', onClick, true);
      restoreTranslations();
      document.getElementById(styleId)?.remove();
      document.getElementById('fei-ag-controls')?.remove();
      document.getElementById('ag-live-metrics-pill')?.remove();
      document.getElementById('ag-live-metrics-tooltip')?.remove();
      document.getElementById('ag-ssh-sidebar-card')?.remove();
      document.getElementById('ag-remote-folder-modal')?.remove();
      document.getElementById('ag-sidebar-add-remote-btn')?.remove();
      for (const b of document.querySelectorAll('.ag-proj-env-badge')) b.remove();
      document.documentElement.removeAttribute(attr);
      document.documentElement.removeAttribute(legacyAttr);
      document.documentElement.removeAttribute('data-ag-env-filter');
      document.documentElement.removeAttribute('data-ag-page-type');
      document.documentElement.removeAttribute('data-ag-wax-seal');
      document.documentElement.removeAttribute('data-ag-os');
      applyThemeVars({});
      delete window.__ag_theme_vars_sig;
      if (window.__ag_metrics_ro) {
        try { window.__ag_metrics_ro.disconnect(); } catch {}
        window.__ag_metrics_ro = null;
        window.__ag_metrics_ro_target = null;
      }
      delete window.__ag_watched_cascade_id;
      delete window.__ag_patch_version;
      delete window.__feiAGPatch;
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
  return window.__feiAGPatch.health();
})
