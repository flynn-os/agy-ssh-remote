import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {patchDir} from './cdp.mjs';
import {SSH_MODES, normalizeSshMode} from './routes.mjs';

export const presets = ['high-contrast', 'claude-desktop-purewhite', 'vintage-deep', 'native'];
export const sshModes = SSH_MODES;
let fontCSS;
let cachedBundle = null;
let cachedBundleKey = '';

async function fileMtimeSig(filePath) {
  try {
    const st = await fs.stat(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '0:0';
  }
}

async function readJsonOptional(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readTextOptional(filePath, fallback = '') {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function normalizeOverrideDict(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return {};
  const source = rawObj.exact && typeof rawObj.exact === 'object' ? rawObj.exact : rawObj;
  const clean = {};
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string') clean[k] = v;
  }
  return clean;
}

async function resolveExistingPath(...relCandidates) {
  for (const rel of relCandidates) {
    const full = path.join(patchDir, rel);
    try {
      await fs.access(full);
      return full;
    } catch {}
  }
  return path.join(patchDir, relCandidates[0]);
}

export async function readConfig() {
  const cfgPath = await resolveExistingPath('config.json', 'config/config.json');
  const config = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  if (!presets.includes(config.preset) || typeof config.localize !== 'boolean' || typeof config.enabled !== 'boolean')
    throw Error('Invalid patch configuration');
  config.sshMode = normalizeSshMode(config.sshMode);

  const userCfgPath = await resolveExistingPath('user/config.json', 'config/user/config.json');
  const userConfig = await readJsonOptional(userCfgPath, {});
  config.modules = {
    i18n: config.localize,
    metrics: config.metrics !== false,
    composerWaxSeal: true,
    deadlockHealer: true,
    customCss: true,
    customJs: true,
    ...(userConfig.modules || {}),
    ...( config.modules || {}),
  };
  config.themeVars = {
    ...(userConfig.themeVars || {}),
    ...(config.themeVars || {}),
  };
  return config;
}

export async function saveConfig(config) {
  const destination = await resolveExistingPath('config.json', 'config/config.json');
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
  await fs.rename(temporary, destination);
}

export async function build(config) {
  const [themePath, customCssPath, dictPath, overridePath, injectPath] = await Promise.all([
    resolveExistingPath('ui/theme.css', 'theme.css'),
    resolveExistingPath('user/custom.css', 'config/user/custom.css'),
    resolveExistingPath('ui/zh-CN.json', 'zh-CN.json'),
    resolveExistingPath('user/i18n.override.json', 'config/user/i18n.override.json'),
    resolveExistingPath('ui/inject.js', 'inject.js'),
  ]);
  const [themeSig, customCssSig, dictSig, overrideSig, injectSig] = await Promise.all([
    fileMtimeSig(themePath),
    config.modules?.customCss !== false ? fileMtimeSig(customCssPath) : Promise.resolve('off'),
    fileMtimeSig(dictPath),
    fileMtimeSig(overridePath),
    fileMtimeSig(injectPath),
  ]);
  const configStr = JSON.stringify(config);
  const cacheKey = `${configStr}|${themeSig}|${customCssSig}|${dictSig}|${overrideSig}|${injectSig}`;
  if (cachedBundle && cachedBundleKey === cacheKey) {
    return cachedBundle;
  }

  if (!fontCSS) {
    const fonts = [
      ['Anthropic Sans', 'AnthropicSans-Roman-Variable-26-179-2.542f0e8bf7a27f23.woff2', 'normal', '100 900'],
      ['Anthropic Sans', 'AnthropicSans-Italic-Web.ffcf21c4e9a729cb.woff2', 'italic', '100 900'],
      ['Anthropic Serif', 'AnthropicSerif-Roman-Variable-26-179-2.ac9c19c70558c515.woff2', 'normal', '100 900'],
      ['Anthropic Mono', 'AnthropicMono-Roman-Web.49b8b95c950b0bee.woff2', 'normal', '400'],
    ];
    fontCSS = '';
    for (const [family, filename, style, weight] of fonts) {
      const fontPath = await resolveExistingPath(path.join('assets/fonts', filename), path.join('fonts', filename));
      const data = await fs.readFile(fontPath);
      fontCSS += `@font-face {font-family:'${family}';src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');font-style:${style};font-weight:${weight};font-display:swap;}\n`;
    }
  }
  const baseCss = await fs.readFile(themePath, 'utf8');
  const customCss = config.modules?.customCss !== false
    ? await readTextOptional(customCssPath, '')
    : '';
  const css = fontCSS + baseCss + (customCss ? `\n${customCss}` : '');

  const baseDict = JSON.parse(await fs.readFile(dictPath, 'utf8'));
  const overrideRaw = await readJsonOptional(overridePath, {});
  const dictionary = {...baseDict, ...normalizeOverrideDict(overrideRaw)};

  const installer = await fs.readFile(injectPath, 'utf8');
  const dictStr = JSON.stringify(dictionary);
  const signature = crypto.createHash('sha256').update(configStr + css + dictStr + installer).digest('hex').slice(0, 16);
  cachedBundle = {signature, source: `${installer}(${configStr},${JSON.stringify(css)},${dictStr},${JSON.stringify(signature)})`};
  cachedBundleKey = cacheKey;
  return cachedBundle;
}
