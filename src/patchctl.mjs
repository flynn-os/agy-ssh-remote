#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {targets, connect, patchDir} from './cdp.mjs';
import {readConfig, saveConfig, presets, sshModes} from './bundle.mjs';
import {probeSshHost, discoverLocalMacLsPort} from './ssh-remote.mjs';

const label = 'local.fei.antigravity-theme';
const service = `gui/${process.getuid()}/${label}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const [command = 'status', value, extra] = process.argv.slice(2);
const config = await readConfig();
const launchctl = (...args) => spawnSync('/bin/launchctl', args, {encoding: 'utf8'});

if (command === 'status') {
  console.log(JSON.stringify({config, serviceLoaded: launchctl('print', service).status === 0}, null, 2));
  for (const target of await targets().catch(() => [])) {
    const client = await connect(target);
    try {
      const info = await client.evaluate('({url: location.href, health: window.__feiAGPatch?.health(), sshState: window.__feiAGPatch?.sshState?.()})');
      console.log(JSON.stringify(info || {runtime: 'not installed'}, null, 2));
    } finally { client.close(); }
  }
} else if (command === 'disable') {
  await saveConfig({...config, enabled: false});
  launchctl('disable', service);
  launchctl('bootout', service);
  for (const target of await targets().catch(() => [])) {
    const client = await connect(target);
    try { await client.evaluate('window.__feiAGPatch?.dispose()'); }
    finally { client.close(); }
  }
  console.log('Disabled. Native appearance restored. Files and fonts preserved.');
} else if (command === 'enable') {
  await saveConfig({...config, enabled: true});
  launchctl('enable', service);
  if (launchctl('print', service).status !== 0) {
    const result = launchctl('bootstrap', `gui/${process.getuid()}`, plist);
    if (result.status !== 0) throw Error(result.stderr);
  }
  console.log('Enabled. Changes apply within 2.5 seconds.');
} else if (command === 'preset' && presets.includes(value)) {
  await saveConfig({...config, preset: value});
  console.log(`Preset: ${value}`);
} else if (command === 'locale' && ['zh', 'en'].includes(value)) {
  await saveConfig({...config, localize: value === 'zh'});
  console.log(`Localization: ${value}`);
} else if (command === 'ssh') {
  const sub = value || 'status';
  if (sub === 'status') {
    const [pFei, pTunnel, localMacPort] = await Promise.all([
      probeSshHost('fei', 6),
      probeSshHost('fei-tunnel', 8),
      discoverLocalMacLsPort(),
    ]);
    const windows = [];
    for (const target of await targets().catch(() => [])) {
      const client = await connect(target);
      try {
        windows.push(await client.evaluate('({title: document.title, url: location.href, sshState: window.__feiAGPatch?.sshState?.()})'));
      } finally { client.close(); }
    }
    console.log(JSON.stringify({
      sshMode: config.sshMode,
      localMacPort,
      routes: {fei: pFei, 'fei-tunnel': pTunnel},
      windows,
    }, null, 2));
  } else if (sshModes.includes(sub)) {
    await saveConfig({...config, sshMode: sub});
    for (const target of await targets().catch(() => [])) {
      const client = await connect(target);
      try {
        await client.evaluate(`window.__feiAGPatch?.sendSshAction?.({action: 'set-mode', mode: ${JSON.stringify(sub)}})`);
      } finally { client.close(); }
    }
    console.log(`SSH mode set to: ${sub}`);
  } else if (sub === 'connect') {
    const mode = sshModes.includes(extra) && extra !== 'local' ? extra : (config.sshMode === 'local' ? 'auto' : config.sshMode);
    await saveConfig({...config, sshMode: mode});
    const found = await targets().catch(() => []);
    if (found[0]) {
      const client = await connect(found[0]);
      try {
        await client.evaluate(`window.__feiAGPatch?.sendSshAction?.({action: 'connect-window', mode: ${JSON.stringify(mode)}})`);
      } finally { client.close(); }
    }
    console.log(`Connecting active window to remote SSH workspace (mode=${mode})...`);
  } else if (sub === 'switch-local') {
    const found = await targets().catch(() => []);
    if (found[0]) {
      const client = await connect(found[0]);
      try {
        await client.evaluate(`window.__feiAGPatch?.sendSshAction?.({action: 'switch-local'})`);
      } finally { client.close(); }
    }
    console.log('Switching active window back to local macOS workspace...');
  } else if (sub === 'restart') {
    const found = await targets().catch(() => []);
    if (found[0]) {
      const client = await connect(found[0]);
      try {
        await client.evaluate(`window.__feiAGPatch?.sendSshAction?.({action: 'restart-remote'})`);
      } finally { client.close(); }
    }
    console.log('Triggered remote language_server restart and tunnel reconnect.');
  } else {
    console.error('Usage: node ~/.antigravity-patch/patchctl.mjs ssh <status|auto|fei|fei-tunnel|local|connect [mode]|switch-local|restart>');
    process.exitCode = 1;
  }
} else {
  console.error('Usage: node ~/.antigravity-patch/patchctl.mjs status|enable|disable|preset <high-contrast|claude-desktop-purewhite|vintage-deep|native>|locale <zh|en>|ssh <status|auto|fei|fei-tunnel|local|connect|switch-local|restart>');
  process.exitCode = 1;
}
