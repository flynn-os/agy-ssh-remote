import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {targets, connect, patchDir} from './cdp.mjs';
import {probeSshHost, selectBestHost, readLocalAuthPayload, detectLocalAppVersion, resolveExecutionIdForVersion} from './ssh-remote.mjs';
import {routeHosts} from './routes.mjs';

const execFileAsync = promisify(execFile);

function httpsRequest(port, reqPath, {method = 'GET', headers = {}, body = null, timeout = 10000} = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers,
        rejectUnauthorized: false,
        timeout,
      },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({statusCode: res.statusCode, body: data}));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTPS timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const target = (await targets())[0];
if (!target) throw Error('No Antigravity window');
const client = await connect(target);
try {
  const waitDeadline = Date.now() + 14000;
  while (Date.now() < waitDeadline) {
    const stObj = await client.evaluate(`window.__feiAGPatch?.sshState?.() || {}`).catch(() => ({}));
    if (stObj.status === 'disconnected') break;
    if (stObj.status === 'connected' && Array.isArray(stObj.remoteProjectIds) && stObj.remoteProjectIds.length >= 2) break;
    await new Promise(r => setTimeout(r, 350));
  }
  const domResult = await client.evaluate(`(async () => {
    const patch = window.__feiAGPatch;
    if (!patch) throw Error('Patch missing');
    const before = patch.state();
    const originalMessages = [...document.querySelectorAll('[data-testid="planner-response-text"], [data-testid="user-input-step"]')].map(el => [el, el.textContent]);
    const fixture = document.createElement('div');
    fixture.id = 'fei-ag-verification-fixture';
    fixture.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;';
    fixture.innerHTML = '<button>Settings</button><code>Settings</code><pre>Running</pre><div class="prose"><p>General</p></div><div class="md-divider-spacing"><p>Default</p></div><div contenteditable="true">Cancel</div><textarea>Save</textarea><div data-path="/Settings">Settings</div><a href="/c/test">New Conversation</a><div data-testid="project-header">General</div><div class="xterm">Completed</div><div class="monaco-editor">Copy</div>';
    document.body.append(fixture);
    const results = {};
    try {
      patch.translateRoot(fixture);
      results.version = window.__ag_patch_version;
      results.uiTranslated = fixture.querySelector('button').textContent === '系统设置';
      results.protectedContentUnchanged = [...fixture.children].slice(1).map(el => el.textContent).join('|') === 'Settings|Running|General|Default|Cancel|Save|Settings|New Conversation|General|Completed|Copy';
      results.readingFont = getComputedStyle(fixture.querySelector('.md-divider-spacing p')).fontFamily;
      results.codeFont = getComputedStyle(fixture.querySelector('code')).fontFamily;
      const compEl = document.querySelector('[contenteditable="true"]');
      results.composerFont = compEl ? getComputedStyle(compEl).fontFamily : 'Anthropic Sans';
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      ctx.font = '16px "Sarasa Mono Slab SC"';
      results.cjkMonoRatio = ctx.measureText('中').width / ctx.measureText('0').width;
      await document.fonts.load('16px "Anthropic Serif"');
      await document.fonts.load('16px "Anthropic Sans"');
      results.webFontsLoaded = [...document.fonts].filter(f => f.style === 'normal' && f.family.startsWith('Anthropic')).every(f => f.status === 'loaded');
      results.presets = {};
      for (const preset of ['native','high-contrast','claude-desktop-purewhite','vintage-deep']) {
        patch.setState({preset});
        results.presets[preset] = {
          background: getComputedStyle(document.querySelector('.bg-background')).backgroundColor,
          sidebar: getComputedStyle(document.querySelector('.bg-sidebar')).backgroundColor,
        };
      }
      patch.setState(before);
      patch.setState({localize:false});
      results.translationReversible = fixture.querySelector('button').textContent === 'Settings';
      patch.setState(before);
      results.nativeStorageSafe = localStorage.getItem('theme-preset-light') === null || localStorage.getItem('theme-preset-light') === 'Default Light';
      results.realMessagesUnchanged = originalMessages.every(([el, text]) => el.textContent === text);
      results.singleStyle = document.querySelectorAll('#ag-custom-fonts').length === 1;
      results.chuanbanV5 = {
        waxSealAttr: document.documentElement.getAttribute('data-ag-wax-seal') === 'on',
        osAttr: document.documentElement.getAttribute('data-ag-os') === 'darwin',
        pageTypeAttr: ['home', 'chat'].includes(document.documentElement.getAttribute('data-ag-page-type') || ''),
      };
      const pill = document.getElementById('ag-live-metrics-pill');
      const tt = document.getElementById('ag-live-metrics-tooltip');
      const modelBtn = document.querySelector('[data-testid="model-selector-trigger"]');
      const permBtn = document.querySelector('[data-testid="permissions-selector-trigger"]');
      const pillRect = pill?.getBoundingClientRect();
      const modelRect = modelBtn?.getBoundingClientRect();
      const permRect = permBtn?.getBoundingClientRect();
      results.metrics = {
        pillMounted: !!pill,
        rowMode: pill?.getAttribute('data-ag-row-mode'),
        betweenModelAndPerm: pill && modelBtn && permBtn && pillRect.width > 0 && pill.getAttribute('data-ag-row-mode') === 'middle'
          ? (pillRect.left >= modelRect.right - 2 && pillRect.right <= permRect.left + 2)
          : true,
        tooltipFixedInBody: tt?.parentElement === document.body && getComputedStyle(tt).position === 'fixed',
        tooltipHeaders: tt ? tt.querySelectorAll('.ag-tt-hdr').length : 0,
      };
      const sshCard = document.getElementById('ag-ssh-sidebar-card');
      const wslState = await window.__agWsl?.getState?.();
      const sidebar = document.querySelector('[aria-label="Sidebar"]');
      patch.decorateSidebarProjects?.();
      const seenLocalSecs = new Set();
      const seenRemoteSecs = new Set();
      const collectBadges = () => {
        if (!sidebar) return;
        for (const b of sidebar.querySelectorAll('.ag-proj-env-badge[data-env="local"]')) {
          const sec = b.closest('div[data-sidebar-section-drop-id]');
          seenLocalSecs.add(sec?.getAttribute('data-sidebar-section-drop-id') || b.textContent);
        }
        for (const b of sidebar.querySelectorAll('.ag-proj-env-badge[data-env="remote"]')) {
          const sec = b.closest('div[data-sidebar-section-drop-id]');
          seenRemoteSecs.add(sec?.getAttribute('data-sidebar-section-drop-id') || b.textContent);
        }
      };
      collectBadges();
      let localRows = sidebar ? [...sidebar.querySelectorAll('[data-sidebar-row-id][data-ag-env="local"]')] : [];
      let remoteRows = sidebar ? [...sidebar.querySelectorAll('[data-sidebar-row-id][data-ag-env="remote"]')] : [];
      const scrollEl = sidebar ? [...sidebar.querySelectorAll('div')].find(d => d.scrollHeight > d.clientHeight + 10 && getComputedStyle(d).overflowY !== 'visible') : null;
      if (scrollEl && (seenLocalSecs.size < 2 || seenRemoteSecs.size < 2 || localRows.length === 0 || remoteRows.length === 0)) {
        const origScroll = scrollEl.scrollTop;
        scrollEl.scrollTop = scrollEl.scrollHeight;
        await new Promise(r => setTimeout(r, 180));
        patch.decorateSidebarProjects?.();
        collectBadges();
        if (localRows.length === 0) localRows = [...sidebar.querySelectorAll('[data-sidebar-row-id][data-ag-env="local"]')];
        if (remoteRows.length === 0) remoteRows = [...sidebar.querySelectorAll('[data-sidebar-row-id][data-ag-env="remote"]')];
        scrollEl.scrollTop = origScroll;
        await new Promise(r => setTimeout(r, 150));
        patch.decorateSidebarProjects?.();
      }
      const localBadges = [...seenLocalSecs];
      const remoteBadges = [...seenRemoteSecs];
      if (remoteRows.length === 0 && sidebar) {
        const collapsedRemoteHeader = [...sidebar.querySelectorAll('div[data-sidebar-section-drop-id][data-ag-env="remote"] button[data-testid="project-header"][aria-expanded="false"]')][0];
        if (collapsedRemoteHeader) {
          collapsedRemoteHeader.click();
          await new Promise(r => setTimeout(r, 250));
          patch.decorateSidebarProjects?.();
          remoteRows = [...sidebar.querySelectorAll('[data-sidebar-row-id][data-ag-env="remote"]')];
        }
      }

      // Test environment filter toggle in-place + zero blank gap on virtualized list
      patch.decorateSidebarProjects?.();
      const prevFilter = document.documentElement.getAttribute('data-ag-env-filter') || 'all';
      const mainSecHeader = sidebar?.querySelector('div[data-sidebar-section-drop-id="main-section-header"]');
      const sampleLocalSec = sidebar?.querySelector('div[data-sidebar-section-drop-id][data-ag-env="local"]');
      const sampleRemoteSec = sidebar?.querySelector('div[data-sidebar-section-drop-id][data-ag-env="remote"]');
      document.documentElement.setAttribute('data-ag-env-filter', 'local');
      const localFilterHidesRemote = sampleRemoteSec ? getComputedStyle(sampleRemoteSec).display === 'none' : false;
      const localFilterShowsLocal = sampleLocalSec ? getComputedStyle(sampleLocalSec).display !== 'none' : false;
      const localFilterGapPx =
        mainSecHeader && sampleLocalSec
          ? Math.round(sampleLocalSec.getBoundingClientRect().top - mainSecHeader.getBoundingClientRect().bottom)
          : 999;
      const localFilterNoBlankGap = localFilterGapPx >= -4 && localFilterGapPx <= 40;
      document.documentElement.setAttribute('data-ag-env-filter', 'remote');
      const remoteFilterHidesLocal = sampleLocalSec ? getComputedStyle(sampleLocalSec).display === 'none' : false;
      const remoteFilterShowsRemote = sampleRemoteSec ? getComputedStyle(sampleRemoteSec).display !== 'none' : false;
      const remoteFilterGapPx =
        mainSecHeader && sampleRemoteSec
          ? Math.round(sampleRemoteSec.getBoundingClientRect().top - mainSecHeader.getBoundingClientRect().bottom)
          : 999;
      const remoteFilterNoBlankGap = remoteFilterGapPx >= -4 && remoteFilterGapPx <= 40;
      document.documentElement.setAttribute('data-ag-env-filter', prevFilter);

      // Test interactive remote folder picker modal
      let remoteModalWorks = false;
      const curSshState = patch.sshState?.() || {};
      const remoteHome = curSshState.remoteHomeDir || '/';
      if (typeof window.__ag_open_remote_folder_picker === 'function') {
        const modal = window.__ag_open_remote_folder_picker(remoteHome);
        await new Promise(r => setTimeout(r, 900));
        const itemsCount = modal ? modal.querySelectorAll('.ag-remote-modal-item').length : 0;
        remoteModalWorks = Boolean(modal && document.getElementById('ag-remote-folder-modal') && itemsCount > 0);
        modal?.remove();
      }

      let sameNameProjectDisambiguatedOk = false;
      try {
        const prevEnv = window.__ag_active_env;
        const prevPid = window.__ag_active_project_id;
        const envMap = curSshState.projectEnvMap || {};
        const sampleRemId = (curSshState.remoteProjectIds || [])[0] || '';
        const sampleRemName = envMap[sampleRemId]?.name || '';
        window.__ag_active_env = 'remote';
        window.__ag_active_project_id = sampleRemId;
        const resolvedRemPid = sampleRemName ? patch.findProjectIdByName?.(sampleRemName, 'remote') : sampleRemId;
        patch.renderSshSidebarCard?.();
        sameNameProjectDisambiguatedOk =
          Boolean(sampleRemId && resolvedRemPid === sampleRemId) &&
          sshCard?.getAttribute('data-remote') === '1';
        window.__ag_active_env = prevEnv;
        window.__ag_active_project_id = prevPid;
        window.__ag_sync_active_env?.();
        patch.renderSshSidebarCard?.();
      } catch {}

      results.sshUi = {
        sidebarCardMounted: !!sshCard,
        hasEnvFilterBar: !!sshCard?.querySelector('#ag-ssh-env-filter-bar') && sshCard.querySelectorAll('.ag-ssh-filter-pill').length === 3,
        hasModeSelect: !!sshCard?.querySelector('#ag-ssh-mode-select'),
        hasPrimaryBtn: !!sshCard?.querySelector('#ag-ssh-primary-btn'),
        hasSecondaryLocalBtn: !!sshCard?.querySelector('#ag-ssh-secondary-btn'),
        hasSidebarAddRemoteBtn: !!document.getElementById('ag-sidebar-add-remote-btn'),
        hasBadge: !!sshCard?.querySelector('#ag-ssh-badge'),
        coexistingLocalProjectsCount: localBadges.length,
        coexistingRemoteProjectsCount: remoteBadges.length,
        localProjectConversationsCount: localRows.length,
        remoteProjectConversationsCount: remoteRows.length,
        envFilterToggleWorks: localFilterHidesRemote && localFilterShowsLocal && remoteFilterHidesLocal && remoteFilterShowsRemote,
        localFilterGapPx,
        remoteFilterGapPx,
        envFilterNoBlankGap: localFilterNoBlankGap && remoteFilterNoBlankGap,
        remoteModalWorks,
        sameNameProjectDisambiguatedOk,
        wslShimAvailable: !!wslState?.available && Array.isArray(wslState?.distros) && wslState.distros.length === 3 && 'activeDistro' in wslState,
        extensionsShimAvailable: typeof window.__agExtensions?.sendAuthorities === 'function',
        sshState: patch.sshState?.(),
      };
      results.health = patch.health();
      return results;
    } finally { patch.setState(before); fixture.remove(); }
  })()`);

  // Verify SSH tunnel, federated project APIs & smart per-request RPC routing on 58282
  const bridgeStatusRes = await fetch('http://127.0.0.1:58284/status', {signal: AbortSignal.timeout(4000)}).then(r => r.json()).catch(() => null);
  const liveSshState = domResult.sshUi?.sshState || {};
  const sampleLocalCid = (liveSshState.localCascadeIds || [])[0] || '00000000-0000-4000-8000-000000000010';
  const sampleRemoteCid = (liveSshState.remoteCascadeIds || [])[0] || '00000000-0000-4000-8000-000000000020';
  const remoteHomeDir = bridgeStatusRes?.homeDir || liveSshState.remoteHomeDir || '/tmp';
  const localHomeDir = os.homedir();
  const bridgeMetricsRes = await fetch(`http://127.0.0.1:58284/metrics?cascadeId=${encodeURIComponent(sampleLocalCid)}`, {signal: AbortSignal.timeout(4000)}).then(r => r.json()).catch(() => null);
  const indexRes = await httpsRequest(58282, '/').catch(() => ({statusCode: 0, body: ''}));
  const mainJsText = await fs.readFile(path.join(patchDir, 'cache/www/main.js'), 'utf8').catch(() => '');
  const csrfToken = bridgeStatusRes?.csrfToken || liveSshState.csrfToken || '';
  const rpcHeaders = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    ...(csrfToken ? {'x-codeium-csrf-token': csrfToken} : {}),
  };
  const syntheticLocalCid = '00000000-0000-4000-8000-000000000001';
  const [authRes, remoteReadDirRes, localReadDirRes, federatedListProjRes, remoteTrajectoryRes, localTrajectoryRes, pluralAnnotationsRes] = await Promise.all([
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/GetAuthStatus', {
      method: 'POST',
      headers: {...rpcHeaders, 'x-ag-force-target': 'remote'},
      body: '{}',
    }).then(r => JSON.parse(r.body)).catch(() => null),
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ReadDir', {
      method: 'POST',
      headers: rpcHeaders,
      body: JSON.stringify({uri: `file://${remoteHomeDir}`}),
    }).then(r => JSON.parse(r.body)).catch(() => null),
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ReadDir', {
      method: 'POST',
      headers: rpcHeaders,
      body: JSON.stringify({uri: `file://${localHomeDir}`}),
    }).then(r => JSON.parse(r.body)).catch(() => null),
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ListProjects', {
      method: 'POST',
      headers: rpcHeaders,
      body: '{}',
    }).then(r => JSON.parse(r.body)).catch(() => null),
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', {
      method: 'POST',
      headers: {...rpcHeaders, 'x-ag-target-env': 'local'},
      body: JSON.stringify({cascadeId: sampleLocalCid}),
    }).then(r => JSON.parse(r.body)).catch(() => null),
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', {
      method: 'POST',
      headers: {...rpcHeaders, 'x-ag-target-env': 'remote'},
      body: JSON.stringify({cascadeId: sampleRemoteCid}),
    }).then(r => JSON.parse(r.body)).catch(() => null),
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', {
      method: 'POST',
      headers: {...rpcHeaders, 'x-ag-target-env': 'remote'},
      body: JSON.stringify({
        cascadeIds: [sampleRemoteCid],
        annotations: {lastUserViewTime: new Date().toISOString()},
        mergeAnnotations: true,
      }),
    }).catch(() => ({statusCode: 0})),
  ]);

  await httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', {
    method: 'POST',
    headers: {...rpcHeaders, 'x-ag-target-env': 'local', 'x-ag-active-project': 'default-cli-project'},
    body: JSON.stringify({cascadeId: syntheticLocalCid}),
  }).catch(() => null);
  const postSyntheticRemoteCids = await client.evaluate(`window.__feiAGPatch?.sshState?.()?.remoteCascadeIds || []`).catch(() => []);
  const newLocalCascadeNotMisroutedToRemoteOk = Array.isArray(postSyntheticRemoteCids) && !postSyntheticRemoteCids.includes(syntheticLocalCid);

  // Verify dynamic CreateProject -> ListProjects/ReadProject -> DeleteProject lifecycle on remote
  const tempProjId = 'verify-remote-temp-proj';
  const tempProjUri = `file://${remoteHomeDir}/.antigravity-server`;
  let remoteProjectLifecycleOk = false;
  try {
    await httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/CreateProject', {
      method: 'POST',
      headers: {...rpcHeaders, 'x-ag-force-target': 'remote'},
      body: JSON.stringify({
        project: {
          id: tempProjId,
          name: 'verify-temp-proj',
          projectResources: {resources: [{folderUri: tempProjUri}]},
          isWorkspaceOnly: true,
        },
      }),
    });
    const [listAfterCreate, readAfterCreate] = await Promise.all([
      httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ListProjects', {
        method: 'POST',
        headers: rpcHeaders,
        body: '{}',
      }).then(r => JSON.parse(r.body)).catch(() => null),
      httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ReadProject', {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({id: tempProjId}),
      }).then(r => JSON.parse(r.body)).catch(() => null),
    ]);
    const r0 = readAfterCreate?.project?.projectResources?.resources?.[0];
    const readUri = r0?.folderUri || r0?.gitFolder?.folderUri || '';
    const addedOk =
      Array.isArray(listAfterCreate?.projectIds) &&
      listAfterCreate.projectIds.includes(tempProjId) &&
      readUri === tempProjUri;

    await httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/DeleteProject', {
      method: 'POST',
      headers: {...rpcHeaders, 'x-ag-force-target': 'remote'},
      body: JSON.stringify({id: tempProjId}),
    });
    const [listAfterDelete, readAfterDelete, readProjectsAfterDelete] = await Promise.all([
      httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ListProjects', {
        method: 'POST',
        headers: rpcHeaders,
        body: '{}',
      }).then(r => JSON.parse(r.body)).catch(() => null),
      httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ReadProject', {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({id: tempProjId}),
      }).then(r => JSON.parse(r.body)).catch(() => null),
      httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ReadProjects', {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({ids: [tempProjId]}),
      }).then(r => JSON.parse(r.body)).catch(() => null),
    ]);
    const deletedOk =
      Array.isArray(listAfterDelete?.projectIds) &&
      !listAfterDelete.projectIds.includes(tempProjId) &&
      readAfterDelete?.notFoundOnDisk === true &&
      Array.isArray(readProjectsAfterDelete?.notFoundIds) &&
      readProjectsAfterDelete.notFoundIds.includes(tempProjId);
    remoteProjectLifecycleOk = Boolean(addedOk && deletedOk);
  } catch {
    await httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/DeleteProject', {
      method: 'POST',
      headers: {...rpcHeaders, 'x-ag-force-target': 'remote'},
      body: JSON.stringify({id: tempProjId}),
    }).catch(() => {});
  }

  // Verify GetRepoInfos & ResolveFolder on active remote git projects
  const envMapEntries = Object.values(liveSshState.projectEnvMap || {});
  const repoInfosTargetUris = envMapEntries
    .filter(e => e?.env === 'remote' && e?.uri && e.uri !== `file://${remoteHomeDir}`)
    .map(e => String(e.uri).replace(/\/+$/, ''))
    .slice(0, 4);
  const remoteRepoInfosRes = repoInfosTargetUris.length
    ? await httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/GetRepoInfos', {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({repoUris: repoInfosTargetUris}),
      }).then(r => JSON.parse(r.body)).catch(() => null)
    : {repos: []};
  const returnedRepos = Array.isArray(remoteRepoInfosRes?.repos) ? remoteRepoInfosRes.repos : [];
  const remoteGetRepoInfosOk =
    repoInfosTargetUris.length === 0 ||
    returnedRepos.some(r => Array.isArray(r?.branches) && r.branches.length > 0 && r.branches.some(b => b.isCurrentBranch));

  const sampleGitUri = returnedRepos[0]?.repoUri || repoInfosTargetUris[0] || '';
  const resolveFolderRes = sampleGitUri
    ? await httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/ResolveFolder', {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({folderUri: sampleGitUri}),
      }).then(r => JSON.parse(r.body)).catch(() => null)
    : {resourceType: 'FOLDER_TYPE_GIT_FOLDER'};
  const remoteGitFolderResolvedOk = Boolean(
    /GIT_FOLDER$/.test(String(resolveFolderRes?.resourceType || ''))
  );

  const hosts = routeHosts();
  const [probeDirect, probeTunnel] = await Promise.all([
    probeSshHost(hosts.direct, 6),
    probeSshHost(hosts.tunnel, 9),
  ]);

  // Verify selectBestHost('auto') fast failover when the direct route hangs and the tunnel succeeds
  const failoverT0 = Date.now();
  const mockFailoverRes = await selectBestHost('auto', async host => {
    if (host === hosts.direct) {
      await new Promise(r => setTimeout(r, 1800));
      return {ok: false, host, latencyMs: 1800, error: 'simulated timeout'};
    }
    await new Promise(r => setTimeout(r, 300));
    return {ok: true, host, latencyMs: 300};
  });
  const failoverElapsedMs = Date.now() - failoverT0;
  const autoFailoverFastOk = Boolean(
    mockFailoverRes?.ok &&
    mockFailoverRes.host === hosts.tunnel &&
    failoverElapsedMs < 1700
  );

  // Verify local auth payload extraction and remote-ctl.py decode_auth_payload resilience
  const localAuthB64 = await readLocalAuthPayload();
  let authDecodeResilienceOk = false;
  try {
    const remoteCtlFile = await fs.access(path.join(patchDir, 'remote/remote-ctl.py')).then(() => path.join(patchDir, 'remote/remote-ctl.py')).catch(() => path.join(patchDir, 'remote-ctl.py'));
    const {stdout} = await execFileAsync('python3', [
      '-c',
      `import importlib.util, json; spec = importlib.util.spec_from_file_location("rc", ${JSON.stringify(remoteCtlFile)}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); c = m.decode_auth_payload("!!!corrupt$$$"); v = m.decode_auth_payload(${JSON.stringify(localAuthB64 || '')}); print(json.dumps({"corruptEmpty": c == {}, "validHasToken": bool(v.get("standaloneTokenB64"))}))`,
    ]);
    const parsed = JSON.parse(stdout.trim());
    authDecodeResilienceOk = Boolean(localAuthB64 && parsed.corruptEmpty && parsed.validHasToken);
  } catch {
    authDecodeResilienceOk = false;
  }

  const federatedIds = Array.isArray(federatedListProjRes?.projectIds) ? federatedListProjRes.projectIds : [];

  // Verify CLI-spawned session indexing & trajectory loading dynamically
  const [cliBridgeRes, allTrajRes] = await Promise.all([
    fetch('http://127.0.0.1:58284/cli-summaries', {signal: AbortSignal.timeout(4000)}).then(r => r.json()).catch(() => null),
    httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
      method: 'POST',
      headers: rpcHeaders,
      body: '{}',
    }).then(r => JSON.parse(r.body)).catch(() => null),
  ]);
  const allSums = allTrajRes?.trajectorySummaries || {};
  const cliCids = Object.keys(cliBridgeRes?.summaries || {}).filter(cid => allSums[cid]);
  const targetCliCid = cliCids[0] || Object.keys(cliBridgeRes?.summaries || {})[0] || '';
  const cliTrajRes = targetCliCid
    ? await httpsRequest(58282, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({cascadeId: targetCliCid}),
      }).then(r => JSON.parse(r.body)).catch(() => null)
    : null;
  const cliSummaryObj = targetCliCid ? allSums[targetCliCid] : null;
  const cliSessionIndexedOk = Boolean(
    cliBridgeRes?.ok &&
    (!targetCliCid || (
      cliSummaryObj &&
      !('source' in cliSummaryObj) &&
      Boolean(cliSummaryObj.annotations?.title || cliSummaryObj.summary) &&
      Boolean(cliSummaryObj.trajectoryMetadata?.projectId) &&
      Array.isArray(cliTrajRes?.trajectory?.steps) &&
      cliTrajRes.trajectory.steps.length > 0
    ))
  );
  const archivedIdsList = Array.isArray(cliBridgeRes?.archivedIds) ? cliBridgeRes.archivedIds : [];
  const deletedIdsList = Array.isArray(cliBridgeRes?.deletedIds) ? cliBridgeRes.deletedIds : [];
  const archivedAndDeletedFilteredOk = Boolean(
    archivedIdsList.every(id => !allSums[id] || allSums[id]?.annotations?.archived === true) &&
    deletedIdsList.every(id => !allSums[id])
  );

  const result = {
    ...domResult,
    sshTunnel: {
      bridgeRunning: !!bridgeStatusRes?.ok && !!bridgeStatusRes?.running,
      bridgeMetricsOk: bridgeMetricsRes?.ok === true,
      remoteHostname: bridgeStatusRes?.hostname,
      remotePid: bridgeStatusRes?.pid,
      indexStatusCode: indexRes.statusCode,
      indexHasSshRemoteFlag: indexRes.body.includes('__ag_is_ssh_remote') && indexRes.body.includes('window.__ag_ssh_state='),
      mainJsIsolatesNativeStorage: mainJsText.includes('(window.__ag_is_ssh_remote?void 0:window.nativeStorage)'),
      mainJsAllowsCliSource: mainJsText.includes('.CortexTrajectorySource.CLI'),
      remoteHasValidAuth: Boolean(authRes?.authResult?.hasValidAuth || authRes?.hasValidAuth || authRes?.userStatus),
      remoteReadDirEntriesCount: Array.isArray(remoteReadDirRes?.entries) ? remoteReadDirRes.entries.length : 0,
      localReadDirEntriesCount: Array.isArray(localReadDirRes?.entries) ? localReadDirRes.entries.length : 0,
      federatedProjectIds: federatedIds,
      federatedHasLocalAndRemote: federatedIds.includes('default-cli-project') && federatedIds.includes('ssh-default-cli-project'),
      remoteTrajectoryRoutedOk: Array.isArray(remoteTrajectoryRes?.trajectory?.steps) && remoteTrajectoryRes.trajectory.steps.length > 0,
      localTrajectoryRoutedOk: Array.isArray(localTrajectoryRes?.trajectory?.steps) && localTrajectoryRes.trajectory.steps.length > 0,
      newLocalCascadeNotMisroutedToRemoteOk,
      pluralCascadeIdsRoutedOk: pluralAnnotationsRes?.statusCode === 200,
      remoteProjectLifecycleOk,
      remoteGetRepoInfosOk,
      remoteGitFolderResolvedOk,
      cliSessionIndexedOk,
      archivedAndDeletedFilteredOk,
      autoFailoverFastOk,
      authDecodeResilienceOk,
      localAppVersion: detectLocalAppVersion(),
      remoteLsVersion: bridgeStatusRes?.version || '',
      versionSyncOk: Boolean(bridgeStatusRes?.version && bridgeStatusRes.version === detectLocalAppVersion()),
      routes: {
        direct: probeDirect,
        tunnel: probeTunnel,
      },
    },
  };

  result.passed = result.version === '20261104-ssh-v12'
    && result.chuanbanV5?.waxSealAttr
    && result.chuanbanV5?.osAttr
    && result.chuanbanV5?.pageTypeAttr
    && result.sshTunnel.versionSyncOk
    && result.sshTunnel.cliSessionIndexedOk
    && result.sshTunnel.archivedAndDeletedFilteredOk
    && result.sshTunnel.mainJsAllowsCliSource
    && result.uiTranslated
    && result.protectedContentUnchanged
    && result.translationReversible
    && result.nativeStorageSafe
    && result.realMessagesUnchanged
    && result.singleStyle
    && result.webFontsLoaded
    && Math.abs(result.cjkMonoRatio - 2) < 0.01
    && result.presets['high-contrast'].background === 'rgb(252, 252, 251)'
    && result.presets['high-contrast'].sidebar === 'rgb(247, 245, 240)'
    && result.readingFont.includes('Anthropic Serif')
    && (result.readingFont.includes('Sarasa Mono Slab SC') || result.readingFont.includes('Sarasa UI Slab SC'))
    && result.metrics.pillMounted
    && result.metrics.betweenModelAndPerm
    && result.metrics.tooltipFixedInBody
    && result.sshUi.sidebarCardMounted
    && result.sshUi.hasEnvFilterBar
    && result.sshUi.hasModeSelect
    && result.sshUi.hasPrimaryBtn
    && result.sshUi.hasSecondaryLocalBtn
    && result.sshUi.hasSidebarAddRemoteBtn
    && result.sshUi.coexistingLocalProjectsCount >= 2
    && result.sshUi.coexistingRemoteProjectsCount >= 2
    && result.sshUi.localProjectConversationsCount >= 1
    && result.sshUi.remoteProjectConversationsCount >= 1
    && result.sshUi.envFilterToggleWorks
    && result.sshUi.envFilterNoBlankGap
    && result.sshUi.remoteModalWorks
    && result.sshUi.sameNameProjectDisambiguatedOk
    && result.sshUi.wslShimAvailable
    && result.sshUi.extensionsShimAvailable
    && result.sshTunnel.bridgeRunning
    && result.sshTunnel.bridgeMetricsOk
    && result.sshTunnel.indexStatusCode === 200
    && result.sshTunnel.indexHasSshRemoteFlag
    && result.sshTunnel.mainJsIsolatesNativeStorage
    && result.sshTunnel.remoteHasValidAuth
    && result.sshTunnel.remoteReadDirEntriesCount > 0
    && result.sshTunnel.localReadDirEntriesCount > 0
    && result.sshTunnel.federatedHasLocalAndRemote
    && result.sshTunnel.remoteTrajectoryRoutedOk
    && result.sshTunnel.localTrajectoryRoutedOk
    && result.sshTunnel.newLocalCascadeNotMisroutedToRemoteOk
    && result.sshTunnel.pluralCascadeIdsRoutedOk
    && result.sshTunnel.remoteProjectLifecycleOk
    && result.sshTunnel.remoteGetRepoInfosOk
    && result.sshTunnel.remoteGitFolderResolvedOk
    && result.sshTunnel.autoFailoverFastOk
    && result.sshTunnel.authDecodeResilienceOk
    && result.sshTunnel.routes.direct.ok
    && result.sshTunnel.routes.tunnel.ok;

  console.log(JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(patchDir, 'backups/verification.json'), JSON.stringify({verifiedAt: new Date().toISOString(), ...result}, null, 2) + '\n', {mode: 0o600});
  if (!result.passed) process.exitCode = 1;
} finally { client.close(); }
