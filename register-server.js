/**
 * SillyTavern 注册 + 反向代理一体服务器
 *
 * 对外只暴露一个端口（PUBLIC_PORT）：
 *   - GET  /register  → 返回注册页面
 *   - POST /register  → 处理注册（写入用户、植入默认内容）
 *   - 其余所有请求     → 反向代理到 localhost 上运行的 SillyTavern
 *
 * 这样用户在同一个地址即可注册并登录 SillyTavern 正常使用。
 * SillyTavern 无需任何改动：它继续在内部端口（config.yaml 的 port，默认 8000）
 * 仅监听 localhost，代理从 127.0.0.1 连接它，正好通过其 IP 白名单。
 *
 * 用法: node register-server.js [--port <对外端口>]
 *   对外端口默认 8080，可用 --port 或环境变量 PUBLIC_PORT 修改。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

import express from 'express';
import storage from 'node-persist';
import yaml from 'yaml';
import _ from 'lodash';
import { ZipArchive } from 'archiver';
import extract from 'extract-zip';
import { createRequire } from 'node:module';
import multer from 'multer';

const require = createRequire(import.meta.url);
const FormData = require('form-data');

import { mountAdmin } from './admin.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWN_CONFIG_PATH = path.join(__dirname, 'config.yaml');

// 读取 st-register 自己的配置（不影响 SillyTavern 的 config.yaml）
let ownConfig = {};
try {
    if (fs.existsSync(OWN_CONFIG_PATH)) {
        ownConfig = yaml.parse(fs.readFileSync(OWN_CONFIG_PATH, 'utf8')) || {};
    } else {
        console.warn(`未找到 ${OWN_CONFIG_PATH}，将使用默认值。`);
    }
} catch (err) {
    console.error('无法读取 st-register config.yaml:', err.message);
    process.exit(1);
}

// 获取 SillyTavern 目录路径（从配置文件读取，或使用默认值）
const stPath = (ownConfig.sillyTavern && ownConfig.sillyTavern.path) || '';
const ST_DIR = stPath
    ? (path.isAbsolute(stPath) ? stPath : path.resolve(__dirname, stPath))
    : path.join(__dirname, '..', 'SillyTavern');
const ST_CONFIG_PATH = path.join(ST_DIR, 'config.yaml');

console.log(`SillyTavern 目录: ${ST_DIR}`);

// 读取 SillyTavern 的配置（仅用于定位数据目录与内部端口，只读不改）
let stConfig;
try {
    if (!fs.existsSync(ST_CONFIG_PATH)) {
        console.error(`错误: 未找到 SillyTavern 配置文件: ${ST_CONFIG_PATH}`);
        console.error(`请在 config.yaml 中设置正确的 sillyTavern.path 路径`);
        console.error(`例如: sillyTavern.path: "/data/SillyTavern"`);
        process.exit(1);
    }
    stConfig = yaml.parse(fs.readFileSync(ST_CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error('无法读取 SillyTavern config.yaml:', err.message);
    process.exit(1);
}

// 对外公开端口：命令行 --port > 环境变量 > 自身配置 > 默认 8080
const cliArgs = process.argv.slice(2);
const portIdx = cliArgs.indexOf('--port');
const PUBLIC_PORT = parseInt(
    (portIdx >= 0 ? cliArgs[portIdx + 1] : null)
    || process.env.PUBLIC_PORT
    || ownConfig.publicPort
    || '8080',
    10,
);

const DATA_ROOT = path.resolve(ST_DIR, stConfig.dataRoot || './data');
// SillyTavern 内部端口：优先自身配置，否则读 SillyTavern 的 port
const ST_PORT = (ownConfig.sillyTavern && ownConfig.sillyTavern.port) || stConfig.port || 8000;
const ST_HOST = (ownConfig.sillyTavern && ownConfig.sillyTavern.host) || '127.0.0.1';
const STORAGE_DIR = path.join(DATA_ROOT, '_storage');
const CONTENT_DIR = path.join(ST_DIR, 'default', 'content');
const CONTENT_INDEX_PATH = path.join(CONTENT_DIR, 'index.json');

// 后台管理配置
const ADMIN_CONFIG = {
    enabled: !!(ownConfig.admin && ownConfig.admin.enabled),
    password: (ownConfig.admin && ownConfig.admin.password) || '',
};

// 注册配置（可在后台修改并写回 config.yaml）。maxUsers: 0 表示不限制。
const REGISTRATION = {
    maxUsers: Math.max(0, parseInt(
        (ownConfig.registration && ownConfig.registration.maxUsers) || 0, 10) || 0),
};

// 备份/恢复临时目录配置（可在后台修改并写回 config.yaml）
const _backup = ownConfig.backup || {};
const BACKUP_TEMP_CONFIG = {
    tempDir: _backup.tempDir || '',  // 留空 = 使用系统临时目录
    autoCleanupHours: Math.max(0, parseInt(_backup.autoCleanupHours, 10) || 24),
};

// 获取临时目录路径
function getTempDir() {
    if (BACKUP_TEMP_CONFIG.tempDir) {
        // 使用配置的目录（相对或绝对路径）
        const dir = path.isAbsolute(BACKUP_TEMP_CONFIG.tempDir)
            ? BACKUP_TEMP_CONFIG.tempDir
            : path.resolve(__dirname, BACKUP_TEMP_CONFIG.tempDir);

        // 确保目录存在
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    } else {
        // 使用系统临时目录
        return os.tmpdir();
    }
}

// 保存备份配置到 config.yaml
function saveBackupConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.tempDir === 'string') {
        doc.setIn(['backup', 'tempDir'], patch.tempDir);
        BACKUP_TEMP_CONFIG.tempDir = patch.tempDir;
    }
    if (typeof patch.autoCleanupHours === 'number' && Number.isFinite(patch.autoCleanupHours)) {
        const v = Math.max(0, Math.floor(patch.autoCleanupHours));
        doc.setIn(['backup', 'autoCleanupHours'], v);
        BACKUP_TEMP_CONFIG.autoCleanupHours = v;
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
}

// 保存 SillyTavern 路径配置到 config.yaml
function saveSillyTavernConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.path === 'string') {
        doc.setIn(['sillyTavern', 'path'], patch.path);
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
}

// ─── SillyTavern config.yaml「傻瓜配置」读写 ───────────────────────────────────
// 这里读写的是 SillyTavern 自己的 config.yaml（ST_CONFIG_PATH），只暴露最常用、
// 但新手容易困惑的一小部分参数，用友好的开关/输入框呈现。写回时用 parseDocument
// 保留文件原有结构与其它字段，绝不动未涉及的项。修改后需重启 SillyTavern 才生效。

// 字段定义：单一数据源，读、写、前端都按它来。type: bool | str | num | select
// path 是 config.yaml 里的键路径；bdefault 给布尔默认值（true 表示「缺省即开」）。
const ST_SETTING_FIELDS = [
    // 🌐 网络与访问
    { key: 'requestProxyEnabled', path: ['requestProxy', 'enabled'], type: 'bool', bdefault: false },
    { key: 'requestProxyUrl', path: ['requestProxy', 'url'], type: 'str' },
    { key: 'listen', path: ['listen'], type: 'bool', bdefault: false },
    { key: 'whitelistMode', path: ['whitelistMode'], type: 'bool', bdefault: true },
    { key: 'enableCorsProxy', path: ['enableCorsProxy'], type: 'bool', bdefault: false },
    { key: 'port', path: ['port'], type: 'num', ndefault: 8000 },
    // 🔒 安全与账户
    { key: 'enableUserAccounts', path: ['enableUserAccounts'], type: 'bool', bdefault: true },
    { key: 'enableDiscreetLogin', path: ['enableDiscreetLogin'], type: 'bool', bdefault: false },
    { key: 'basicAuthMode', path: ['basicAuthMode'], type: 'bool', bdefault: false },
    { key: 'basicAuthUsername', path: ['basicAuthUser', 'username'], type: 'str' },
    { key: 'basicAuthPassword', path: ['basicAuthUser', 'password'], type: 'str' },
    { key: 'sessionTimeout', path: ['sessionTimeout'], type: 'num', ndefault: -1, min: -1 },
    // 💾 备份
    { key: 'numberOfBackups', path: ['backups', 'common', 'numberOfBackups'], type: 'num', ndefault: 50, min: 0 },
    { key: 'chatBackupEnabled', path: ['backups', 'chat', 'enabled'], type: 'bool', bdefault: true },
    { key: 'chatCheckIntegrity', path: ['backups', 'chat', 'checkIntegrity'], type: 'bool', bdefault: true },
    { key: 'chatMaxTotalBackups', path: ['backups', 'chat', 'maxTotalBackups'], type: 'num', ndefault: -1, min: -1 },
    { key: 'allowFullDataBackup', path: ['backups', 'allowFullDataBackup'], type: 'bool', bdefault: true },
    // 🧩 扩展与功能
    { key: 'extensionsEnabled', path: ['extensions', 'enabled'], type: 'bool', bdefault: true },
    { key: 'extensionsAutoUpdate', path: ['extensions', 'autoUpdate'], type: 'bool', bdefault: true },
    { key: 'extensionModelsAutoDownload', path: ['extensions', 'models', 'autoDownload'], type: 'bool', bdefault: true },
    { key: 'enableServerPlugins', path: ['enableServerPlugins'], type: 'bool', bdefault: false },
    { key: 'enableServerPluginsAutoUpdate', path: ['enableServerPluginsAutoUpdate'], type: 'bool', bdefault: true },
    { key: 'enableDownloadableTokenizers', path: ['enableDownloadableTokenizers'], type: 'bool', bdefault: true },
    // 🖼️ 缩略图与性能
    { key: 'thumbnailsEnabled', path: ['thumbnails', 'enabled'], type: 'bool', bdefault: true },
    { key: 'thumbnailsQuality', path: ['thumbnails', 'quality'], type: 'num', ndefault: 95, min: 1, max: 100 },
    { key: 'thumbnailsFormat', path: ['thumbnails', 'format'], type: 'select', options: ['jpg', 'png'], sdefault: 'jpg' },
    { key: 'lazyLoadCharacters', path: ['performance', 'lazyLoadCharacters'], type: 'bool', bdefault: false },
    { key: 'useDiskCache', path: ['performance', 'useDiskCache'], type: 'bool', bdefault: true },
    // ⚙️ 启动与日志
    { key: 'browserLaunch', path: ['browserLaunch', 'enabled'], type: 'bool', bdefault: true },
    { key: 'enableAccessLog', path: ['logging', 'enableAccessLog'], type: 'bool', bdefault: true },
];

function getIn(obj, keyPath) {
    let cur = obj;
    for (const k of keyPath) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[k];
    }
    return cur;
}

// 读取当前 SillyTavern config.yaml 中这些参数的值（每次都读最新文件）。
function readSillyTavernSettings() {
    let cfg = {};
    const exists = fs.existsSync(ST_CONFIG_PATH);
    if (exists) {
        cfg = yaml.parse(fs.readFileSync(ST_CONFIG_PATH, 'utf8')) || {};
    }
    const out = { exists, configPath: ST_CONFIG_PATH };
    for (const f of ST_SETTING_FIELDS) {
        const v = getIn(cfg, f.path);
        if (f.type === 'bool') {
            out[f.key] = (v === undefined ? !!f.bdefault : v === true);
        } else if (f.type === 'num') {
            out[f.key] = (v == null ? f.ndefault : v);
        } else if (f.type === 'select') {
            out[f.key] = (v == null ? f.sdefault : String(v));
        } else { // str
            out[f.key] = (v == null ? '' : String(v));
        }
    }
    return out;
}

// 把后台传来的补丁写回 SillyTavern config.yaml（保留注释与其它字段）。
function saveSillyTavernSettings(patch) {
    if (!fs.existsSync(ST_CONFIG_PATH)) {
        throw new Error('未找到 SillyTavern config.yaml: ' + ST_CONFIG_PATH);
    }
    const doc = yaml.parseDocument(fs.readFileSync(ST_CONFIG_PATH, 'utf8'));
    for (const f of ST_SETTING_FIELDS) {
        const v = patch[f.key];
        if (v === undefined) continue;
        if (f.type === 'bool') {
            if (typeof v === 'boolean') doc.setIn(f.path, v);
        } else if (f.type === 'num') {
            let n = parseInt(v, 10);
            if (!Number.isFinite(n)) continue;
            if (f.min != null) n = Math.max(f.min, n);
            if (f.max != null) n = Math.min(f.max, n);
            doc.setIn(f.path, n);
        } else if (f.type === 'select') {
            if (f.options.includes(String(v))) doc.setIn(f.path, String(v));
        } else { // str
            if (typeof v === 'string') doc.setIn(f.path, v);
        }
    }
    fs.writeFileSync(ST_CONFIG_PATH, doc.toString());
}

// 清理旧的临时文件
function cleanupOldTempFiles() {
    try {
        const tempDir = getTempDir();
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        const maxAge = BACKUP_TEMP_CONFIG.autoCleanupHours * 60 * 60 * 1000;

        if (maxAge === 0) return; // 不自动清理

        let cleaned = 0;
        for (const file of files) {
            // 只清理我们创建的临时文件
            if (file.startsWith('backup-') || file.startsWith('git-temp-') ||
                file.startsWith('git-restore-') || file.startsWith('backup-before-restore-')) {

                const filePath = path.join(tempDir, file);
                try {
                    const stats = fs.statSync(filePath);

                    // 删除超过指定时间的文件
                    if (now - stats.mtimeMs > maxAge) {
                        fs.rmSync(filePath, { recursive: true, force: true });
                        cleaned++;
                    }
                } catch (err) {
                    // 忽略无法访问的文件
                }
            }
        }

        if (cleaned > 0) {
            console.log(`[清理] 已清理 ${cleaned} 个旧临时文件（超过 ${BACKUP_TEMP_CONFIG.autoCleanupHours} 小时）`);
        }
    } catch (err) {
        console.error('[清理] 清理临时文件失败:', err.message);
    }
}

// 服务器公网信息（启动时获取一次并缓存在内存，登录页展示）。
const SERVER_INFO = { ip: '', location: '' };

// 启动时请求免费地理服务，获取服务器公网 IP 与中文归属地。失败则静默留空，
// 不阻塞服务启动。结果缓存在 SERVER_INFO，不重复请求。
async function fetchServerInfo() {
    try {
        if (typeof fetch !== 'function') {
            console.warn('当前 Node 版本不支持全局 fetch（需 18+），跳过公网信息获取。');
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const url = 'http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,query';
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        const data = await resp.json();
        if (data && data.status === 'success') {
            SERVER_INFO.ip = data.query || '';
            SERVER_INFO.location = [data.country, data.regionName, data.city]
                .filter(Boolean).join('·');
            console.log(`服务器公网信息: ${SERVER_INFO.ip} · ${SERVER_INFO.location}`);
        } else {
            console.warn('获取服务器公网信息失败:', (data && data.message) || '未知错误');
        }
    } catch (err) {
        console.warn('获取服务器公网信息失败:', err.message);
    }
}

// 网站外观配置（可在后台修改并写回 config.yaml）。运行时共享对象，
// 后台保存后直接更新其字段，登录/注册/后台页面读取它实时生效。
const SITE = {
    title: (ownConfig.site && ownConfig.site.title) || 'SillyTavern',
    logo: (ownConfig.site && ownConfig.site.logo) || '',
};

// 背景图配置（可在后台修改并写回 config.yaml）。运行时共享对象。
const _bg = ownConfig.background || {};
const BACKGROUND = {
    mode: ['api', 'urls', 'local', 'folder'].includes(_bg.mode) ? _bg.mode : 'none',
    api: _bg.api || '',
    urls: Array.isArray(_bg.urls) ? _bg.urls.filter(Boolean) : [],
    local: _bg.local || '',
    folder: _bg.folder || '',
    dim: Math.min(100, Math.max(0, parseInt(_bg.dim, 10) >= 0 ? parseInt(_bg.dim, 10) : 45)),
    blur: Math.max(0, parseInt(_bg.blur, 10) || 0),
};

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'];
function isImageFile(name) {
    return IMAGE_EXTS.includes(path.extname(String(name)).toLowerCase());
}
// 把背景用的本地路径解析为绝对路径（相对路径基于 st-register 目录）。
function resolveBgPath(p) {
    if (!p) return '';
    return path.isAbsolute(p) ? p : path.resolve(__dirname, p);
}

/**
 * 把背景配置写回 config.yaml，保留注释。
 * @param {object} patch
 */
function saveBackgroundConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (['none', 'api', 'urls', 'local', 'folder'].includes(patch.mode)) {
        doc.setIn(['background', 'mode'], patch.mode); BACKGROUND.mode = patch.mode;
    }
    if (typeof patch.api === 'string') { doc.setIn(['background', 'api'], patch.api); BACKGROUND.api = patch.api; }
    if (typeof patch.local === 'string') { doc.setIn(['background', 'local'], patch.local); BACKGROUND.local = patch.local; }
    if (typeof patch.folder === 'string') { doc.setIn(['background', 'folder'], patch.folder); BACKGROUND.folder = patch.folder; }
    if (Array.isArray(patch.urls)) {
        const clean = patch.urls.map(u => String(u).trim()).filter(Boolean);
        doc.setIn(['background', 'urls'], clean); BACKGROUND.urls = clean;
    }
    if (typeof patch.dim === 'number' && Number.isFinite(patch.dim)) {
        const v = Math.min(100, Math.max(0, Math.floor(patch.dim)));
        doc.setIn(['background', 'dim'], v); BACKGROUND.dim = v;
    }
    if (typeof patch.blur === 'number' && Number.isFinite(patch.blur)) {
        const v = Math.max(0, Math.floor(patch.blur));
        doc.setIn(['background', 'blur'], v); BACKGROUND.blur = v;
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
}

// 卡片样式配置（可在后台修改并写回 config.yaml）。运行时共享对象。
const _card = ownConfig.card || {};
function cleanColor(v, fallback) {
    return (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())) ? v.trim() : fallback;
}
// 字体族关键字 → CSS 字体栈（全用系统字体回退，无需加载 web 字体）
const FONT_STACKS = {
    system: "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
    rounded: "'Segoe UI Rounded','Varela Round','Quicksand','PingFang SC','Microsoft YaHei',sans-serif",
    serif: "Georgia,'Times New Roman','Songti SC','SimSun',serif",
    mono: "'Consolas','Monaco','Courier New','Microsoft YaHei',monospace",
};
function cleanFont(v) {
    return Object.prototype.hasOwnProperty.call(FONT_STACKS, v) ? v : 'system';
}
const CARD = {
    accent: cleanColor(_card.accent, '#7c3aed'),
    accent2: cleanColor(_card.accent2, '#e94560'),
    opacity: Math.min(100, Math.max(0, parseInt(_card.opacity, 10) >= 0 ? parseInt(_card.opacity, 10) : 72)),
    radius: Math.min(40, Math.max(0, parseInt(_card.radius, 10) >= 0 ? parseInt(_card.radius, 10) : 22)),
    blur: Math.min(60, Math.max(0, parseInt(_card.blur, 10) >= 0 ? parseInt(_card.blur, 10) : 22)),
    textColor: cleanColor(_card.textColor, '#e8eaf2'),
    titleColor: (typeof _card.titleColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(_card.titleColor.trim())) ? _card.titleColor.trim() : '',
    fontScale: Math.min(150, Math.max(70, parseInt(_card.fontScale, 10) >= 0 ? parseInt(_card.fontScale, 10) : 100)),
    fontFamily: cleanFont(_card.fontFamily),
};

/**
 * 把卡片样式写回 config.yaml，保留注释。改后让页面缓存失效。
 */
function saveCardConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(patch.accent)) {
        doc.setIn(['card', 'accent'], patch.accent); CARD.accent = patch.accent;
    }
    if (typeof patch.accent2 === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(patch.accent2)) {
        doc.setIn(['card', 'accent2'], patch.accent2); CARD.accent2 = patch.accent2;
    }
    if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) {
        const v = Math.min(100, Math.max(0, Math.floor(patch.opacity)));
        doc.setIn(['card', 'opacity'], v); CARD.opacity = v;
    }
    if (typeof patch.radius === 'number' && Number.isFinite(patch.radius)) {
        const v = Math.min(40, Math.max(0, Math.floor(patch.radius)));
        doc.setIn(['card', 'radius'], v); CARD.radius = v;
    }
    if (typeof patch.blur === 'number' && Number.isFinite(patch.blur)) {
        const v = Math.min(60, Math.max(0, Math.floor(patch.blur)));
        doc.setIn(['card', 'blur'], v); CARD.blur = v;
    }
    if (typeof patch.textColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(patch.textColor)) {
        doc.setIn(['card', 'textColor'], patch.textColor); CARD.textColor = patch.textColor;
    }
    if (typeof patch.titleColor === 'string') {
        // 空字符串 = 恢复彩色渐变标题
        const v = /^#[0-9a-fA-F]{3,8}$/.test(patch.titleColor) ? patch.titleColor : '';
        doc.setIn(['card', 'titleColor'], v); CARD.titleColor = v;
    }
    if (typeof patch.fontScale === 'number' && Number.isFinite(patch.fontScale)) {
        const v = Math.min(150, Math.max(70, Math.floor(patch.fontScale)));
        doc.setIn(['card', 'fontScale'], v); CARD.fontScale = v;
    }
    if (typeof patch.fontFamily === 'string' && Object.prototype.hasOwnProperty.call(FONT_STACKS, patch.fontFamily)) {
        doc.setIn(['card', 'fontFamily'], patch.fontFamily); CARD.fontFamily = patch.fontFamily;
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
    bumpConfigVersion(); // 卡片样式注入在页面 HTML 中，需让缓存重建
}

// 友情链接配置（可在后台修改并写回 config.yaml）。运行时共享对象。
const _fl = ownConfig.friendLinks || {};
function cleanLinks(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map(x => ({
            name: String((x && x.name) || '').trim(),
            url: String((x && x.url) || '').trim(),
        }))
        .filter(x => x.name && /^https?:\/\//i.test(x.url))
        .slice(0, 50);
}
const FRIEND_LINKS = {
    enabled: !!_fl.enabled,
    links: cleanLinks(_fl.links),
};

/**
 * 把友情链接写回 config.yaml，保留注释。
 */
function saveFriendLinksConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.enabled === 'boolean') {
        doc.setIn(['friendLinks', 'enabled'], patch.enabled); FRIEND_LINKS.enabled = patch.enabled;
    }
    if (Array.isArray(patch.links)) {
        const clean = cleanLinks(patch.links);
        doc.setIn(['friendLinks', 'links'], clean); FRIEND_LINKS.links = clean;
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
}

/**
 * 把网站外观写回 st-register 的 config.yaml，保留文件中的注释与其它字段。
 * @param {{title?: string, logo?: string}} patch
 */
function saveSiteConfig(patch) {
    // 用 parseDocument 保留注释
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.title === 'string') {
        doc.setIn(['site', 'title'], patch.title);
        SITE.title = patch.title;
    }
    if (typeof patch.logo === 'string') {
        doc.setIn(['site', 'logo'], patch.logo);
        SITE.logo = patch.logo;
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
    bumpConfigVersion();
}

// 公告配置（可在后台修改并写回 config.yaml）。运行时共享对象。
const ANNOUNCE = {
    enabled: !!(ownConfig.announcement && ownConfig.announcement.enabled),
    content: (ownConfig.announcement && ownConfig.announcement.content) || '',
    frequency: (ownConfig.announcement && ownConfig.announcement.frequency) === 'always' ? 'always' : 'once',
};

// 轻量 Markdown 渲染器（纯前端、无外部依赖）。先转义 HTML 防 XSS，再解析常用
// Markdown 语法：标题、粗体/斜体、行内代码、代码块、链接、列表、引用、分割线。
// 同时被「公告弹窗」与「后台预览」复用，保证渲染效果一致。
const MD_RENDERER_JS = `
  function stEscapeHtml(s){
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function stMarkdownCss(){
    return '.st-md-body h1,.st-md-body h2,.st-md-body h3{margin:.6em 0 .4em;line-height:1.3;color:#fff;font-weight:700}'
      +'.st-md-body h1{font-size:1.4em}.st-md-body h2{font-size:1.2em}.st-md-body h3{font-size:1.05em}'
      +'.st-md-body p{margin:.5em 0}.st-md-body ul,.st-md-body ol{margin:.5em 0;padding-left:1.5em}'
      +'.st-md-body li{margin:.2em 0}.st-md-body a{color:#b9a3ff;text-decoration:underline}'
      +'.st-md-body code{background:rgba(255,255,255,0.1);padding:1px 6px;border-radius:5px;font-family:Consolas,Monaco,monospace;font-size:.92em}'
      +'.st-md-body pre{background:rgba(0,0,0,0.35);padding:12px 14px;border-radius:9px;overflow:auto;margin:.6em 0}'
      +'.st-md-body pre code{background:none;padding:0}'
      +'.st-md-body blockquote{margin:.6em 0;padding:.2em 0 .2em 14px;border-left:3px solid #7c3aed;color:#aab0c6}'
      +'.st-md-body hr{border:none;border-top:1px solid rgba(255,255,255,0.15);margin:1em 0}'
      +'.st-md-body strong{color:#fff}.st-md-body img{max-width:100%;border-radius:8px}';
  }
  function stRenderMarkdown(src){
    src = String(src==null?'':src).replace(/\\r\\n/g,'\\n');
    // 先抽取代码块，避免内部内容被其它规则误处理
    var blocks = [];
    src = src.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(_, code){
      blocks.push('<pre><code>' + stEscapeHtml(code.replace(/^\\n/,'').replace(/\\n$/,'')) + '</code></pre>');
      return '\\u0000BLOCK' + (blocks.length-1) + '\\u0000';
    });
    // 整体转义
    src = stEscapeHtml(src);
    // 行内代码
    src = src.replace(/\`([^\`]+)\`/g, function(_, c){ return '<code>'+c+'</code>'; });
    // 图片 ![alt](url) 先于链接
    src = src.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g, '<img alt="$1" src="$2">');
    // 链接 [text](url)
    src = src.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 粗体 / 斜体
    src = src.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    src = src.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>');
    // 按行处理标题 / 引用 / 列表 / 分割线
    var lines = src.split('\\n'), out = [], i = 0, listType = null;
    function closeList(){ if(listType){ out.push('</'+listType+'>'); listType=null; } }
    for(; i<lines.length; i++){
      var ln = lines[i];
      if(/^\\u0000BLOCK\\d+\\u0000$/.test(ln.trim())){ closeList(); out.push(ln.trim()); continue; }
      if(/^\\s*---+\\s*$/.test(ln)){ closeList(); out.push('<hr>'); continue; }
      var hm = ln.match(/^(#{1,3})\\s+(.*)$/);
      if(hm){ closeList(); out.push('<h'+hm[1].length+'>'+hm[2]+'</h'+hm[1].length+'>'); continue; }
      var q = ln.match(/^&gt;\\s?(.*)$/);
      if(q){ closeList(); out.push('<blockquote>'+q[1]+'</blockquote>'); continue; }
      var ol = ln.match(/^\\s*\\d+\\.\\s+(.*)$/);
      var ul = ln.match(/^\\s*[-*]\\s+(.*)$/);
      if(ol){ if(listType!=='ol'){ closeList(); out.push('<ol>'); listType='ol'; } out.push('<li>'+ol[1]+'</li>'); continue; }
      if(ul){ if(listType!=='ul'){ closeList(); out.push('<ul>'); listType='ul'; } out.push('<li>'+ul[1]+'</li>'); continue; }
      if(ln.trim()===''){ closeList(); continue; }
      closeList(); out.push('<p>'+ln+'</p>');
    }
    closeList();
    var html = out.join('\\n');
    // 还原代码块
    html = html.replace(/\\u0000BLOCK(\\d+)\\u0000/g, function(_, n){ return blocks[+n]||''; });
    return html;
  }`;

/**
 * 把公告设置写回 config.yaml，保留注释与其它字段。
 * @param {{enabled?: boolean, content?: string, frequency?: string}} patch
 */
function saveAnnounceConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.enabled === 'boolean') {
        doc.setIn(['announcement', 'enabled'], patch.enabled);
        ANNOUNCE.enabled = patch.enabled;
    }
    if (typeof patch.content === 'string') {
        doc.setIn(['announcement', 'content'], patch.content);
        ANNOUNCE.content = patch.content;
    }
    if (patch.frequency === 'once' || patch.frequency === 'always') {
        doc.setIn(['announcement', 'frequency'], patch.frequency);
        ANNOUNCE.frequency = patch.frequency;
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
    bumpConfigVersion();
}

/**
 * 把注册配置写回 config.yaml，保留注释。
 * @param {{maxUsers?: number}} patch
 */
function saveRegistrationConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.maxUsers === 'number' && Number.isFinite(patch.maxUsers)) {
        const v = Math.max(0, Math.floor(patch.maxUsers));
        doc.setIn(['registration', 'maxUsers'], v);
        REGISTRATION.maxUsers = v;
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
    bumpConfigVersion();
}

/**
 * 统计已注册用户数（不含系统回退账户 default-user）。
 * @returns {Promise<number>}
 */
async function countUsers() {
    const keys = await storage.keys(x => x.key.startsWith(KEY_PREFIX));
    let n = 0;
    for (const k of keys) {
        if (k.replace(KEY_PREFIX, '') !== 'default-user') n++;
    }
    return n;
}

// ─── 渲染缓存 ─────────────────────────────────────────────────────────────────
// 登录/注册页面、公告脚本只在配置变化时才需重新生成。用版本号做失效标记，
// 后台保存设置时调用 bumpConfigVersion()，下次请求自然重建缓存。
let _configVersion = 0;
function bumpConfigVersion() { _configVersion++; }

// 按当前配置版本缓存生成结果，版本未变直接复用。
function makeVersionedCache(builder) {
    let cachedVersion = -1;
    let cachedValue = null;
    return function (...args) {
        if (cachedVersion !== _configVersion) {
            cachedValue = builder(...args);
            cachedVersion = _configVersion;
        }
        return cachedValue;
    };
}
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderBrand() {
    const title = escapeHtml(SITE.title || 'SillyTavern');
    if (SITE.logo) {
        return `<img class="brand-logo" src="${escapeHtml(SITE.logo)}" alt="${title}">`;
    }
    return `<div class="logo">${title}</div>`;
}

console.log(`SillyTavern 数据目录: ${DATA_ROOT}`);
console.log(`SillyTavern 内部地址: http://${ST_HOST}:${ST_PORT}`);
console.log(`存储目录:             ${STORAGE_DIR}`);

// ─── User directory template (mirrors src/constants.js) ──────────────────────

const USER_DIRECTORY_TEMPLATE = {
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
};

const KEY_PREFIX = 'user:';

// ─── Utility functions (mirrors src/users.js) ────────────────────────────────

function slugify(text) {
    return _.deburr(String(text ?? '').toLowerCase().trim())
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function getPasswordSalt() {
    return crypto.randomBytes(16).toString('base64');
}

function getPasswordHash(password, salt) {
    return crypto.scryptSync(password.normalize(), salt, 64).toString('base64');
}

function toKey(handle) {
    return KEY_PREFIX + handle;
}

function getUserDirectories(handle) {
    const dirs = {};
    for (const key of Object.keys(USER_DIRECTORY_TEMPLATE)) {
        dirs[key] = path.join(DATA_ROOT, handle, USER_DIRECTORY_TEMPLATE[key]);
    }
    return dirs;
}

function createUserDirectories(handle) {
    const dirs = getUserDirectories(handle);
    for (const dir of Object.values(dirs)) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`  已创建: ${dir}`);
        }
    }
}

// ─── Default content seeding (mirrors src/endpoints/content-manager.js) ───────

// Maps a content type to the user directory key it should be copied into.
// Only user-scoped types are listed; global types (error_page, stylesheet)
// are skipped because they are not per-user.
const CONTENT_TYPE_TO_DIR_KEY = {
    settings: 'root',
    character: 'characters',
    sprites: 'characters',
    background: 'backgrounds',
    world: 'worlds',
    avatar: 'avatars',
    theme: 'themes',
    workflow: 'comfyWorkflows',
    kobold_preset: 'koboldAI_Settings',
    openai_preset: 'openAI_Settings',
    novel_preset: 'novelAI_Settings',
    textgen_preset: 'textGen_Settings',
    instruct: 'instruct',
    context: 'context',
    moving_ui: 'movingUI',
    quick_replies: 'quickreplies',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
};

/**
 * Reads the default content index (user-scoped items only).
 * @returns {Array<{filename: string, type: string}>}
 */
function getContentIndex() {
    if (!fs.existsSync(CONTENT_INDEX_PATH)) {
        console.warn(`未找到默认内容索引: ${CONTENT_INDEX_PATH}`);
        return [];
    }
    try {
        const text = fs.readFileSync(CONTENT_INDEX_PATH, 'utf8');
        const index = JSON.parse(text);
        return Array.isArray(index) ? index : [];
    } catch (err) {
        console.warn('读取默认内容索引失败:', err.message);
        return [];
    }
}

/**
 * Seeds default content (settings.json, themes, presets, default character,
 * backgrounds, etc.) into a freshly created user's directories. Mirrors
 * SillyTavern's seedContentForUser so the new account boots normally instead
 * of hanging on initialization.
 * @param {string} handle User handle
 */
function seedDefaultContent(handle) {
    const directories = getUserDirectories(handle);
    const contentIndex = getContentIndex();
    const contentLogPath = path.join(directories.root, 'content.log');

    // Load existing content log (files already seeded) to avoid duplicates.
    const contentLog = fs.existsSync(contentLogPath)
        ? fs.readFileSync(contentLogPath, 'utf8').split('\n')
        : [];

    let copied = 0;
    for (const item of contentIndex) {
        if (!item || !item.filename || !item.type) {
            continue;
        }

        // Skip already-logged files.
        if (contentLog.includes(item.filename)) {
            continue;
        }

        const dirKey = CONTENT_TYPE_TO_DIR_KEY[item.type];
        if (!dirKey) {
            // Global or unknown type — not user content.
            continue;
        }

        const sourcePath = path.join(CONTENT_DIR, item.filename);
        if (!fs.existsSync(sourcePath)) {
            console.warn(`默认内容文件缺失: ${item.filename}`);
            continue;
        }

        const targetDir = directories[dirKey];
        const baseName = path.parse(item.filename).base;
        const targetPath = path.join(targetDir, baseName);

        contentLog.push(item.filename);

        if (fs.existsSync(targetPath)) {
            continue;
        }

        fs.mkdirSync(targetDir, { recursive: true });
        fs.cpSync(sourcePath, targetPath, { recursive: true, force: false });
        copied++;
    }

    fs.writeFileSync(contentLogPath, contentLog.join('\n'));
    console.log(`  植入默认内容: ${copied} 个文件`);
}


// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

// 注意：body 解析器只挂在 /register 上，绝不能全局使用，
// 否则会消费掉需要原样转发给 SillyTavern 的请求体。
const jsonParser = express.json();
const formParser = express.urlencoded({ extended: true });

// ─── Simple rate limiter ─────────────────────────────────────────────────────

const rateLimitMap = new Map(); // IP -> { count, resetTime }
const RATE_LIMIT_MAX = 5;       // max registrations
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

function rateLimiter(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetTime) {
        entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
        rateLimitMap.set(ip, entry);
    }

    if (entry.count >= RATE_LIMIT_MAX) {
        const minutes = Math.ceil((entry.resetTime - now) / 60000);
        return res.status(429).json({
            error: `注册尝试次数过多，请在 ${minutes} 分钟后重试。`,
        });
    }

    req._rateLimitEntry = entry;
    next();
}

// 定期清理过期的限流记录，避免 Map 随独立 IP 数量无限增长（内存泄漏）。
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetTime) rateLimitMap.delete(ip);
    }
}, RATE_LIMIT_WINDOW).unref();

// ─── HTML page ───────────────────────────────────────────────────────────────

// ST_PORT is injected into the template — login link points to the real
// SillyTavern server so the user can sign in after registering.
// 现代化外观覆盖样式：玻璃拟态 + 渐变背景 + 漂浮光斑 + 渐变标题/按钮 +
// 输入聚焦光晕 + 卡片入场动画。追加到各页面 <style> 末尾以覆盖基础样式，
// 因此无需改动任何页面的 HTML 结构与脚本逻辑。
const MODERN_OVERRIDES = `
        /* ===== 现代化美化覆盖 ===== */
        * { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
        body {
            font-family: 'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
            background: #070a14;
            background-image:
                radial-gradient(at 18% 18%, rgba(124,58,237,0.28), transparent 42%),
                radial-gradient(at 82% 6%, rgba(233,69,96,0.22), transparent 44%),
                radial-gradient(at 50% 100%, rgba(14,165,233,0.20), transparent 48%);
            overflow: hidden;
        }
        body::before, body::after {
            content: ''; position: fixed; border-radius: 50%;
            filter: blur(90px); z-index: 0; opacity: 0.55; pointer-events: none;
        }
        body::before {
            width: 420px; height: 420px; background: #7c3aed;
            top: -140px; left: -120px; animation: floatA 16s ease-in-out infinite;
        }
        body::after {
            width: 360px; height: 360px; background: #e94560;
            bottom: -150px; right: -110px; animation: floatB 18s ease-in-out infinite;
        }
        @keyframes floatA { 0%,100% { transform: translate(0,0) } 50% { transform: translate(70px,46px) } }
        @keyframes floatB { 0%,100% { transform: translate(0,0) } 50% { transform: translate(-56px,-44px) } }

        .container {
            position: relative; z-index: 1;
            background: rgba(18, 22, 38, 0.68);
            backdrop-filter: blur(22px) saturate(160%);
            -webkit-backdrop-filter: blur(22px) saturate(160%);
            border: 1px solid rgba(255,255,255,0.09);
            border-radius: 22px;
            padding: 46px 42px;
            box-shadow: 0 24px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07);
            animation: cardIn 0.65s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes cardIn {
            from { opacity: 0; transform: translateY(18px) scale(0.97); }
            to { opacity: 1; transform: none; }
        }

        .logo { color: #8b93ad; font-weight: 600; }
        .brand-logo {
            display: block; max-width: 180px; max-height: 72px;
            margin: 0 auto 6px; object-fit: contain;
        }
        h1 {
            background: linear-gradient(135deg, #ffffff, #c3c9ff 55%, #ff7a92);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent;
            font-size: 28px; letter-spacing: -0.5px;
        }
        .subtitle { color: #8b93ad; }
        label { color: #aab0c6; letter-spacing: 0.6px; }

        input {
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.10);
            border-radius: 13px;
            padding: 13px 16px;
            transition: border-color .2s ease, box-shadow .2s ease, background .2s ease;
        }
        input::placeholder { color: #59617a; }
        input:focus {
            border-color: #8a96ff;
            background: rgba(255,255,255,0.06);
            box-shadow: 0 0 0 4px rgba(124,138,255,0.16);
        }

        button {
            background: linear-gradient(135deg, #7c3aed, #e94560);
            border-radius: 13px; padding: 14px;
            letter-spacing: 0.3px;
            box-shadow: 0 10px 26px rgba(124,58,237,0.38);
            transition: transform .15s ease, box-shadow .2s ease, filter .2s ease;
        }
        button:hover {
            transform: translateY(-2px); filter: brightness(1.08);
            box-shadow: 0 14px 32px rgba(124,58,237,0.48);
        }
        button:active { transform: translateY(0); }

        .error-box { border-radius: 13px; backdrop-filter: blur(8px); }
        .handle-preview span, .footer a { color: #b9a3ff; }
        .user-stats {
            text-align: center; margin: -8px 0 18px; font-size: 13px; color: #8b93ad; min-height: 18px;
        }
        .user-stats b { color: #b9a3ff; font-weight: 600; }
        .user-stats.full b { color: #f59e0b; }
        .footer a:hover { color: #fff; }

        .info-row {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.07);
            border-radius: 13px;
        }
        .info-row code { color: #b9a3ff; }
        .success-box .check {
            width: 74px; height: 74px; line-height: 74px;
            margin: 0 auto 16px; border-radius: 50%; font-size: 36px;
            background: linear-gradient(135deg, #22c55e, #14b8a6);
            color: #fff; box-shadow: 0 12px 32px rgba(34,197,94,0.42);
        }
        .success-box .login-link {
            background: linear-gradient(135deg, #22c55e, #14b8a6);
            border-radius: 13px; box-shadow: 0 10px 26px rgba(20,184,166,0.4);
        }
        .success-box .login-link:hover { transform: translateY(-2px); filter: brightness(1.06); }
`;

function buildHtmlPage(stPort) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>注册 — ${escapeHtml(SITE.title || 'SillyTavern')}</title>
    <style>
        :root {
            --bg: #1a1a2e;
            --surface: #16213e;
            --surface2: #0f3460;
            --accent: #e94560;
            --accent-hover: #ff6b81;
            --text: #eee;
            --text-muted: #999;
            --border: #2a2a4a;
            --input-bg: #111122;
            --success: #4caf84;
            --error: #e94560;
            --radius: 8px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
            background: var(--bg);
            color: var(--text);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 40px;
            width: 100%;
            max-width: 440px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        }
        .logo {
            text-align: center;
            margin-bottom: 8px;
            font-size: 14px;
            color: var(--text-muted);
            letter-spacing: 2px;
            text-transform: uppercase;
        }
        h1 {
            text-align: center;
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .subtitle {
            text-align: center;
            color: var(--text-muted);
            font-size: 14px;
            margin-bottom: 28px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 6px;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        input {
            width: 100%;
            padding: 10px 14px;
            background: var(--input-bg);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            color: var(--text);
            font-size: 15px;
            transition: border-color 0.2s;
            outline: none;
        }
        input:focus {
            border-color: var(--accent);
        }
        .handle-preview {
            font-size: 12px;
            color: var(--text-muted);
            margin-top: 4px;
            font-family: monospace;
        }
        .handle-preview span {
            color: var(--accent);
        }
        button {
            width: 100%;
            padding: 12px;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: var(--radius);
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            margin-top: 8px;
        }
        button:hover { background: var(--accent-hover); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .error-box {
            background: rgba(233, 69, 96, 0.12);
            border: 1px solid var(--error);
            border-radius: var(--radius);
            padding: 12px;
            margin-bottom: 20px;
            color: var(--error);
            font-size: 14px;
            display: none;
        }
        .error-box.show { display: block; }
        .success-box {
            text-align: center;
        }
        .success-box .check {
            font-size: 48px;
            margin-bottom: 12px;
        }
        .success-box h2 { margin-bottom: 8px; }
        .success-box p { color: var(--text-muted); margin-bottom: 6px; font-size: 14px; }
        .success-box .login-link {
            display: inline-block;
            margin-top: 16px;
            padding: 10px 28px;
            background: var(--success);
            color: white;
            text-decoration: none;
            border-radius: var(--radius);
            font-weight: 600;
            transition: opacity 0.2s;
        }
        .success-box .login-link:hover { opacity: 0.85; }
        .info-row {
            background: var(--surface2);
            border-radius: var(--radius);
            padding: 12px 16px;
            margin: 12px 0;
            text-align: left;
            font-size: 13px;
        }
        .info-row strong {
            display: inline-block;
            width: 80px;
            color: var(--text-muted);
        }
        .info-row code {
            color: var(--accent);
            font-size: 13px;
        }
        .footer {
            text-align: center;
            margin-top: 24px;
            font-size: 12px;
            color: var(--text-muted);
        }
        .footer a { color: var(--accent); text-decoration: none; }
        .spinner {
            display: none;
            width: 18px;
            height: 18px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
${MODERN_OVERRIDES}
    </style>
</head>
<body>
    <div class="container" id="app">
        <!-- Registration form (default view) -->
        <div id="formView">
            ${renderBrand()}
            <h1>创建账户</h1>
            <p class="subtitle">注册一个新的用户账户</p>

            <div class="user-stats" id="userStats"></div>

            <div class="error-box" id="errorBox"></div>

            <form id="registerForm">
                <div class="form-group">
                    <label for="name">显示名称</label>
                    <input type="text" id="name" name="name"
                           placeholder="输入您的昵称"
                           required autocomplete="name" autofocus>
                    <div class="handle-preview">
                        登录账号：<span id="handlePreview"></span>
                    </div>
                </div>

                <div class="form-group">
                    <label for="password">密码 <small style="font-weight:400;text-transform:none;">(可选)</small></label>
                    <input type="password" id="password" name="password"
                           placeholder="留空则不设置密码"
                           autocomplete="new-password">
                </div>

                <div class="form-group">
                    <label for="passwordConfirm">确认密码</label>
                    <input type="password" id="passwordConfirm" name="passwordConfirm"
                           placeholder="再次输入密码"
                           autocomplete="new-password">
                </div>

                <button type="submit" id="submitBtn">
                    <span class="spinner" id="spinner"></span>
                    注册
                </button>
            </form>

            <div class="footer">
                已有账户？
                <a href="#" id="loginFooterLink">登录</a>
            </div>
        </div>

        <!-- Success view (hidden by default) -->
        <div id="successView" style="display:none;" class="success-box">
            <div class="check">&#10003;</div>
            <h2>账户创建成功！</h2>
            <p>您的 SillyTavern 账户已就绪。</p>
            <div class="info-row">
                <strong>账号：</strong> <code id="successHandle"></code><br>
                <strong>名称：</strong> <span id="successName"></span>
            </div>
            <p style="margin-top:12px;">您现在可以使用凭据登录了。</p>
            <a class="login-link" id="loginLink" href="#">
                前往登录页面
            </a>
        </div>
    </div>

    <script>
        const ST_PORT = ${stPort};
        // 同一端口下，登录页就是同源的 /login，直接用相对路径。
        const LOGIN_URL = '/login';

        const nameInput = document.getElementById('name');
        const handlePreview = document.getElementById('handlePreview');
        const errorBox = document.getElementById('errorBox');
        const form = document.getElementById('registerForm');
        const submitBtn = document.getElementById('submitBtn');
        const spinner = document.getElementById('spinner');
        const formView = document.getElementById('formView');
        const successView = document.getElementById('successView');

        // 设置登录链接
        document.getElementById('loginFooterLink').href = LOGIN_URL;
        document.getElementById('loginLink').href = LOGIN_URL;

        // 显示当前注册人数 / 上限；名额已满时禁用注册按钮
        (function loadStats(){
            fetch('/stats').then(r => r.json()).then(function(s){
                var el = document.getElementById('userStats');
                if (!el) return;
                if (s.maxUsers && s.maxUsers > 0) {
                    el.innerHTML = '已注册 <b>' + s.users + '</b> / ' + s.maxUsers + ' 人';
                    if (s.full) {
                        el.classList.add('full');
                        el.innerHTML += '（名额已满）';
                        submitBtn.disabled = true;
                        submitBtn.textContent = '注册名额已满';
                    }
                } else {
                    el.innerHTML = '已注册 <b>' + s.users + '</b> 人';
                }
            }).catch(function(){});
        })();

        // Live handle preview
        nameInput.addEventListener('input', () => {
            const slug = String(nameInput.value || '')
                .toLowerCase().trim()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            handlePreview.textContent = slug || '(输入名称后自动生成)';
        });

        // Trigger initial preview
        handlePreview.textContent = '(输入名称后自动生成)';

        function showError(msg) {
            errorBox.textContent = msg;
            errorBox.classList.add('show');
        }

        function hideError() {
            errorBox.classList.remove('show');
        }

        function setLoading(loading) {
            submitBtn.disabled = loading;
            spinner.style.display = loading ? 'inline-block' : 'none';
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideError();

            const name = nameInput.value.trim();
            const password = document.getElementById('password').value;
            const passwordConfirm = document.getElementById('passwordConfirm').value;

            if (!name) {
                showError('请输入显示名称。');
                return;
            }

            if (password && password !== passwordConfirm) {
                showError('两次输入的密码不一致。');
                return;
            }

            if (password && password.length < 4) {
                showError('密码至少需要4个字符。');
                return;
            }

            setLoading(true);

            try {
                const res = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, password: password || '' }),
                });

                const data = await res.json();

                if (!res.ok) {
                    showError(data.error || '注册失败，请稍后重试。');
                    return;
                }

                // Show success
                document.getElementById('successHandle').textContent = data.handle;
                document.getElementById('successName').textContent = data.name;
                formView.style.display = 'none';
                successView.style.display = 'block';
            } catch (err) {
                showError('网络错误，请检查服务器是否正常运行。');
            } finally {
                setLoading(false);
            }
        });
    </script>
</body>
</html>`;
}

// ─── Custom login page (replaces SillyTavern's /login) ────────────────────────

// 拦截 /login 时返回此页面。它通过 SillyTavern 原生的 /csrf-token 和
// /api/users/login API 完成登录（同源、cookie 由代理透传），登录成功后跳到 /。
function buildLoginPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 — ${escapeHtml(SITE.title || 'SillyTavern')}</title>
    <style>
        :root {
            --bg: #1a1a2e; --surface: #16213e; --surface2: #0f3460;
            --accent: #e94560; --accent-hover: #ff6b81; --text: #eee;
            --text-muted: #999; --border: #2a2a4a; --input-bg: #111122;
            --error: #e94560; --radius: 8px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg); color: var(--text); display: flex;
            justify-content: center; align-items: center; min-height: 100vh; padding: 20px;
        }
        .container {
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 12px; padding: 40px; width: 100%; max-width: 440px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        }
        .logo {
            text-align: center; margin-bottom: 8px; font-size: 14px;
            color: var(--text-muted); letter-spacing: 2px; text-transform: uppercase;
        }
        h1 { text-align: center; font-size: 24px; font-weight: 600; margin-bottom: 4px; }
        .subtitle { text-align: center; color: var(--text-muted); font-size: 14px; margin-bottom: 28px; }
        .form-group { margin-bottom: 20px; }
        label {
            display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px;
            color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;
        }
        input {
            width: 100%; padding: 10px 14px; background: var(--input-bg);
            border: 1px solid var(--border); border-radius: var(--radius);
            color: var(--text); font-size: 15px; transition: border-color 0.2s; outline: none;
        }
        input:focus { border-color: var(--accent); }
        button {
            width: 100%; padding: 12px; background: var(--accent); color: white;
            border: none; border-radius: var(--radius); font-size: 15px; font-weight: 600;
            cursor: pointer; transition: background 0.2s; margin-top: 8px;
        }
        button:hover { background: var(--accent-hover); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .error-box {
            background: rgba(233, 69, 96, 0.12); border: 1px solid var(--error);
            border-radius: var(--radius); padding: 12px; margin-bottom: 20px;
            color: var(--error); font-size: 14px; display: none;
        }
        .error-box.show { display: block; }
        .footer { text-align: center; margin-top: 24px; font-size: 12px; color: var(--text-muted); }
        .footer a { color: var(--accent); text-decoration: none; }
        .user-stats {
            text-align: center; margin: -10px 0 6px; font-size: 13px; color: var(--text-muted);
            min-height: 18px;
        }
        .user-stats b { color: var(--accent); font-weight: 600; }
        .user-stats.full b { color: #f59e0b; }
        .server-info {
            text-align: center; margin: 0 0 18px; font-size: 12px; color: #6b7290;
            min-height: 16px; word-break: break-all;
        }
        .server-info b { color: #8b93ad; font-weight: 500; }
        .spinner {
            display: none; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3);
            border-top-color: white; border-radius: 50%; animation: spin 0.6s linear infinite;
            margin-right: 8px; vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
${MODERN_OVERRIDES}
    </style>
</head>
<body>
    <div class="container">
        ${renderBrand()}
        <h1>登录</h1>
        <p class="subtitle">登录到您的账户</p>

        <div class="user-stats" id="userStats"></div>
        <div class="server-info" id="serverInfo"></div>

        <div class="error-box" id="errorBox"></div>

        <form id="loginForm">
            <div class="form-group">
                <label for="handle">登录账号</label>
                <input type="text" id="handle" name="handle"
                       placeholder="您的登录账号" required autocomplete="username" autofocus>
            </div>
            <div class="form-group">
                <label for="password">密码</label>
                <input type="password" id="password" name="password"
                       placeholder="若无密码请留空" autocomplete="current-password">
            </div>
            <button type="submit" id="submitBtn">
                <span class="spinner" id="spinner"></span>
                登录
            </button>
        </form>

        <div class="footer">
            还没有账户？
            <a href="/register">注册</a>
        </div>
    </div>

    <script>
        const form = document.getElementById('loginForm');
        const errorBox = document.getElementById('errorBox');
        const submitBtn = document.getElementById('submitBtn');
        const spinner = document.getElementById('spinner');

        // 显示当前注册人数 / 上限
        (function loadStats(){
            fetch('/stats').then(r => r.json()).then(function(s){
                var el = document.getElementById('userStats');
                if (!el) return;
                if (s.maxUsers && s.maxUsers > 0) {
                    el.innerHTML = '已注册 <b>' + s.users + '</b> / ' + s.maxUsers + ' 人';
                    if (s.full) { el.classList.add('full'); el.innerHTML += '（名额已满）'; }
                } else {
                    el.innerHTML = '已注册 <b>' + s.users + '</b> 人';
                }
            }).catch(function(){});
        })();

        // 显示服务器公网 IP 与中文地区
        (function loadServerInfo(){
            fetch('/server-info').then(r => r.json()).then(function(s){
                var el = document.getElementById('serverInfo');
                if (!el) return;
                var parts = [];
                if (s.ip) parts.push('IP <b>' + s.ip + '</b>');
                if (s.location) parts.push('<b>' + s.location + '</b>');
                el.innerHTML = parts.join(' · ');
            }).catch(function(){});
        })();

        function showError(msg) { errorBox.textContent = msg; errorBox.classList.add('show'); }
        function hideError() { errorBox.classList.remove('show'); }
        function setLoading(v) { submitBtn.disabled = v; spinner.style.display = v ? 'inline-block' : 'none'; }

        async function getCsrfToken() {
            const res = await fetch('/csrf-token');
            const data = await res.json();
            return data.token;
        }

        // 把 SillyTavern API 返回的英文错误文案翻译成中文。
        function translateError(msg) {
            if (!msg) return '账号或密码错误。';
            const map = {
                'Incorrect credentials': '账号或密码错误。',
                'Missing required fields': '请填写必填字段。',
                'User is disabled': '该账户已被禁用，请联系管理员。',
                'User not found': '账户不存在。',
                'Incorrect code': '验证码错误。',
                'Too many attempts. Try again later or recover your password.': '尝试次数过多，请稍后再试或找回密码。',
                'Too many attempts. Try again later or contact your admin.': '尝试次数过多，请稍后再试或联系管理员。',
            };
            if (map[msg]) return map[msg];
            // 兜底：包含关键字的也翻译
            if (/too many attempts/i.test(msg)) return '尝试次数过多，请稍后再试。';
            if (/incorrect/i.test(msg)) return '账号或密码错误。';
            if (/disabled/i.test(msg)) return '该账户已被禁用，请联系管理员。';
            return msg;
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideError();
            const handle = document.getElementById('handle').value.trim();
            const password = document.getElementById('password').value;

            if (!handle) { showError('请输入登录账号。'); return; }
            setLoading(true);

            try {
                const csrfToken = await getCsrfToken();
                const res = await fetch('/api/users/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                    body: JSON.stringify({ handle, password }),
                });

                if (!res.ok) {
                    let raw = '';
                    try { const d = await res.json(); if (d && d.error) raw = d.error; } catch {}
                    if (res.status === 429 && !raw) raw = 'Too many attempts. Try again later or recover your password.';
                    showError(translateError(raw));
                    return;
                }

                // 登录成功，cookie 已设置，跳转到数据管理页面。
                window.location.href = '/st';
            } catch (err) {
                showError('网络错误，请稍后重试。');
            } finally {
                setLoading(false);
            }
        });
    </script>
</body>
</html>`;
}

// ─── 融合登录/注册页（3D 翻转切换） ──────────────────────────────────────────

const AUTH_STYLES = `
    * { margin:0; padding:0; box-sizing:border-box; -webkit-font-smoothing:antialiased; }
    :root {
        --accent:#7c3aed; --accent2:#e94560; --text:#e8eaf2;
        /* 次要文字色：从主文字色派生（淡化版），这样改“文字主色”次要文字也跟随 */
        --muted:color-mix(in srgb, var(--text) 58%, transparent);
        --faint:color-mix(in srgb, var(--text) 42%, transparent);
        --line:rgba(255,255,255,0.10); --input-bg:rgba(255,255,255,0.04);
        --error:#e94560; --ok:#22c55e; --radius:13px;
        --card-alpha:0.72; --card-radius:22px; --glass-blur:22px;
        --font-scale:1; --ui-font:'Inter','Segoe UI',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;
    }
    body {
        font-family:var(--ui-font);
        color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center;
        padding:20px; overflow:hidden; background:#070a14;
        background-image:
            radial-gradient(at 18% 18%, rgba(124,58,237,0.28), transparent 42%),
            radial-gradient(at 82% 6%, rgba(233,69,96,0.22), transparent 44%),
            radial-gradient(at 50% 100%, rgba(14,165,233,0.20), transparent 48%);
    }
    /* 极光流光：多彩光团 mix-blend 叠加发光、缓慢飘动呼吸 */
    .aurora { position:fixed; inset:-25%; z-index:0; pointer-events:none; filter:blur(72px); }
    .ab { position:absolute; border-radius:50%; opacity:0.55; mix-blend-mode:screen; will-change:transform; }
    .ab1 { width:48vmax; height:48vmax; top:-8%; left:-10%; background:radial-gradient(circle, #8b5cf6, transparent 62%); animation:drift1 24s ease-in-out infinite; }
    .ab2 { width:42vmax; height:42vmax; bottom:-12%; right:-8%; background:radial-gradient(circle, #f43f74, transparent 62%); animation:drift2 28s ease-in-out infinite; }
    .ab3 { width:40vmax; height:40vmax; top:24%; right:14%; background:radial-gradient(circle, #22d3ee, transparent 64%); animation:drift3 32s ease-in-out infinite; }
    .ab4 { width:36vmax; height:36vmax; bottom:6%; left:12%; background:radial-gradient(circle, #2dd4bf, transparent 64%); animation:drift4 30s ease-in-out infinite; }
    @keyframes drift1 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(7vmax,5vmax) scale(1.18)} }
    @keyframes drift2 { 0%,100%{transform:translate(0,0) scale(1.1)} 50%{transform:translate(-6vmax,-5vmax) scale(0.95)} }
    @keyframes drift3 { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(-5vmax,4vmax) scale(1.12)} 66%{transform:translate(4vmax,-3vmax) scale(0.92)} }
    @keyframes drift4 { 0%,100%{transform:translate(0,0) scale(1.05)} 50%{transform:translate(5vmax,-6vmax) scale(1.2)} }

    /* 背景图（默认隐藏，由后台设置启用） */
    .bg-image { position:fixed; inset:-24px; z-index:0; background-size:cover; background-position:center; display:none; }
    .bg-dim { position:fixed; inset:0; z-index:0; display:none; pointer-events:none; }

    .flip-wrap { position:relative; z-index:1; width:100%; max-width:440px; perspective:1600px; animation:floatCard 7s ease-in-out infinite, wrapFade .7s ease both; }
    @keyframes floatCard { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-9px)} }
    @keyframes wrapFade { from{opacity:0;} to{opacity:1;} }
    .card-flip {
        position:relative; width:100%; transform-style:preserve-3d;
        transition:transform .7s cubic-bezier(.2,.7,.2,1), height .45s ease;
    }
    .card-flip.flipped { transform:rotateY(180deg); }
    .face {
        position:absolute; top:0; left:0; width:100%;
        backface-visibility:hidden; -webkit-backface-visibility:hidden;
        background:rgba(18,22,38,var(--card-alpha)); backdrop-filter:blur(var(--glass-blur)) saturate(160%);
        -webkit-backdrop-filter:blur(var(--glass-blur)) saturate(160%);
        border:1px solid var(--line); border-radius:var(--card-radius); padding:42px;
        box-shadow:0 24px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07);
        font-size:calc(16px * var(--font-scale));
    }
    .face-back { transform:rotateY(180deg); }

    .logo { text-align:center; margin-bottom:8px; font-size:.875em; color:var(--muted); letter-spacing:2px; text-transform:uppercase; font-weight:600; }
    .brand-logo { display:block; max-width:180px; max-height:72px; margin:0 auto 6px; object-fit:contain; }
    h1 {
        text-align:center; font-size:1.625em; font-weight:700; letter-spacing:-0.5px; margin-bottom:4px;
        background:linear-gradient(100deg,#fff,var(--accent2) 45%,var(--accent) 70%,#fff);
        background-size:220% auto;
        -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;
        animation:shimmer 6s linear infinite;
    }
    @keyframes shimmer { to { background-position:220% center; } }
    .subtitle { text-align:center; color:var(--muted); font-size:.875em; margin-bottom:22px; }
    .user-stats { text-align:center; font-size:.8125em; color:var(--muted); margin-bottom:4px; min-height:18px; }
    .user-stats b { color:color-mix(in srgb, var(--accent) 50%, #ffffff); font-weight:600; }
    .user-stats.full b { color:#f59e0b; }
    .server-info { text-align:center; font-size:.75em; color:var(--faint); margin-bottom:18px; min-height:16px; word-break:break-all; }
    .server-info b { color:var(--muted); font-weight:500; }
    .form-group { margin-bottom:18px; }
    label { display:block; font-size:.75em; font-weight:500; margin-bottom:6px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; }
    input {
        width:100%; padding:13px 16px; background:var(--input-bg); border:1px solid var(--line);
        border-radius:11px; color:var(--text); font-size:.9375em; outline:none;
        transition:border-color .2s, box-shadow .2s, background .2s;
    }
    input::placeholder { color:var(--faint); }
    input:focus {
        border-color:color-mix(in srgb, var(--accent) 70%, #ffffff);
        background:rgba(255,255,255,0.07);
        box-shadow:0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent), 0 0 22px color-mix(in srgb, var(--accent) 30%, transparent);
    }
    .handle-preview { font-size:.75em; color:var(--muted); margin-top:5px; font-family:monospace; }
    .handle-preview span { color:color-mix(in srgb, var(--accent) 50%, #ffffff); }
    button.submit {
        width:100%; padding:14px; border:none; border-radius:11px; color:#fff; font-size:.9375em; font-weight:600;
        letter-spacing:0.3px; cursor:pointer; margin-top:6px;
        background:linear-gradient(110deg,var(--accent),var(--accent2),var(--accent),var(--accent2));
        background-size:220% auto;
        box-shadow:0 10px 26px rgba(124,58,237,0.38);
        transition:transform .15s, filter .2s, box-shadow .2s, background-position .6s ease;
    }
    button.submit:hover { transform:translateY(-2px); filter:brightness(1.1); background-position:100% center; box-shadow:0 14px 34px rgba(124,58,237,0.5); }
    button.submit:active { transform:translateY(0); }
    button.submit:disabled { opacity:.5; cursor:not-allowed; transform:none; }
    .error-box { background:rgba(233,69,96,0.12); border:1px solid var(--error); border-radius:11px; padding:11px; margin-bottom:18px; color:#fca5a5; font-size:.8125em; display:none; }
    .error-box.show { display:block; }
    .footer { text-align:center; margin-top:22px; font-size:.8125em; color:var(--muted); }
    .footer a { color:color-mix(in srgb, var(--accent) 50%, #ffffff); text-decoration:none; font-weight:600; cursor:pointer; }
    .footer a:hover { color:#fff; }
    .friend-links { text-align:center; margin-top:12px; font-size:.72em; line-height:1.9; }
    .friend-links a { color:var(--muted); text-decoration:none; margin:0 7px; transition:color .2s; }
    .friend-links a:hover { color:color-mix(in srgb, var(--accent) 60%, #ffffff); }
    .friend-links .sep { color:var(--faint); margin:0 1px; }
    .spinner { display:none; width:18px; height:18px; border:2px solid rgba(255,255,255,0.3); border-top-color:#fff; border-radius:50%; animation:spin .6s linear infinite; margin-right:8px; vertical-align:middle; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .success-box { text-align:center; }
    .success-box .check { width:74px; height:74px; line-height:74px; margin:0 auto 16px; border-radius:50%; font-size:2.25em; background:linear-gradient(135deg,#22c55e,#14b8a6); color:#fff; box-shadow:0 12px 32px rgba(34,197,94,0.42); }
    .success-box h2 { margin-bottom:8px; }
    .success-box p { color:var(--muted); font-size:.875em; margin-bottom:6px; }
    .info-row { background:rgba(255,255,255,0.05); border:1px solid var(--line); border-radius:11px; padding:12px 16px; margin:12px 0; text-align:left; font-size:.8125em; }
    .info-row strong { display:inline-block; width:64px; color:var(--muted); }
    .info-row code { color:color-mix(in srgb, var(--accent) 50%, #ffffff); }
    .success-box .login-link { display:inline-block; margin-top:16px; padding:11px 28px; background:linear-gradient(135deg,#22c55e,#14b8a6); color:#fff; text-decoration:none; border-radius:11px; font-weight:600; cursor:pointer; transition:transform .15s, filter .2s; }
    .success-box .login-link:hover { transform:translateY(-2px); filter:brightness(1.08); }

    /* 入场：整卡淡入（只动 opacity，避免与翻转/浮动的 transform 冲突），内部元素依次上浮 */
    @keyframes fadeUp { from{opacity:0; transform:translateY(14px);} to{opacity:1; transform:none;} }
    .face-front > *, #regFormView > * { animation:fadeUp .6s cubic-bezier(.2,.7,.2,1) both; }
    .face-front > *:nth-child(1), #regFormView > *:nth-child(1) { animation-delay:.10s; }
    .face-front > *:nth-child(2), #regFormView > *:nth-child(2) { animation-delay:.16s; }
    .face-front > *:nth-child(3), #regFormView > *:nth-child(3) { animation-delay:.22s; }
    .face-front > *:nth-child(4), #regFormView > *:nth-child(4) { animation-delay:.28s; }
    .face-front > *:nth-child(5), #regFormView > *:nth-child(5) { animation-delay:.34s; }
    .face-front > *:nth-child(6), #regFormView > *:nth-child(6) { animation-delay:.40s; }
    .face-front > *:nth-child(7), #regFormView > *:nth-child(7) { animation-delay:.46s; }
    .face-front > *:nth-child(8), #regFormView > *:nth-child(8) { animation-delay:.52s; }
    @media (prefers-reduced-motion: reduce) {
        .aurora .ab, .flip-wrap, h1, .card-flip, .face-front > *, #regFormView > * { animation:none !important; }
    }
`;

const AUTH_SCRIPT = `
(function(){
  var CFG = window.__AUTH || { initial:'login', port:0 };
  var $ = function(id){ return document.getElementById(id); };
  var flipper = $('flipper');
  var loginFace = $('loginFace');
  var registerFace = $('registerFace');

  // ── 翻转 + 高度自适应 ──
  function activeFaceHeight(){
    return (flipper.classList.contains('flipped') ? registerFace : loginFace).offsetHeight;
  }
  function syncHeight(){ flipper.style.height = activeFaceHeight() + 'px'; }
  function flipTo(view){
    if (view === 'register') flipper.classList.add('flipped');
    else flipper.classList.remove('flipped');
    syncHeight();
  }
  $('toRegister').addEventListener('click', function(e){ e.preventDefault(); flipTo('register'); });
  $('toLogin').addEventListener('click', function(e){ e.preventDefault(); flipTo('login'); });

  // 初始：无动画定位到目标面
  flipper.style.transition = 'none';
  if (CFG.initial === 'register') flipper.classList.add('flipped');
  syncHeight();
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){ flipper.style.transition = ''; });
  });
  window.addEventListener('resize', syncHeight);

  // ── 公共统计 / 服务器信息 ──
  fetch('/stats').then(function(r){return r.json();}).then(function(s){
    var a = $('loginStats'), b = $('regStats');
    var html, full = s.maxUsers && s.maxUsers > 0 && s.full;
    if (s.maxUsers && s.maxUsers > 0) html = '已注册 <b>' + s.users + '</b> / ' + s.maxUsers + ' 人';
    else html = '已注册 <b>' + s.users + '</b> 人';
    if (a) a.innerHTML = html;
    if (b) b.innerHTML = html;
    if (full) {
      if (a) a.classList.add('full');
      if (b) { b.classList.add('full'); b.innerHTML += '（名额已满）'; }
      var rb = $('regSubmit');
      if (rb) { rb.disabled = true; rb.textContent = '注册名额已满'; }
    }
    syncHeight();
  }).catch(function(){});

  fetch('/server-info').then(function(r){return r.json();}).then(function(s){
    var el = $('loginServerInfo'); if (!el) return;
    var parts = [];
    if (s.ip) parts.push('IP <b>' + s.ip + '</b>');
    if (s.location) parts.push('<b>' + s.location + '</b>');
    el.innerHTML = parts.join(' · ');
    syncHeight();
  }).catch(function(){});

  // ── 背景图（启用则隐藏极光，显示图片 + 暗化遮罩） ──
  fetch('/bg-info').then(function(r){return r.json();}).then(function(b){
    if (!b || !b.enabled) return;
    var img = $('bgImage'), dim = $('bgDim'), aurora = $('auroraLayer');
    var url = '/bg?t=' + Date.now();
    var probe = new Image();
    probe.onload = function(){
      img.style.backgroundImage = 'url("' + url + '")';
      if (b.blur && b.blur > 0) img.style.filter = 'blur(' + b.blur + 'px)';
      dim.style.background = 'rgba(7,10,20,' + ((b.dim || 0) / 100) + ')';
      img.style.display = 'block';
      dim.style.display = 'block';
      if (aurora) aurora.style.display = 'none';
    };
    probe.onerror = function(){ /* 取图失败则保留极光背景 */ };
    probe.src = url;
  }).catch(function(){});

  // ── 友情链接（卡片底部，两面都渲染） ──
  fetch('/friend-links').then(function(r){return r.json();}).then(function(d){
    if (!d || !d.enabled || !Array.isArray(d.links) || !d.links.length) return;
    function buildLinks(){
      var frag = document.createDocumentFragment();
      d.links.forEach(function(it, i){
        if (!it || !it.url || !/^https?:\\/\\//i.test(it.url)) return;
        if (i > 0) { var s = document.createElement('span'); s.className='sep'; s.textContent='·'; frag.appendChild(s); }
        var a = document.createElement('a');
        a.href = it.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = it.name || it.url;
        frag.appendChild(a);
      });
      return frag;
    }
    var c1 = $('friendLinksLogin'), c2 = $('friendLinksReg');
    if (c1) c1.appendChild(buildLinks());
    if (c2) c2.appendChild(buildLinks());
    syncHeight();
  }).catch(function(){});

  // ── 登录 ──
  function lShowErr(m){ var e=$('loginErr'); e.textContent=m; e.classList.add('show'); syncHeight(); }
  function lHideErr(){ $('loginErr').classList.remove('show'); }
  function translateError(msg){
    if (!msg) return '账号或密码错误。';
    var map = {
      'Incorrect credentials':'账号或密码错误。','Missing required fields':'请填写必填字段。',
      'User is disabled':'该账户已被禁用，请联系管理员。','User not found':'账户不存在。',
      'Incorrect code':'验证码错误。',
      'Too many attempts. Try again later or recover your password.':'尝试次数过多，请稍后再试或找回密码。',
      'Too many attempts. Try again later or contact your admin.':'尝试次数过多，请稍后再试或联系管理员。'
    };
    if (map[msg]) return map[msg];
    if (/too many attempts/i.test(msg)) return '尝试次数过多，请稍后再试。';
    if (/incorrect/i.test(msg)) return '账号或密码错误。';
    if (/disabled/i.test(msg)) return '该账户已被禁用，请联系管理员。';
    return msg;
  }
  async function getCsrf(){ var r = await fetch('/csrf-token'); var d = await r.json(); return d.token; }
  $('loginForm').addEventListener('submit', async function(e){
    e.preventDefault(); lHideErr();
    var handle = $('loginHandle').value.trim();
    var password = $('loginPassword').value;
    if (!handle){ lShowErr('请输入登录账号。'); return; }
    var btn = $('loginSubmit'), sp = $('loginSpinner');
    btn.disabled = true; sp.style.display = 'inline-block';
    try {
      var token = await getCsrf();
      var res = await fetch('/api/users/login', {
        method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':token},
        body: JSON.stringify({ handle: handle, password: password })
      });
      if (!res.ok){
        var raw=''; try{ var d=await res.json(); if(d&&d.error) raw=d.error; }catch(_){}
        if (res.status===429 && !raw) raw='Too many attempts. Try again later or recover your password.';
        lShowErr(translateError(raw)); return;
      }
      window.location.href = '/st';
    } catch(err){ lShowErr('网络错误，请稍后重试。'); }
    finally { btn.disabled = false; sp.style.display = 'none'; }
  });

  // ── 注册 ──
  function rShowErr(m){ var e=$('regErr'); e.textContent=m; e.classList.add('show'); syncHeight(); }
  function rHideErr(){ $('regErr').classList.remove('show'); }
  var nameInput = $('regName'), preview = $('regHandlePreview');
  function slug(v){ return String(v||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }
  preview.textContent = '(输入名称后自动生成)';
  nameInput.addEventListener('input', function(){ preview.textContent = slug(nameInput.value) || '(输入名称后自动生成)'; });
  $('regForm').addEventListener('submit', async function(e){
    e.preventDefault(); rHideErr();
    var name = nameInput.value.trim();
    var pw = $('regPassword').value, pw2 = $('regPasswordConfirm').value;
    if (!name){ rShowErr('请输入显示名称。'); return; }
    if (pw && pw !== pw2){ rShowErr('两次输入的密码不一致。'); return; }
    if (pw && pw.length < 4){ rShowErr('密码至少需要4个字符。'); return; }
    var btn = $('regSubmit'), sp = $('regSpinner');
    btn.disabled = true; sp.style.display = 'inline-block';
    try {
      var res = await fetch('/register', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name: name, password: pw || '' })
      });
      var data=null; try{ data = await res.json(); }catch(_){}
      if (!res.ok){ rShowErr((data && data.error) || '注册失败，请稍后重试。'); return; }
      $('successHandle').textContent = data.handle;
      $('successName').textContent = data.name;
      $('regFormView').style.display = 'none';
      $('regSuccessView').style.display = 'block';
      syncHeight();
    } catch(err){ rShowErr('网络错误，请检查服务器是否正常运行。'); }
    finally { btn.disabled = false; sp.style.display = 'none'; }
  });
  // 成功后「前往登录」翻回登录面
  $('successLogin').addEventListener('click', function(e){ e.preventDefault(); flipTo('login'); });
})();
`;

// 构建融合登录/注册页。initialView: 'login' | 'register'，决定初始翻到哪一面。
function buildAuthPage(initialView) {
    const brand = renderBrand();
    const title = escapeHtml(SITE.title || 'SillyTavern');
    const cfg = JSON.stringify({ initial: initialView === 'register' ? 'register' : 'login', port: ST_PORT });
    // 卡片样式变量（覆盖 AUTH_STYLES 默认值）。颜色/字体已在读取时校验，安全注入。
    const fontStack = FONT_STACKS[CARD.fontFamily] || FONT_STACKS.system;
    let cardVars = `:root{`
        + `--accent:${CARD.accent};--accent2:${CARD.accent2};`
        + `--card-alpha:${(CARD.opacity / 100).toFixed(3)};`
        + `--card-radius:${CARD.radius}px;--glass-blur:${CARD.blur}px;`
        + `--text:${CARD.textColor};--font-scale:${(CARD.fontScale / 100).toFixed(3)};`
        + `--ui-font:${fontStack};}`;
    // 若设置了标题纯色，覆盖默认的彩色渐变标题
    if (CARD.titleColor) {
        cardVars += `h1{background:none !important;-webkit-text-fill-color:${CARD.titleColor} !important;color:${CARD.titleColor} !important;animation:none !important;}`;
    }
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${initialView === 'register' ? '注册' : '登录'} — ${title}</title>
    <style>${AUTH_STYLES}</style>
    <style>${cardVars}</style>
</head>
<body>
    <div class="bg-image" id="bgImage"></div>
    <div class="bg-dim" id="bgDim"></div>
    <div class="aurora" id="auroraLayer">
        <span class="ab ab1"></span><span class="ab ab2"></span>
        <span class="ab ab3"></span><span class="ab ab4"></span>
    </div>
    <div class="flip-wrap">
        <div class="card-flip" id="flipper">
            <!-- 登录面 -->
            <div class="face face-front" id="loginFace">
                ${brand}
                <h1>登录</h1>
                <p class="subtitle">登录到您的账户</p>
                <div class="user-stats" id="loginStats"></div>
                <div class="server-info" id="loginServerInfo"></div>
                <div class="error-box" id="loginErr"></div>
                <form id="loginForm">
                    <div class="form-group">
                        <label for="loginHandle">登录账号</label>
                        <input type="text" id="loginHandle" placeholder="您的登录账号" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label for="loginPassword">密码</label>
                        <input type="password" id="loginPassword" placeholder="若无密码请留空" autocomplete="current-password">
                    </div>
                    <button class="submit" type="submit" id="loginSubmit">
                        <span class="spinner" id="loginSpinner"></span>登录
                    </button>
                </form>
                <div class="footer">还没有账户？<a id="toRegister">注册</a></div>
                <div class="friend-links" id="friendLinksLogin"></div>
            </div>
            <!-- 注册面 -->
            <div class="face face-back" id="registerFace">
                <div id="regFormView">
                    ${brand}
                    <h1>创建账户</h1>
                    <p class="subtitle">注册一个新的用户账户</p>
                    <div class="user-stats" id="regStats"></div>
                    <div class="error-box" id="regErr"></div>
                    <form id="regForm">
                        <div class="form-group">
                            <label for="regName">显示名称</label>
                            <input type="text" id="regName" placeholder="输入您的昵称" autocomplete="name">
                            <div class="handle-preview">登录账号：<span id="regHandlePreview"></span></div>
                        </div>
                        <div class="form-group">
                            <label for="regPassword">密码 <small style="text-transform:none;font-weight:400;">(可选)</small></label>
                            <input type="password" id="regPassword" placeholder="留空则不设置密码" autocomplete="new-password">
                        </div>
                        <div class="form-group">
                            <label for="regPasswordConfirm">确认密码</label>
                            <input type="password" id="regPasswordConfirm" placeholder="再次输入密码" autocomplete="new-password">
                        </div>
                        <button class="submit" type="submit" id="regSubmit">
                            <span class="spinner" id="regSpinner"></span>注册
                        </button>
                    </form>
                    <div class="footer">已有账户？<a id="toLogin">登录</a></div>
                    <div class="friend-links" id="friendLinksReg"></div>
                </div>
                <div id="regSuccessView" class="success-box" style="display:none;">
                    <div class="check">&#10003;</div>
                    <h2>账户创建成功！</h2>
                    <p>您的账户已就绪。</p>
                    <div class="info-row">
                        <strong>账号：</strong> <code id="successHandle"></code><br>
                        <strong>名称：</strong> <span id="successName"></span>
                    </div>
                    <p style="margin-top:12px;">现在可以使用凭据登录了。</p>
                    <a class="login-link" id="successLogin">前往登录</a>
                </div>
            </div>
        </div>
    </div>
    <script>window.__AUTH = ${cfg};</script>
    <script>${AUTH_SCRIPT}</script>
</body>
</html>`;
}

// ─── Dashboard Page (数据管理中心) ──────────────────────────────────────────

function buildDashboardPage() {
    const brand = renderBrand();
    const title = escapeHtml(SITE.title || 'SillyTavern');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>数据管理 — ${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body {
            font-family: 'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
            background: #070a14;
            background-image:
                radial-gradient(at 18% 18%, rgba(124,58,237,0.28), transparent 42%),
                radial-gradient(at 82% 6%, rgba(233,69,96,0.22), transparent 44%),
                radial-gradient(at 50% 100%, rgba(14,165,233,0.20), transparent 48%);
            color: #e8eaf2;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            overflow: hidden;
        }
        body::before, body::after {
            content: ''; position: fixed; border-radius: 50%;
            filter: blur(90px); z-index: 0; opacity: 0.55; pointer-events: none;
        }
        body::before {
            width: 420px; height: 420px; background: #7c3aed;
            top: -140px; left: -120px; animation: floatA 16s ease-in-out infinite;
        }
        body::after {
            width: 360px; height: 360px; background: #e94560;
            bottom: -150px; right: -110px; animation: floatB 18s ease-in-out infinite;
        }
        @keyframes floatA { 0%,100% { transform: translate(0,0) } 50% { transform: translate(70px,46px) } }
        @keyframes floatB { 0%,100% { transform: translate(0,0) } 50% { transform: translate(-56px,-44px) } }

        .container {
            position: relative; z-index: 1;
            background: rgba(18, 22, 38, 0.72);
            backdrop-filter: blur(22px) saturate(160%);
            -webkit-backdrop-filter: blur(22px) saturate(160%);
            border: 1px solid rgba(255,255,255,0.09);
            border-radius: 22px;
            padding: 30px 34px;
            width: 100%;
            max-width: 980px;
            max-height: calc(100vh - 40px);
            overflow-y: auto;
            box-shadow: 0 24px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07);
            animation: cardIn 0.65s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .container::-webkit-scrollbar {
            width: 8px;
        }
        .container::-webkit-scrollbar-track {
            background: rgba(255,255,255,0.03);
            border-radius: 4px;
        }
        .container::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.15);
            border-radius: 4px;
        }
        .container::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.25);
        }
        @keyframes cardIn {
            from { opacity: 0; transform: translateY(18px) scale(0.97); }
            to { opacity: 1; transform: none; }
        }

        .logo { text-align: center; margin-bottom: 8px; font-size: 14px; color: #8b93ad; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; }
        .brand-logo { display: block; max-width: 180px; max-height: 72px; margin: 0 auto 6px; object-fit: contain; }

        h1 {
            text-align: center;
            background: linear-gradient(135deg, #ffffff, #c3c9ff 55%, #ff7a92);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent;
            font-size: 28px; letter-spacing: -0.5px;
            margin-bottom: 8px;
        }
        .subtitle { text-align: center; color: #8b93ad; font-size: 14px; margin-bottom: 32px; }

        .user-info {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.07);
            border-radius: 13px;
            padding: 16px 20px;
            margin-bottom: 28px;
            font-size: 14px;
        }
        .user-info .label { color: #8b93ad; display: inline-block; width: 80px; }
        .user-info .value { color: #b9a3ff; font-weight: 600; }

        .section {
            margin-bottom: 24px;
        }
        .section-title {
            font-size: 16px;
            font-weight: 600;
            color: #aab0c6;
            margin-bottom: 12px;
            padding-left: 4px;
        }

        .btn-group {
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
        }

        button {
            flex: 1;
            padding: 14px;
            border: none;
            border-radius: 13px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: transform .15s ease, box-shadow .2s ease, filter .2s ease;
            letter-spacing: 0.3px;
        }
        button:hover {
            transform: translateY(-2px);
            filter: brightness(1.08);
        }
        button:active { transform: translateY(0); }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .btn-primary {
            background: linear-gradient(135deg, #7c3aed, #e94560);
            color: white;
            box-shadow: 0 10px 26px rgba(124,58,237,0.38);
        }
        .btn-primary:hover {
            box-shadow: 0 14px 32px rgba(124,58,237,0.48);
        }

        .btn-secondary {
            background: linear-gradient(135deg, #14b8a6, #22c55e);
            color: white;
            box-shadow: 0 10px 26px rgba(20,184,166,0.38);
        }
        .btn-secondary:hover {
            box-shadow: 0 14px 32px rgba(20,184,166,0.48);
        }

        .btn-danger {
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
            box-shadow: 0 10px 26px rgba(239,68,68,0.38);
        }

        .btn-enter {
            width: 100%;
            background: linear-gradient(135deg, #3b82f6, #8b5cf6);
            color: white;
            box-shadow: 0 10px 26px rgba(59,130,246,0.38);
            font-size: 16px;
            padding: 16px;
        }
        .btn-enter:hover {
            box-shadow: 0 14px 32px rgba(59,130,246,0.48);
        }

        .message {
            padding: 12px 16px;
            border-radius: 11px;
            margin-bottom: 16px;
            font-size: 14px;
            display: none;
        }
        .message.show { display: block; }
        .message.success {
            background: rgba(34,197,94,0.12);
            border: 1px solid #22c55e;
            color: #86efac;
        }
        .message.error {
            background: rgba(239,68,68,0.12);
            border: 1px solid #ef4444;
            color: #fca5a5;
        }
        .message.info {
            background: rgba(59,130,246,0.12);
            border: 1px solid #3b82f6;
            color: #93c5fd;
        }

        .progress-container {
            display: none;
            margin-bottom: 16px;
        }
        .progress-container.show { display: block; }
        .progress-bar {
            width: 100%;
            height: 8px;
            background: rgba(255,255,255,0.1);
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 8px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #7c3aed, #e94560);
            transition: width 0.3s ease;
            width: 0%;
        }
        .progress-text {
            font-size: 13px;
            color: #8b93ad;
            text-align: center;
        }

        .spinner {
            display: none;
            width: 18px;
            height: 18px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .config-section {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 11px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .config-section label {
            display: block;
            font-size: 13px;
            color: #8b93ad;
            margin-bottom: 8px;
            font-weight: 500;
        }
        .config-section input {
            width: 100%;
            padding: 10px 14px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.10);
            border-radius: 9px;
            color: #e8eaf2;
            font-size: 14px;
            outline: none;
            transition: border-color .2s, box-shadow .2s;
        }
        .config-section input:focus {
            border-color: #8a96ff;
            box-shadow: 0 0 0 3px rgba(124,138,255,0.16);
        }
        .config-section select {
            width: 100%;
            padding: 10px 14px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.10);
            border-radius: 9px;
            color: #e8eaf2;
            font-size: 14px;
            outline: none;
            cursor: pointer;
            transition: border-color .2s, box-shadow .2s;
        }
        .config-section select:focus {
            border-color: #8a96ff;
            box-shadow: 0 0 0 3px rgba(124,138,255,0.16);
        }
        .config-section select option {
            background: #1a1e2e;
            color: #e8eaf2;
            padding: 10px;
        }
        .config-section .hint {
            font-size: 12px;
            color: #6b7290;
            margin-top: 6px;
        }

        /* 自定义确认对话框 */
        .custom-confirm {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            z-index: 9999;
            align-items: center;
            justify-content: center;
        }
        .custom-confirm.show {
            display: flex;
        }
        .custom-confirm-dialog {
            background: rgba(18, 22, 38, 0.95);
            backdrop-filter: blur(22px) saturate(160%);
            border: 1px solid rgba(255,255,255,0.09);
            border-radius: 18px;
            padding: 32px;
            max-width: 420px;
            width: 90%;
            box-shadow: 0 24px 70px rgba(0,0,0,0.7);
            animation: confirmIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes confirmIn {
            from { opacity: 0; transform: scale(0.95) translateY(-10px); }
            to { opacity: 1; transform: none; }
        }
        .custom-confirm-title {
            font-size: 20px;
            font-weight: 600;
            color: #fff;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .custom-confirm-title::before {
            content: '⚠️';
            font-size: 24px;
        }
        .custom-confirm-message {
            font-size: 15px;
            color: #aab0c6;
            line-height: 1.6;
            margin-bottom: 24px;
        }
        .custom-confirm-buttons {
            display: flex;
            gap: 12px;
        }
        .custom-confirm-btn {
            flex: 1;
            padding: 12px;
            border: none;
            border-radius: 11px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: transform .15s, filter .2s;
        }
        .custom-confirm-btn:hover {
            transform: translateY(-2px);
            filter: brightness(1.1);
        }
        .custom-confirm-btn:active {
            transform: translateY(0);
        }
        .custom-confirm-btn-cancel {
            background: rgba(255,255,255,0.08);
            color: #aab0c6;
        }
        .custom-confirm-btn-confirm {
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
            box-shadow: 0 8px 20px rgba(239,68,68,0.4);
        }

        .logout-link {
            text-align: center;
            margin-top: 24px;
            font-size: 13px;
        }
        .logout-link a {
            color: #b9a3ff;
            text-decoration: none;
            cursor: pointer;
        }
        .logout-link a:hover {
            color: #fff;
        }

        /* ── PC 两栏布局 ───────────────────────────────────────────── */
        /* 顶部栏：左边标题，右边用户信息 + 退出 */
        .topbar {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 24px;
            margin-bottom: 20px;
            padding-bottom: 18px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .topbar-left { text-align: left; }
        .topbar-left .logo { text-align: left; margin: 0 0 4px; }
        .topbar-left .brand-logo { margin: 0 0 6px; }
        .topbar-left h1 { text-align: left; font-size: 24px; margin-bottom: 4px; }
        .topbar-left .subtitle { text-align: left; margin-bottom: 0; }
        .topbar-right {
            display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
            flex-shrink: 0;
        }
        .topbar-right .user-info { margin-bottom: 0; padding: 12px 18px; }
        .topbar-right .logout-link { margin-top: 0; }
        .topbar-actions { display:flex; align-items:center; gap:12px; }
        .topbar-actions .btn-reset { flex: 0 0 auto; }
        .btn-reset:hover { background:rgba(239,68,68,0.25) !important; color:#fff !important; }

        /* 两栏网格 */
        .grid {
            display: grid;
            grid-template-columns: 1.3fr 1fr;
            gap: 18px;
            align-items: start;
        }
        .col-right { display: flex; flex-direction: column; gap: 18px; }
        /* 进入酒馆按钮按自身高度，不随列拉伸（base button 有 flex:1） */
        .col-right > .btn-enter { flex: 0 0 auto; }

        /* 卡片 */
        .card {
            background: rgba(255,255,255,0.035);
            border: 1px solid rgba(255,255,255,0.07);
            border-radius: 14px;
            padding: 18px 18px 16px;
        }
        .card-title {
            font-size: 15px; font-weight: 700; color: #d4d9ec;
            margin-bottom: 14px; display: flex; align-items: center; gap: 8px;
        }
        /* 卡片内部更紧凑 */
        .card .config-section { margin-bottom: 12px; padding: 13px 14px; }
        .card .config-section:last-of-type { margin-bottom: 12px; }
        .card .section-title { font-size: 13px; margin: 14px 0 8px; color: #9aa1bb; }
        .card .btn-group { margin-bottom: 0; }
        .card .btn-enter { margin: 0; }

        /* 窄屏（手机/小窗）回退为单栏 */
        @media (max-width: 760px) {
            .container { padding: 24px 20px; }
            .topbar { flex-direction: column; align-items: stretch; gap: 14px; }
            .topbar-right { align-items: stretch; }
            .topbar-right .user-info { width: 100%; }
            .topbar-left h1 { text-align: center; }
            .topbar-left .logo, .topbar-left .subtitle { text-align: center; }
            .grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- 顶部栏：标题 + 用户信息/退出 -->
        <div class="topbar">
            <div class="topbar-left">
                ${brand}
                <h1>数据管理中心</h1>
                <p class="subtitle">备份和恢复您的 SillyTavern 数据</p>
            </div>
            <div class="topbar-right">
                <div class="user-info" id="userInfo">
                    <div><span class="label">当前用户：</span><span class="value" id="userName">加载中...</span></div>
                    <div><span class="label">登录账号：</span><span class="value" id="userHandle">加载中...</span></div>
                </div>
                <div class="topbar-actions">
                    <button class="btn-link btn-reset" id="resetEverythingBtn" style="font-size:12px;padding:5px 10px;background:rgba(239,68,68,0.12);color:#fca5a5;border:1px solid rgba(239,68,68,0.25);border-radius:6px;cursor:pointer;">重置一切</button>
                    <a id="logoutLink">退出登录</a>
                </div>
            </div>
        </div>

        <!-- 消息 / 进度（全宽，操作时显示） -->
        <div class="message" id="message"></div>
        <div class="progress-container" id="progressContainer">
            <div class="progress-bar">
                <div class="progress-fill" id="progressFill"></div>
            </div>
            <div class="progress-text" id="progressText">准备中...</div>
        </div>

        <!-- 两栏 -->
        <div class="grid">
            <!-- 左栏：云端备份与恢复 -->
            <div class="card">
                <div class="card-title">☁️ 云端备份与恢复</div>

                <div class="config-section">
                    <label for="backupPlatform">选择备份平台</label>
                    <select id="backupPlatform">
                        <option value="modelscope">魔搭社区 (ModelScope)</option>
                        <option value="huggingface">Hugging Face</option>
                        <option value="webdav">WebDAV（NAS / 自建云盘）</option>
                    </select>
                    <button class="btn-secondary" id="testConnBtn" style="width:100%;margin-top:10px;">
                        <span class="spinner" id="testConnSpinner"></span>
                        🔍 测试连接
                    </button>
                    <div class="hint" id="testConnResult" style="margin-top:8px;"></div>
                </div>

                <div id="gitInfoConfig" style="display:none;">
                    <div class="section-title">Git 提交信息</div>
                    <div class="config-section">
                        <label for="gitUserName">Git 用户名</label>
                        <input type="text" id="gitUserName" placeholder="例如：YourName">
                        <div class="hint">用于 Git 提交记录</div>
                    </div>
                    <div class="config-section">
                        <label for="gitUserEmail">Git 邮箱</label>
                        <input type="email" id="gitUserEmail" placeholder="例如：your@email.com">
                        <div class="hint">用于 Git 提交记录，Hugging Face 可能需要真实邮箱</div>
                    </div>
                </div>

                <div id="modelScopeConfig">
                    <div class="section-title">魔搭社区配置</div>
                    <div class="config-section">
                        <label for="modelScopeToken">ModelScope Access Token</label>
                        <input type="password" id="modelScopeToken" placeholder="输入您的魔搭社区 Access Token">
                        <div class="hint">在 <a href="https://modelscope.cn/my/myaccesstoken" target="_blank" style="color:#b9a3ff;">魔搭社区</a> 获取 Token</div>
                    </div>
                    <div class="config-section">
                        <label for="modelScopeDataset">数据集名称</label>
                        <input type="text" id="modelScopeDataset" placeholder="例如：username/st-backup">
                        <div class="hint">格式：用户名/数据集名称</div>
                    </div>
                </div>

                <div id="huggingFaceConfig" style="display:none;">
                    <div class="section-title">Hugging Face 配置</div>
                    <div class="config-section">
                        <label for="huggingFaceToken">Hugging Face Access Token</label>
                        <input type="password" id="huggingFaceToken" placeholder="输入您的 Hugging Face Access Token">
                        <div class="hint">在 <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#b9a3ff;">Hugging Face</a> 获取 Token（需要 write 权限）</div>
                    </div>
                    <div class="config-section">
                        <label for="huggingFaceDataset">数据集名称</label>
                        <input type="text" id="huggingFaceDataset" placeholder="例如：username/st-backup">
                        <div class="hint">格式：用户名/数据集名称</div>
                    </div>
                </div>

                <div id="webdavConfig" style="display:none;">
                    <div class="section-title">WebDAV 配置</div>
                    <div class="config-section">
                        <label for="webdavUrl">WebDAV 服务器地址</label>
                        <input type="text" id="webdavUrl" placeholder="例如：https://dav.example.com/backups 或 http://192.168.1.1:8080/dav">
                        <div class="hint">WebDAV 服务器的完整 URL（不含文件名）</div>
                    </div>
                    <div class="config-section">
                        <label for="webdavUsername">用户名</label>
                        <input type="text" id="webdavUsername" placeholder="WebDAV 登录用户名">
                    </div>
                    <div class="config-section">
                        <label for="webdavPassword">密码</label>
                        <input type="password" id="webdavPassword" placeholder="WebDAV 登录密码">
                    </div>
                </div>

                <div class="config-section">
                    <label for="restoreFileName">恢复文件名（可选）</label>
                    <input type="text" id="restoreFileName" placeholder="留空 = 恢复自己的备份">
                    <div class="hint">恢复别的账号/别处备份过来的文件时填写，例如：backup-小明.zip。仅恢复时生效，备份不受影响。</div>
                </div>

                <div class="btn-group">
                    <button class="btn-secondary" id="backupBtn">
                        <span class="spinner" id="backupSpinner"></span>
                        备份数据
                    </button>
                    <button class="btn-primary" id="restoreBtn">
                        <span class="spinner" id="restoreSpinner"></span>
                        恢复数据
                    </button>
                </div>
            </div>

            <!-- 右栏：进入酒馆 + 本地备份 -->
            <div class="col-right">
                <button class="btn-enter" id="enterBtn">
                    🏰 进入酒馆
                </button>

                <div class="card">
                    <div class="card-title">📁 本地备份</div>
                    <div class="config-section">
                        <label for="localBackupFile">上传本地备份文件</label>
                        <input type="file" id="localBackupFile" accept=".zip" style="display:none;">
                        <button class="btn-secondary" id="uploadBackupBtn" style="width:100%;margin-bottom:12px;">
                            📁 选择备份文件
                        </button>
                        <div class="hint" id="uploadHint">支持 .zip 格式的备份文件</div>
                        <button class="btn-primary" id="restoreLocalBtn" style="width:100%;display:none;margin-top:12px;">
                            <span class="spinner" id="restoreLocalSpinner"></span>
                            恢复本地备份
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- 自定义确认对话框 -->
    <div class="custom-confirm" id="customConfirm">
        <div class="custom-confirm-dialog">
            <div class="custom-confirm-title">确认操作</div>
            <div class="custom-confirm-message" id="confirmMessage">确定要继续吗？</div>
            <div class="custom-confirm-buttons">
                <button class="custom-confirm-btn custom-confirm-btn-cancel" id="confirmCancel">取消</button>
                <button class="custom-confirm-btn custom-confirm-btn-confirm" id="confirmOk">确定</button>
            </div>
        </div>
    </div>

    <script>
        const message = document.getElementById('message');
        const backupBtn = document.getElementById('backupBtn');
        const restoreBtn = document.getElementById('restoreBtn');
        const backupSpinner = document.getElementById('backupSpinner');
        const restoreSpinner = document.getElementById('restoreSpinner');
        const platformSelect = document.getElementById('backupPlatform');
        const modelScopeConfig = document.getElementById('modelScopeConfig');
        const huggingFaceConfig = document.getElementById('huggingFaceConfig');
        const gitInfoConfig = document.getElementById('gitInfoConfig');
        const modelScopeTokenInput = document.getElementById('modelScopeToken');
        const modelScopeDatasetInput = document.getElementById('modelScopeDataset');
        const huggingFaceTokenInput = document.getElementById('huggingFaceToken');
        const huggingFaceDatasetInput = document.getElementById('huggingFaceDataset');
        const gitUserNameInput = document.getElementById('gitUserName');
        const gitUserEmailInput = document.getElementById('gitUserEmail');
        const webdavConfig = document.getElementById('webdavConfig');
        const webdavUrlInput = document.getElementById('webdavUrl');
        const webdavUsernameInput = document.getElementById('webdavUsername');
        const webdavPasswordInput = document.getElementById('webdavPassword');
        const testConnBtn = document.getElementById('testConnBtn');
        const testConnSpinner = document.getElementById('testConnSpinner');
        const testConnResult = document.getElementById('testConnResult');
        const restoreFileNameInput = document.getElementById('restoreFileName');
        const progressContainer = document.getElementById('progressContainer');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const localBackupFile = document.getElementById('localBackupFile');
        const uploadBackupBtn = document.getElementById('uploadBackupBtn');
        const restoreLocalBtn = document.getElementById('restoreLocalBtn');
        const restoreLocalSpinner = document.getElementById('restoreLocalSpinner');
        const uploadHint = document.getElementById('uploadHint');

        let selectedFile = null;

        function showMessage(text, type = 'info') {
            message.textContent = text;
            message.className = 'message show ' + type;
            setTimeout(() => message.classList.remove('show'), 5000);
        }

        function showPersistentMessage(text, type = 'info') {
            message.textContent = text;
            message.className = 'message show ' + type;
            // 不设置 setTimeout，消息会一直显示
        }

        function hideMessage() {
            message.classList.remove('show');
        }

        function showProgress(text, percent) {
            progressContainer.classList.add('show');
            progressFill.style.width = percent + '%';
            progressText.textContent = text;
        }

        function hideProgress() {
            progressContainer.classList.remove('show');
            progressFill.style.width = '0%';
        }

        // 自定义确认对话框
        function customConfirm(message) {
            return new Promise((resolve) => {
                const confirmDialog = document.getElementById('customConfirm');
                const confirmMessage = document.getElementById('confirmMessage');
                const confirmOk = document.getElementById('confirmOk');
                const confirmCancel = document.getElementById('confirmCancel');

                confirmMessage.textContent = message;
                confirmDialog.classList.add('show');

                function cleanup() {
                    confirmDialog.classList.remove('show');
                    confirmOk.removeEventListener('click', handleOk);
                    confirmCancel.removeEventListener('click', handleCancel);
                }

                function handleOk() {
                    cleanup();
                    resolve(true);
                }

                function handleCancel() {
                    cleanup();
                    resolve(false);
                }

                confirmOk.addEventListener('click', handleOk);
                confirmCancel.addEventListener('click', handleCancel);
            });
        }

        // 加载用户信息
        fetch('/api/current-user')
            .then(r => {
                if (!r.ok) {
                    throw new Error('HTTP ' + r.status);
                }
                return r.json();
            })
            .then(data => {
                // SillyTavern 返回的数据可能是 {user: {...}} 或直接是用户对象
                const user = data.user || data;
                if (user && user.handle) {
                    document.getElementById('userName').textContent = user.name || '未知';
                    document.getElementById('userHandle').textContent = user.handle || '未知';
                    // 保存到 localStorage 用于备份/恢复
                    localStorage.setItem('currentUserHandle', user.handle);
                } else {
                    console.error('用户数据格式错误:', data);
                    throw new Error('Invalid user data');
                }
            })
            .catch(err => {
                console.error('加载用户信息失败:', err);
                document.getElementById('userName').textContent = '加载失败';
                document.getElementById('userHandle').textContent = '加载失败';
                showMessage('无法加载用户信息，备份和恢复功能将不可用。请确保 SillyTavern 正在运行。', 'error');
                // 不要自动跳转，让用户可以看到错误信息
            });

        // 从服务器加载备份配置（存在用户数据目录下，换设备/恢复后自动还原）。
        // platform 切换是纯 UI 状态，仍用 localStorage 记一下，避免每次默认跳回魔搭。
        function applyBackupConfig(cfg) {
            cfg = cfg || {};
            const savedPlatform = cfg.platform || localStorage.getItem('backupPlatform') || 'modelscope';
            platformSelect.value = savedPlatform;
            if (cfg.modelScopeToken) modelScopeTokenInput.value = cfg.modelScopeToken;
            if (cfg.modelScopeDataset) modelScopeDatasetInput.value = cfg.modelScopeDataset;
            if (cfg.huggingFaceToken) huggingFaceTokenInput.value = cfg.huggingFaceToken;
            if (cfg.huggingFaceDataset) huggingFaceDatasetInput.value = cfg.huggingFaceDataset;
            if (cfg.gitUserName) gitUserNameInput.value = cfg.gitUserName;
            if (cfg.gitUserEmail) gitUserEmailInput.value = cfg.gitUserEmail;
            if (cfg.webdavUrl) webdavUrlInput.value = cfg.webdavUrl;
            if (cfg.webdavUsername) webdavUsernameInput.value = cfg.webdavUsername;
            if (cfg.webdavPassword) webdavPasswordInput.value = cfg.webdavPassword;
            switchPlatform(); // 按 platform 显示对应配置区
        }

        fetch('/api/backup-config')
            .then(r => r.ok ? r.json() : {})
            .then(applyBackupConfig)
            .catch(err => {
                console.error('加载备份配置失败:', err);
                applyBackupConfig(null); // 失败也要初始化 UI
            });

        // 平台切换
        function switchPlatform() {
            const platform = platformSelect.value;
            localStorage.setItem('backupPlatform', platform);

            if (platform === 'modelscope') {
                modelScopeConfig.style.display = 'block';
                huggingFaceConfig.style.display = 'none';
                webdavConfig.style.display = 'none';
                gitInfoConfig.style.display = 'none';
            } else if (platform === 'huggingface') {
                modelScopeConfig.style.display = 'none';
                huggingFaceConfig.style.display = 'block';
                webdavConfig.style.display = 'none';
                gitInfoConfig.style.display = 'block';
            } else if (platform === 'webdav') {
                modelScopeConfig.style.display = 'none';
                huggingFaceConfig.style.display = 'none';
                webdavConfig.style.display = 'block';
                gitInfoConfig.style.display = 'none';
            }
        }

        // 把当前表单收集成配置对象
        function collectBackupConfig() {
            return {
                platform: platformSelect.value,
                modelScopeToken: modelScopeTokenInput.value.trim(),
                modelScopeDataset: modelScopeDatasetInput.value.trim(),
                huggingFaceToken: huggingFaceTokenInput.value.trim(),
                huggingFaceDataset: huggingFaceDatasetInput.value.trim(),
                gitUserName: gitUserNameInput.value.trim(),
                gitUserEmail: gitUserEmailInput.value.trim(),
                webdavUrl: webdavUrlInput.value.trim(),
                webdavUsername: webdavUsernameInput.value.trim(),
                webdavPassword: webdavPasswordInput.value,
            };
        }

        // 防抖保存到服务器（存进用户数据目录，换设备/恢复后免重配）
        let saveCfgTimer = null;
        function saveBackupConfig() {
            clearTimeout(saveCfgTimer);
            saveCfgTimer = setTimeout(() => {
                fetch('/api/backup-config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(collectBackupConfig()),
                }).catch(err => console.error('保存备份配置失败:', err));
            }, 600);
        }

        platformSelect.addEventListener('change', () => { switchPlatform(); saveBackupConfig(); });
        switchPlatform(); // 初始化显示

        // 任一配置项变化即防抖保存到服务器
        [modelScopeTokenInput, modelScopeDatasetInput, huggingFaceTokenInput,
         huggingFaceDatasetInput, gitUserNameInput, gitUserEmailInput,
         webdavUrlInput, webdavUsernameInput, webdavPasswordInput].forEach((el) => {
            el.addEventListener('input', saveBackupConfig);
            el.addEventListener('blur', saveBackupConfig);
        });

        // 测试连接
        testConnBtn.addEventListener('click', async () => {
            const platform = platformSelect.value;
            const payload = { platform };
            if (platform === 'modelscope') {
                payload.token = modelScopeTokenInput.value.trim();
                payload.dataset = modelScopeDatasetInput.value.trim();
            } else if (platform === 'huggingface') {
                payload.token = huggingFaceTokenInput.value.trim();
                payload.dataset = huggingFaceDatasetInput.value.trim();
            } else if (platform === 'webdav') {
                payload.webdavUrl = webdavUrlInput.value.trim();
                payload.webdavUsername = webdavUsernameInput.value.trim();
                payload.webdavPassword = webdavPasswordInput.value;
            }
            testConnResult.textContent = '';
            testConnResult.style.color = '';
            testConnBtn.disabled = true;
            testConnSpinner.style.display = 'inline-block';
            try {
                const r = await fetch('/api/test-connection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const d = await r.json().catch(() => ({}));
                if (d && d.ok) {
                    testConnResult.textContent = '✅ ' + (d.message || '连接成功');
                    testConnResult.style.color = '#86efac';
                } else {
                    testConnResult.textContent = '❌ ' + ((d && d.error) || '连接失败');
                    testConnResult.style.color = '#fca5a5';
                }
            } catch (e) {
                testConnResult.textContent = '❌ 测试失败：网络错误';
                testConnResult.style.color = '#fca5a5';
            } finally {
                testConnBtn.disabled = false;
                testConnSpinner.style.display = 'none';
            }
        });

        // 备份数据
        backupBtn.addEventListener('click', async () => {
            const platform = platformSelect.value;
            const userHandle = localStorage.getItem('currentUserHandle');
            const gitUserName = gitUserNameInput.value.trim();
            const gitUserEmail = gitUserEmailInput.value.trim();
            const wUrl = webdavUrlInput ? webdavUrlInput.value.trim() : '';
            const wUser = webdavUsernameInput ? webdavUsernameInput.value.trim() : '';
            const wPass = webdavPasswordInput ? webdavPasswordInput.value : '';

            let token, dataset;
            if (platform === 'modelscope') {
                token = modelScopeTokenInput.value.trim();
                dataset = modelScopeDatasetInput.value.trim();
            } else if (platform === 'huggingface') {
                token = huggingFaceTokenInput.value.trim();
                dataset = huggingFaceDatasetInput.value.trim();
            }

            if (platform === 'webdav') {
                if (!wUrl || !wUser || !wPass) {
                    showMessage('请先配置 WebDAV 地址、用户名和密码', 'error');
                    return;
                }
            } else {
                if (!token || !dataset) {
                    showMessage('请先配置 Token 和数据集名称', 'error');
                    return;
                }
            }

            // 只有 Hugging Face 需要 Git 用户信息
            if (platform === 'huggingface' && (!gitUserName || !gitUserEmail)) {
                showMessage('请先配置 Git 用户名和邮箱', 'error');
                return;
            }

            if (!userHandle) {
                showMessage('无法获取用户信息，请刷新页面', 'error');
                return;
            }

            backupBtn.disabled = true;
            restoreBtn.disabled = true;
            backupSpinner.style.display = 'inline-block';
            hideProgress();
            showPersistentMessage('正在备份数据，请稍候...', 'info');

            try {
                const response = await fetch('/api/backup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform, token, dataset, userHandle, gitUserName, gitUserEmail, webdavUrl: wUrl, webdavUsername: wUser, webdavPassword: wPass })
                });

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                // 使用 EventSource 接收进度
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });

                    const lines = buffer.split('\\n');
                    buffer = lines.pop() || ''; // 保留最后一个不完整的行

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.substring(6));

                                if (data.success !== undefined) {
                                    hideProgress();
                                    if (data.success) {
                                        var msg = '备份成功！文件：' + data.filename + '，大小：' + data.size;
                                        showPersistentMessage(msg, 'success');
                                    } else {
                                        showPersistentMessage(data.message || '备份失败', 'error');
                                    }
                                } else if (data.progress !== null) {
                                    // 进度更新
                                    showProgress(data.message, data.progress);
                                } else {
                                    // 普通消息
                                    showPersistentMessage(data.message, 'info');
                                }
                            } catch (e) {
                                console.error('解析 SSE 数据失败:', e, line);
                            }
                        }
                    }
                }

            } catch (err) {
                hideProgress();
                showPersistentMessage('备份失败：' + err.message, 'error');
            } finally {
                backupBtn.disabled = false;
                restoreBtn.disabled = false;
                backupSpinner.style.display = 'none';
            }
        });

        // 恢复数据
        restoreBtn.addEventListener('click', async () => {
            const platform = platformSelect.value;
            const userHandle = localStorage.getItem('currentUserHandle');
            const wUrl = webdavUrlInput ? webdavUrlInput.value.trim() : '';
            const wUser = webdavUsernameInput ? webdavUsernameInput.value.trim() : '';
            const wPass = webdavPasswordInput ? webdavPasswordInput.value : '';

            let token, dataset;
            if (platform === 'modelscope') {
                token = modelScopeTokenInput.value.trim();
                dataset = modelScopeDatasetInput.value.trim();
            } else if (platform === 'huggingface') {
                token = huggingFaceTokenInput.value.trim();
                dataset = huggingFaceDatasetInput.value.trim();
            }

            if (platform === 'webdav') {
                if (!wUrl || !wUser || !wPass) {
                    showMessage('请先配置 WebDAV 地址、用户名和密码', 'error');
                    return;
                }
            } else {
                if (!token || !dataset) {
                    showMessage('请先配置 Token 和数据集名称', 'error');
                    return;
                }
            }

            if (!userHandle) {
                showMessage('无法获取用户信息，请刷新页面', 'error');
                return;
            }

            const confirmed = await customConfirm('恢复数据将覆盖当前所有数据，确定要继续吗？');
            if (!confirmed) {
                return;
            }

            backupBtn.disabled = true;
            restoreBtn.disabled = true;
            restoreSpinner.style.display = 'inline-block';
            hideProgress();
            showPersistentMessage('正在恢复数据，请稍候...', 'info');

            try {
                const response = await fetch('/api/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform, token, dataset, userHandle, webdavUrl: wUrl, webdavUsername: wUser, webdavPassword: wPass, restoreFileName: restoreFileNameInput ? restoreFileNameInput.value.trim() : '' })
                });

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                // 使用 EventSource 接收进度
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });

                    const lines = buffer.split('\\n');
                    buffer = lines.pop() || ''; // 保留最后一个不完整的行

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.substring(6));

                                if (data.success !== undefined) {
                                    hideProgress();
                                    if (data.success) {
                                        var msg = '恢复成功！文件：' + data.filename + '，大小：' + data.size;
                                        showPersistentMessage(msg, 'success');
                                    } else {
                                        showPersistentMessage(data.message || '恢复失败', 'error');
                                    }
                                } else if (data.progress !== null) {
                                    // 进度更新
                                    showProgress(data.message, data.progress);
                                } else {
                                    // 普通消息
                                    showPersistentMessage(data.message, 'info');
                                }
                            } catch (parseErr) {
                                console.error('解析 SSE 数据失败:', parseErr);
                            }
                        }
                    }
                }
            } catch (err) {
                hideProgress();
                showPersistentMessage('恢复失败：' + err.message, 'error');
            } finally {
                backupBtn.disabled = false;
                restoreBtn.disabled = false;
                restoreSpinner.style.display = 'none';
            }
        });

        // 进入酒馆
        document.getElementById('enterBtn').addEventListener('click', () => {
            window.location.href = '/';
        });

        // 本地备份上传
        uploadBackupBtn.addEventListener('click', () => {
            localBackupFile.click();
        });

        localBackupFile.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (!file.name.endsWith('.zip')) {
                    showMessage('请选择 .zip 格式的备份文件', 'error');
                    return;
                }
                selectedFile = file;
                const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                uploadHint.textContent = '已选择：' + file.name + ' (' + sizeMB + ' MB)';
                uploadHint.style.color = '#86efac';
                restoreLocalBtn.style.display = 'block';
            }
        });

        restoreLocalBtn.addEventListener('click', async () => {
            if (!selectedFile) {
                showMessage('请先选择备份文件', 'error');
                return;
            }

            const userHandle = localStorage.getItem('currentUserHandle');
            if (!userHandle) {
                showMessage('无法获取用户信息，请刷新页面', 'error');
                return;
            }

            const confirmed = await customConfirm('恢复本地备份将覆盖当前所有数据，确定要继续吗？');
            if (!confirmed) {
                return;
            }

            backupBtn.disabled = true;
            restoreBtn.disabled = true;
            restoreLocalBtn.disabled = true;
            restoreLocalSpinner.style.display = 'inline-block';
            hideProgress();
            showPersistentMessage('正在上传并恢复本地备份，请稍候...', 'info');

            try {
                const formData = new FormData();
                formData.append('file', selectedFile);
                formData.append('userHandle', userHandle);

                const response = await fetch('/api/restore-local', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                // 使用 EventSource 接收进度
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });

                    const lines = buffer.split('\\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.substring(6));

                                if (data.success !== undefined) {
                                    hideProgress();
                                    if (data.success) {
                                        showPersistentMessage('本地备份恢复成功！', 'success');
                                        // 清除选择的文件
                                        selectedFile = null;
                                        localBackupFile.value = '';
                                        uploadHint.textContent = '支持 .zip 格式的备份文件';
                                        uploadHint.style.color = '#6b7290';
                                        restoreLocalBtn.style.display = 'none';
                                    } else {
                                        showPersistentMessage(data.message || '恢复失败', 'error');
                                    }
                                } else if (data.progress !== null) {
                                    showProgress(data.message, data.progress);
                                } else {
                                    showPersistentMessage(data.message, 'info');
                                }
                            } catch (parseErr) {
                                console.error('解析 SSE 数据失败:', parseErr);
                            }
                        }
                    }
                }
            } catch (err) {
                hideProgress();
                showPersistentMessage('恢复失败：' + err.message, 'error');
            } finally {
                backupBtn.disabled = false;
                restoreBtn.disabled = false;
                restoreLocalBtn.disabled = false;
                restoreLocalSpinner.style.display = 'none';
            }
        });

        // 重置一切：删除当前用户全部 SillyTavern 数据，恢复到初始状态
        // （不清除云端备份配置，重置后无需重新填 token/数据集）。
        document.getElementById('resetEverythingBtn').addEventListener('click', async () => {
            const confirmed = await customConfirm(
                '⚠️ 确定要重置一切吗？' + String.fromCharCode(10, 10) +
                '这将删除您的所有角色、聊天记录、设置、世界书等全部数据，' +
                '恢复到初始状态。备份配置（token / 数据集）会保留。' + String.fromCharCode(10, 10) +
                '此操作不可撤销！'
            );
            if (!confirmed) return;
            const btn = document.getElementById('resetEverythingBtn');
            btn.disabled = true; btn.textContent = '重置中…';
            try {
                const r = await fetch('/api/reset-everything', { method: 'POST', credentials: 'include' });
                if (!r.ok) {
                    const d = await r.json().catch(() => ({}));
                    showPersistentMessage((d && d.error) || '重置失败', 'error');
                    return;
                }
                showPersistentMessage('✅ 重置成功！数据已恢复到初始状态。', 'success');
            } catch (e) {
                console.error('重置失败:', e);
                showPersistentMessage('重置失败：网络错误', 'error');
            } finally {
                btn.disabled = false; btn.textContent = '重置一切';
            }
        });

        // 退出登录
        document.getElementById('logoutLink').addEventListener('click', async () => {
            const confirmed = await customConfirm('确定要退出登录吗？');
            if (confirmed) {
                try {
                    // 调用本服务的登出接口：直接清除 SillyTavern 的 session cookie。
                    await fetch('/api/logout', {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    console.error('退出登录失败:', e);
                }
                // 无论是否成功，都跳转到登录页（用 replace 避免后退键回到 dashboard）
                window.location.replace('/login');
            }
        });
    </script>
</body>
</html>`;
}

// ─── Authentication Middleware ───────────────────────────────────────────────

// 说明：登录态判断统一用 isLoggedIn()（定义在反向代理区，函数声明已提升）。
// 它本地解码 SillyTavern 的 session cookie（base64(JSON)），只有当里面带有非空的用户
// handle 时才算「已登录」—— 仅有匿名会话（只含 csrfToken）不算。绝不向 SillyTavern 发
// 额外请求：SillyTavern 用 cookie-session，CSRF token 存在 session cookie 里，任何额外的
// 代理请求都可能触发它返回新的 Set-Cookie，处理不当就会让浏览器 CSRF token 与服务端失配，
// 导致聊天 / 切换角色 / QR 等 POST 请求校验失败。

// 需要登录的中间件（轻量：本地解码 session cookie 判断是否真正登录，不发请求污染 session）
function requireAuth(req, res, next) {
    if (!isLoggedIn(req)) {
        return res.redirect('/login');
    }
    next();
}

// 已登录则重定向到数据管理页 /st（轻量：本地解码 session cookie，仅真正登录才跳转）
function redirectIfAuth(req, res, next) {
    if (isLoggedIn(req)) {
        return res.redirect('/st');
    }
    next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// 数据管理页（登录后的中心页，路径 /st）
app.get('/st', requireAuth, (_req, res) => {
    res.type('html').send(buildDashboardPage());
});

// 公开统计（登录/注册页用来显示「当前人数 / 上限」）。
// 用户数缓存 5 秒，避免高并发下频繁扫描存储。
let _statsCache = { at: 0, count: 0 };
app.get('/stats', async (_req, res) => {
    try {
        const now = Date.now();
        if (now - _statsCache.at > 5000) {
            _statsCache = { at: now, count: await countUsers() };
        }
        return res.json({
            users: _statsCache.count,
            maxUsers: REGISTRATION.maxUsers, // 0 = 不限
            full: REGISTRATION.maxUsers > 0 && _statsCache.count >= REGISTRATION.maxUsers,
        });
    } catch {
        return res.json({ users: 0, maxUsers: REGISTRATION.maxUsers, full: false });
    }
});

// 服务器公网 IP / 中文地区（启动时获取并缓存，登录页展示）。
app.get('/server-info', (_req, res) => {
    res.json({ ip: SERVER_INFO.ip, location: SERVER_INFO.location });
});

// 背景元信息（前端据此决定是否启用背景及遮罩/模糊参数；不暴露本地路径）。
function bgEnabled() {
    const b = BACKGROUND;
    if (b.mode === 'api') return !!b.api;
    if (b.mode === 'urls') return b.urls.length > 0;
    if (b.mode === 'local') return !!b.local;
    if (b.mode === 'folder') return !!b.folder;
    return false;
}
app.get('/bg-info', (_req, res) => {
    res.json({ enabled: bgEnabled(), dim: BACKGROUND.dim, blur: BACKGROUND.blur });
});

// 友情链接（登录/注册页底部展示）。
app.get('/friend-links', (_req, res) => {
    res.json({
        enabled: FRIEND_LINKS.enabled,
        links: FRIEND_LINKS.enabled ? FRIEND_LINKS.links : [],
    });
});

// 返回一张背景图。api/urls 模式重定向到外链；local/folder 模式直接发送本地图片。
app.get('/bg', (_req, res) => {
    try {
        const b = BACKGROUND;
        if (b.mode === 'api' && b.api) {
            return res.redirect(b.api);
        }
        if (b.mode === 'urls' && b.urls.length) {
            const pick = b.urls[Math.floor(Math.random() * b.urls.length)];
            return res.redirect(pick);
        }
        if (b.mode === 'local' && b.local) {
            const p = resolveBgPath(b.local);
            if (p && isImageFile(p) && fs.existsSync(p)) {
                res.setHeader('Cache-Control', 'no-store');
                return res.sendFile(p);
            }
        }
        if (b.mode === 'folder' && b.folder) {
            const dir = resolveBgPath(b.folder);
            if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                const files = fs.readdirSync(dir).filter(isImageFile);
                if (files.length) {
                    const pick = files[Math.floor(Math.random() * files.length)];
                    res.setHeader('Cache-Control', 'no-store');
                    return res.sendFile(path.join(dir, pick));
                }
            }
        }
    } catch (err) {
        console.warn('[背景] 获取失败:', err.message);
    }
    return res.status(404).end();
});

// 融合登录/注册页（同一个页面，3D 翻转切换）。两个 URL 都返回它，只是初始翻到
// 对应的一面：/login 默认登录面（SillyTavern 未登录会重定向到这里），/register 默认注册面。
// 页面 HTML 仅在配置变化时重建（缓存）。
const getLoginPage = makeVersionedCache(() => buildAuthPage('login'));
const getRegisterPage = makeVersionedCache(() => buildAuthPage('register'));
app.get('/login', redirectIfAuth, (_req, res) => {
    res.type('html').send(getLoginPage());
});
app.get('/register', redirectIfAuth, (_req, res) => {
    res.type('html').send(getRegisterPage());
});

// Handle registration
app.post('/register', jsonParser, formParser, rateLimiter, async (req, res) => {
    try {
        const { name, password } = req.body;

        // Validate input
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: '请输入显示名称。' });
        }

        const trimmedName = name.trim();

        // Generate handle from name
        const handle = slugify(trimmedName);
        if (!handle) {
            return res.status(400).json({
                error: '无法从该名称生成有效的登录账号，名称中至少需要包含一个字母或数字。',
            });
        }

        if (handle.length > 64) {
            return res.status(400).json({
                error: '生成的登录账号过长，请使用更短的名称。',
            });
        }

        // Check for reserved handles
        if (handle === 'default-user') {
            return res.status(400).json({
                error: '此名称已被保留，请使用其他名称。',
            });
        }

        // Check if user already exists
        const existingUser = await storage.getItem(toKey(handle));
        if (existingUser) {
            return res.status(409).json({
                error: `登录账号 "${handle}" 已被占用，请使用其他显示名称。`,
            });
        }

        // 注册人数上限校验（maxUsers=0 表示不限）
        if (REGISTRATION.maxUsers > 0) {
            const current = await countUsers();
            if (current >= REGISTRATION.maxUsers) {
                return res.status(403).json({
                    error: `注册名额已满（上限 ${REGISTRATION.maxUsers} 人），暂时无法注册。`,
                });
            }
        }

        // Hash password if provided
        let hashedPassword = '';
        let salt = '';
        if (password) {
            salt = getPasswordSalt();
            hashedPassword = getPasswordHash(password, salt);
        }

        // Create user object (mirrors src/endpoints/users-admin.js)
        const newUser = {
            handle: handle,
            name: trimmedName,
            created: Date.now(),
            password: hashedPassword,
            salt: salt,
            admin: false,   // Self-registered users are never admins
            enabled: true,
        };

        // Store user
        await storage.setItem(toKey(handle), newUser);
        console.log(`[注册] 新用户创建: "${handle}" (${trimmedName})`);

        // Create user data directories
        console.log(`[注册] 正在为 ${handle} 创建数据目录`);
        createUserDirectories(handle);

        // Seed default content (settings.json, themes, presets, etc.) so the
        // account boots normally instead of hanging on initialization.
        seedDefaultContent(handle);

        // Increment rate limit counter
        req._rateLimitEntry.count++;

        // 让公开统计立即反映新用户
        _statsCache.at = 0;

        return res.status(201).json({
            handle: handle,
            name: trimmedName,
            message: '账户创建成功。',
        });
    } catch (err) {
        console.error('[注册] 错误:', err);
        return res.status(500).json({ error: '服务器内部错误，请稍后重试。' });
    }
});

// ─── Backup & Restore API ────────────────────────────────────────────────────

// 任务队列管理
class TaskQueue {
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = maxConcurrent;
        this.running = 0;
        this.queue = [];
    }

    async add(task) {
        // 如果已达到最大并发数，加入队列等待
        if (this.running >= this.maxConcurrent) {
            await new Promise(resolve => this.queue.push(resolve));
        }

        this.running++;
        try {
            return await task();
        } finally {
            this.running--;
            // 处理队列中的下一个任务
            if (this.queue.length > 0) {
                const resolve = this.queue.shift();
                resolve();
            }
        }
    }

    getStatus() {
        return {
            running: this.running,
            queued: this.queue.length,
            total: this.running + this.queue.length
        };
    }
}

// 创建备份和恢复任务队列（最多同时 2 个任务）
const backupQueue = new TaskQueue(2);
const restoreQueue = new TaskQueue(2);

// 配置限制
const BACKUP_CONFIG = {
    MAX_SIZE_MB: 5000,           // 最大备份大小 5GB
    TIMEOUT_MS: 30 * 60 * 1000,  // 超时时间 30 分钟
    WARN_SIZE_MB: 1000,          // 警告大小 1GB
};

// 计算目录大小（递归）
function getDirectorySize(dirPath) {
    let totalSize = 0;

    function calculateSize(currentPath) {
        try {
            const stats = fs.statSync(currentPath);

            if (stats.isFile()) {
                totalSize += stats.size;
            } else if (stats.isDirectory()) {
                const files = fs.readdirSync(currentPath);
                for (const file of files) {
                    calculateSize(path.join(currentPath, file));
                }
            }
        } catch (err) {
            // 忽略无法访问的文件
        }
    }

    calculateSize(dirPath);
    return totalSize;
}

// ─── WebDAV 备份/恢复（HTTP PUT/GET，零 Git 依赖）────────────────────────
// 对任意 WebDAV 服务器（NAS、NextCloud、ownCloud、InfiniCLOUD、TeraCLOUD 等）
// 直接上传/下载 zip 文件。使用 HTTP Basic Auth，纯 Node 内置模块实现，无需额外依赖。

function webdavRequest(url, method, body, authHeader, streamCallback, extraHeaders) {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const auth = typeof authHeader === 'string' ? authHeader :
        (authHeader ? `Basic ${Buffer.from(`${authHeader.username}:${authHeader.password}`).toString('base64')}` : null);

    return new Promise((resolve, reject) => {
        const opts = {
            method,
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: {
                'User-Agent': 'st-register-webdav/1.0',
                ...(auth ? { Authorization: auth } : {}),
                ...(body ? { 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/zip' } : {}),
                ...(extraHeaders || {}),
            },
            timeout: 600_000, // 10 分钟超时（应对大文件慢速上传）
        };

        const httpReq = mod.request(opts, (res) => {
            // 2xx = 成功；3xx = 重定向不跟踪（简单场景下基本不会遇到）
            if (res.statusCode >= 200 && res.statusCode < 300) {
                if (streamCallback) {
                    streamCallback(res, resolve, reject);
                } else {
                    // 无回调 = 只需确认成功即可（如 PUT），吞掉响应体
                    res.resume();
                    resolve({ status: res.statusCode });
                }
            } else if (res.statusCode >= 300 && res.statusCode < 400) {
                // 跟进一次重定向
                const loc = res.headers.location;
                if (loc) {
                    resolve(webdavRequest(loc, method, body, authHeader, streamCallback));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: 重定向未带 Location 头`));
                }
            } else {
                let msg = '';
                res.on('data', c => msg += c.toString());
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${msg.slice(0, 500)}`)));
            }
        });
        httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('请求超时')); });
        httpReq.on('error', reject);
        if (body) httpReq.write(body);
        httpReq.end();
    });
}

// 上传 zip 到 WebDAV，带进度回调
async function webdavUpload(zipPath, filename, url, auth) {
    const stat = fs.statSync(zipPath);
    const fileSizeMB = (stat.size / 1024 / 1024).toFixed(2);
    const targetUrl = url.replace(/\/+$/, '') + '/' + encodeURIComponent(filename);
    console.log(`[WebDAV] 上传: ${targetUrl} (${fileSizeMB} MB)`);
    const data = fs.readFileSync(zipPath);
    await webdavRequest(targetUrl, 'PUT', data, auth);
    return { size: fileSizeMB };
}

// 从 WebDAV 下载 zip 到本地路径，带进度回调
async function webdavDownload(filename, url, auth, destPath) {
    const targetUrl = url.replace(/\/+$/, '') + '/' + encodeURIComponent(filename);
    console.log(`[WebDAV] 下载: ${targetUrl}`);
    const file = fs.createWriteStream(destPath);
    await webdavRequest(targetUrl, 'GET', null, auth, (res, resolve, reject) => {
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let received = 0;
        res.on('data', c => {
            received += c.length;
            file.write(c);
        });
        res.on('end', () => {
            file.end();
            const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(2);
            console.log(`[WebDAV] 下载完成: ${sizeMB} MB`);
            resolve({ size: sizeMB });
        });
        res.on('error', reject);
    });
}

// 测试云端平台配置是否正确（轻量探测，不传输数据）
// Git 类平台用 `git ls-remote` 验证仓库可访问 + token 有效；
// WebDAV 用 PROPFIND（深度 0）验证 URL + 用户名 + 密码可访问目录。
app.post('/api/test-connection', jsonParser, async (req, res) => {
    try {
        const { platform, token, dataset, webdavUrl, webdavUsername, webdavPassword } = req.body || {};

        if (!platform) {
            return res.json({ ok: false, error: '缺少平台参数' });
        }

        if (platform === 'webdav') {
            if (!webdavUrl || !webdavUsername || !webdavPassword) {
                return res.json({ ok: false, error: '请填写 WebDAV 地址、用户名和密码' });
            }
            try {
                // PROPFIND 深度 0：只查目标 URL 本身，验证认证 + 可达性
                const auth = { username: webdavUsername, password: webdavPassword };
                const targetUrl = webdavUrl.replace(/\/+$/, '') + '/';
                await webdavRequest(targetUrl, 'PROPFIND', null, auth, null, { Depth: '0' });
                return res.json({ ok: true, message: 'WebDAV 连接成功，认证有效。' });
            } catch (e) {
                return res.json({ ok: false, error: 'WebDAV 连接失败：' + e.message });
            }
        }

        // Git 类平台：modelscope / huggingface
        if (platform !== 'modelscope' && platform !== 'huggingface') {
            return res.json({ ok: false, error: '不支持的平台' });
        }
        if (!token || !dataset) {
            return res.json({ ok: false, error: '请填写 Token 和数据集名称' });
        }
        const [namespace, datasetName] = String(dataset).split('/');
        if (!namespace || !datasetName) {
            return res.json({ ok: false, error: '数据集名称格式错误，应为：用户名/数据集名称' });
        }

        let repoUrl;
        if (platform === 'modelscope') {
            repoUrl = `https://oauth2:${token}@www.modelscope.cn/datasets/${namespace}/${datasetName}.git`;
        } else {
            repoUrl = `https://user:${token}@huggingface.co/datasets/${namespace}/${datasetName}`;
        }

        try {
            // ls-remote 只取引用列表，不下载数据；30 秒超时
            execSync(`git ls-remote "${repoUrl}"`, { stdio: 'pipe', encoding: 'utf8', timeout: 30000 });
            return res.json({ ok: true, message: '连接成功，仓库可访问且 Token 有效。' });
        } catch (e) {
            const stderr = (e.stderr || '').toString();
            let hint = e.message;
            if (/Authentication|403|401|denied/i.test(stderr)) hint = 'Token 无效或无权限访问该数据集';
            else if (/not found|404|Repository not found/i.test(stderr)) hint = '数据集不存在，请先在平台上创建';
            else if (stderr) hint = stderr.split('\n').slice(0, 3).join(' ');
            return res.json({ ok: false, error: '连接失败：' + hint });
        }
    } catch (err) {
        console.error('[测试连接] 错误:', err);
        return res.json({ ok: false, error: '测试失败：' + err.message });
    }
});

// 备份当前用户数据到远程平台
app.post('/api/backup', jsonParser, async (req, res) => {
    // 设置 SSE 响应头，用于实时推送进度
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function sendProgress(message, progress = null) {
        const data = { message, progress };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    function sendComplete(success, message, data = {}) {
        const result = { success, message, ...data };
        res.write(`data: ${JSON.stringify(result)}\n\n`);
        res.end();
    }

    // 检查队列状态
    const queueStatus = backupQueue.getStatus();
    if (queueStatus.queued > 0) {
        sendProgress(`当前有 ${queueStatus.running} 个备份任务正在进行，您的任务排在第 ${queueStatus.queued + 1} 位...`, 0);
    }

    // 添加到任务队列
    await backupQueue.add(async () => {
        // 设置超时保护
        const timeoutId = setTimeout(() => {
            sendComplete(false, `备份超时（超过 ${BACKUP_CONFIG.TIMEOUT_MS / 60000} 分钟），已自动取消`);
        }, BACKUP_CONFIG.TIMEOUT_MS);

        try {
            const { platform, token, dataset, userHandle, gitUserName, gitUserEmail, webdavUrl, webdavUsername, webdavPassword } = req.body;

            // 通用校验
            if (!platform || !userHandle) {
                clearTimeout(timeoutId);
                return sendComplete(false, '缺少必要参数');
            }

            // 验证平台
            if (platform !== 'modelscope' && platform !== 'huggingface' && platform !== 'webdav') {
                clearTimeout(timeoutId);
                return sendComplete(false, '不支持的备份平台');
            }

            // WebDAV 的凭证校验
            if (platform === 'webdav' && (!webdavUrl || !webdavUsername || !webdavPassword)) {
                clearTimeout(timeoutId);
                return sendComplete(false, '缺少 WebDAV 配置（URL / 用户名 / 密码）');
            }

            // Git 类平台需要 dataset
            if (platform !== 'webdav' && (!token || !dataset)) {
                clearTimeout(timeoutId);
                return sendComplete(false, '缺少必要参数（Token 或数据集名称）');
            }

            // 只有 Hugging Face 需要用户提供 Git 用户信息
            if (platform === 'huggingface' && (!gitUserName || !gitUserEmail)) {
                clearTimeout(timeoutId);
                return sendComplete(false, '缺少 Git 用户信息');
            }

            const userDataDir = path.join(DATA_ROOT, userHandle);
            if (!fs.existsSync(userDataDir)) {
                clearTimeout(timeoutId);
                return sendComplete(false, '用户数据目录不存在');
            }

            // 检查数据目录大小
            sendProgress('正在检查数据大小...', 2);
            const dirSizeBytes = getDirectorySize(userDataDir);
            const dirSizeMB = (dirSizeBytes / 1024 / 1024).toFixed(2);

            if (dirSizeBytes > BACKUP_CONFIG.MAX_SIZE_MB * 1024 * 1024) {
                clearTimeout(timeoutId);
                return sendComplete(false, `数据目录过大（${dirSizeMB} MB），超过限制（${BACKUP_CONFIG.MAX_SIZE_MB} MB）。请清理后再试。`);
            }

            if (dirSizeBytes > BACKUP_CONFIG.WARN_SIZE_MB * 1024 * 1024) {
                sendProgress(`数据目录较大（${dirSizeMB} MB），备份可能需要较长时间...`, 3);
            }

            // 创建临时 zip 文件
            sendProgress('正在扫描数据文件...', 5);
            const timestamp = Date.now();
            const tempZipPath = path.join(getTempDir(), `backup-${userHandle}-${timestamp}.zip`);

        sendProgress('正在压缩数据...', 10);
        const output = fs.createWriteStream(tempZipPath);
        const archive = new ZipArchive({ zlib: { level: 9 } });

        archive.on('error', (err) => {
            console.error('[备份] Archive 错误:', err);
            throw err;
        });

        // 监听压缩进度
        let totalBytes = 0;
        let processedBytes = 0;

        archive.on('progress', (progress) => {
            if (progress.fs && progress.fs.totalBytes > 0) {
                totalBytes = progress.fs.totalBytes;
                processedBytes = progress.fs.processedBytes;
                const percent = Math.floor((processedBytes / totalBytes) * 100);
                const progressPercent = 10 + Math.floor(percent * 0.15); // 10% - 25%
                sendProgress(`正在压缩数据... ${(processedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`, progressPercent);
            }
        });

        // 先设置 close 事件监听器，再开始压缩
        const compressionPromise = new Promise((resolve, reject) => {
            output.on('close', () => {
                resolve();
            });
            output.on('error', reject);
            archive.on('error', reject);
        });

        archive.pipe(output);
        archive.directory(userDataDir, false);
        await archive.finalize();

        // 等待输出流完全关闭
        await compressionPromise;

        const fileSize = (fs.statSync(tempZipPath).size / 1024 / 1024).toFixed(2);
        sendProgress(`压缩完成，文件大小：${fileSize} MB`, 25);

        // ── WebDAV 分支：直接 HTTP PUT，无需 Git ──
        if (platform === 'webdav') {
            try {
                const auth = { username: webdavUsername, password: webdavPassword };
                const backupFileName = `backup-${userHandle}.zip`;
                sendProgress('正在上传到 WebDAV...', 30);
                await webdavUpload(tempZipPath, backupFileName, webdavUrl, auth);
                sendProgress('上传完成，正在清理临时文件...', 95);
                fs.unlinkSync(tempZipPath);
                clearTimeout(timeoutId);
                return sendComplete(true, '备份成功！', { filename: backupFileName, size: fileSize + ' MB' });
            } catch (webdavErr) {
                console.error('[WebDAV备份] 错误:', webdavErr.message);
                if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
                clearTimeout(timeoutId);
                return sendComplete(false, 'WebDAV 备份失败：' + webdavErr.message + '\n请检查 URL、用户名、密码是否正确，以及 WebDAV 服务器是否可访问。');
            }
        }

        // ── Git 类分支：魔搭社区 / Hugging Face ──
        // 解析数据集名称
        const [namespace, datasetName] = dataset.split('/');
        if (!namespace || !datasetName) {
            fs.unlinkSync(tempZipPath);
            return sendComplete(false, '数据集名称格式错误，应为：用户名/数据集名称');
        }

        // 创建临时目录用于 Git 操作
        const platformName = platform === 'modelscope' ? '魔搭社区' : 'Hugging Face';
        sendProgress(`正在连接${platformName}...`, 30);
        const tempGitDir = path.join(getTempDir(), `git-temp-${userHandle}-${timestamp}`);
        fs.mkdirSync(tempGitDir, { recursive: true });

        try {
            // 根据平台构建仓库 URL
            let repoUrl;
            if (platform === 'modelscope') {
                repoUrl = `https://oauth2:${token}@www.modelscope.cn/datasets/${namespace}/${datasetName}.git`;
            } else if (platform === 'huggingface') {
                repoUrl = `https://user:${token}@huggingface.co/datasets/${namespace}/${datasetName}`;
            }

            sendProgress('正在克隆数据集仓库...（可能需要几秒）', 35);
            console.log(`[备份] 克隆仓库: ${namespace}/${datasetName}`);

            try {
                const cloneOutput = execSync(`git clone --depth 1 "${repoUrl}" "${tempGitDir}"`, {
                    stdio: 'pipe',
                    encoding: 'utf8'
                });
                console.log('[备份] 克隆输出:', cloneOutput);
                sendProgress('克隆完成', 50);
            } catch (cloneErr) {
                console.error('[备份] 克隆失败:', cloneErr.message);
                if (cloneErr.stderr) console.error('[备份] 克隆 stderr:', cloneErr.stderr);
                if (cloneErr.stdout) console.error('[备份] 克隆 stdout:', cloneErr.stdout);
                throw new Error('克隆仓库失败：' + cloneErr.message);
            }

            // 配置 Git LFS
            sendProgress('正在配置 Git LFS...', 55);
            console.log('[备份] 配置 Git LFS...');
            try {
                execSync('git lfs install', { cwd: tempGitDir, stdio: 'pipe' });
                console.log('[备份] Git LFS 安装成功');

                // 配置 Git 用户信息（提交需要）
                // Hugging Face 使用用户提供的信息；魔搭社区使用默认值
                const commitName = (platform === 'huggingface' && gitUserName) ? gitUserName : 'ST-Register';
                const commitEmail = (platform === 'huggingface' && gitUserEmail) ? gitUserEmail : 'backup@st-register.local';
                execSync(`git config user.name "${commitName}"`, { cwd: tempGitDir, stdio: 'pipe' });
                execSync(`git config user.email "${commitEmail}"`, { cwd: tempGitDir, stdio: 'pipe' });
                console.log(`[备份] Git 用户信息配置成功: ${commitName} <${commitEmail}>`);
            } catch (lfsErr) {
                console.error('[备份] Git LFS 安装失败:', lfsErr.message);
                if (lfsErr.stderr) console.error('[备份] LFS stderr:', lfsErr.stderr);
                throw new Error('Git LFS 未安装或配置失败');
            }

            // 复制备份文件到仓库
            sendProgress(`正在准备上传 ${fileSize} MB 文件...`, 60);
            const backupFileName = `backup-${userHandle}.zip`;
            const targetPath = path.join(tempGitDir, backupFileName);
            fs.copyFileSync(tempZipPath, targetPath);
            console.log(`[备份] 备份文件已复制: ${backupFileName} (${fileSize} MB)`);

            // 添加到 Git LFS 跟踪
            sendProgress('正在配置 LFS 跟踪...', 65);
            console.log('[备份] 配置 LFS 跟踪 *.zip 文件...');
            execSync(`git lfs track "*.zip"`, { cwd: tempGitDir, stdio: 'pipe' });

            // 提交并推送
            sendProgress('正在添加文件到 Git...', 70);
            console.log('[备份] 添加文件到 Git...');
            execSync('git add .gitattributes', { cwd: tempGitDir, stdio: 'pipe' });
            execSync(`git add "${backupFileName}"`, { cwd: tempGitDir, stdio: 'pipe' });
            console.log('[备份] 文件已添加到 Git');

            sendProgress('正在提交更改...', 75);
            const commitMessage = `Backup for ${userHandle} at ${new Date().toISOString()}`;
            console.log(`[备份] 提交更改: ${commitMessage}`);
            try {
                const commitOutput = execSync(`git commit -m "${commitMessage}"`, { cwd: tempGitDir, stdio: 'pipe', encoding: 'utf8' });
                console.log('[备份] 提交输出:', commitOutput);
            } catch (commitErr) {
                // 检查是否没有变化需要提交
                const statusOutput = execSync('git status --porcelain', { cwd: tempGitDir, encoding: 'utf8' });
                if (!statusOutput.trim()) {
                    console.log('[备份] 没有变化需要提交，跳过');
                } else {
                    console.error('[备份] 提交失败:', commitErr.message);
                    if (commitErr.stderr) console.error('[备份] 提交 stderr:', commitErr.stderr);
                    throw commitErr;
                }
            }

            sendProgress(`正在推送 ${fileSize} MB 到远程仓库...（可能需要较长时间）`, 80);

            // 检测当前分支名（Hugging Face 默认 main，魔搭社区默认 master）
            let currentBranch = 'master';
            try {
                currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tempGitDir, encoding: 'utf8' }).trim();
                console.log(`[备份] 当前分支: ${currentBranch}`);
            } catch (branchErr) {
                console.error('[备份] 获取分支名失败，使用默认 master:', branchErr.message);
            }

            // 使用 spawn 来实时捕获 git push 输出，避免阻塞
            console.log('[备份] 开始推送到远程仓库...');
            await new Promise((resolve, reject) => {
                const gitPush = spawn('git', ['push', 'origin', currentBranch], {
                    cwd: tempGitDir,
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                let lastProgress = 80;
                let stdoutData = '';
                let stderrData = '';

                // 捕获 stdout
                gitPush.stdout.on('data', (data) => {
                    const output = data.toString();
                    stdoutData += output;
                    console.log('[备份] git push stdout:', output.trim());
                });

                // Git LFS 的进度信息通常在 stderr
                gitPush.stderr.on('data', (data) => {
                    const output = data.toString();
                    stderrData += output;
                    console.log('[备份] git push stderr:', output.trim());

                    // 解析 Git LFS 上传进度
                    // 格式类似: "Uploading LFS objects:  50% (1/2), 10 MB | 1.2 MB/s"
                    const progressMatch = output.match(/(\d+)%/);
                    if (progressMatch) {
                        const percent = parseInt(progressMatch[1]);
                        // 将 0-100% 映射到 80-95%
                        const mappedProgress = 80 + Math.floor(percent * 0.15);
                        if (mappedProgress > lastProgress) {
                            lastProgress = mappedProgress;
                            sendProgress(`正在推送到远程仓库... ${percent}%`, mappedProgress);
                        }
                    }
                });

                gitPush.on('close', (code) => {
                    console.log('[备份] git push 退出码:', code);
                    if (code === 0) {
                        console.log('[备份] 推送成功');
                        resolve();
                    } else {
                        console.error('[备份] git push 失败');
                        console.error('[备份] stdout:', stdoutData);
                        console.error('[备份] stderr:', stderrData);
                        reject(new Error(`git push 失败，退出码: ${code}\nstderr: ${stderrData}`));
                    }
                });

                gitPush.on('error', (err) => {
                    console.error('[备份] git push 进程错误:', err);
                    reject(err);
                });
            });

            sendProgress('推送完成，正在清理临时文件...', 95);

            // 清理临时文件
            fs.unlinkSync(tempZipPath);
            fs.rmSync(tempGitDir, { recursive: true, force: true });

            clearTimeout(timeoutId);
            sendComplete(true, '备份成功！', {
                filename: backupFileName,
                size: fileSize + ' MB'
            });

        } catch (gitErr) {
            console.error('[备份] Git 操作失败:', gitErr.message);

            // 清理临时文件
            if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
            if (fs.existsSync(tempGitDir)) fs.rmSync(tempGitDir, { recursive: true, force: true });

            clearTimeout(timeoutId);
            sendComplete(false, 'Git 操作失败：' + gitErr.message + '。请确保已安装 Git 和 Git LFS，且数据集存在并有写入权限。');
        }

        } catch (err) {
            console.error('[备份] 错误:', err);
            clearTimeout(timeoutId);
            sendComplete(false, '备份失败：' + err.message);
        }
    });
});

// 从魔搭社区恢复数据（使用 Git LFS）
app.post('/api/restore', jsonParser, async (req, res) => {
    // 设置 SSE 响应头，用于实时推送进度
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function sendProgress(message, progress = null) {
        const data = { message, progress };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    function sendComplete(success, message, data = {}) {
        const result = { success, message, ...data };
        res.write(`data: ${JSON.stringify(result)}\n\n`);
        res.end();
    }

    // 检查队列状态
    const queueStatus = restoreQueue.getStatus();
    if (queueStatus.queued > 0) {
        sendProgress(`当前有 ${queueStatus.running} 个恢复任务正在进行，您的任务排在第 ${queueStatus.queued + 1} 位...`, 0);
    }

    // 添加到任务队列
    await restoreQueue.add(async () => {
        // 设置超时保护
        const timeoutId = setTimeout(() => {
            sendComplete(false, `恢复超时（超过 ${BACKUP_CONFIG.TIMEOUT_MS / 60000} 分钟），已自动取消`);
        }, BACKUP_CONFIG.TIMEOUT_MS);

        try {
        const { platform, token, dataset, userHandle, webdavUrl, webdavUsername, webdavPassword, restoreFileName } = req.body;

        if (!platform || !userHandle) {
            clearTimeout(timeoutId);
            return sendComplete(false, '缺少必要参数');
        }

        // 验证平台
        if (platform !== 'modelscope' && platform !== 'huggingface' && platform !== 'webdav') {
            clearTimeout(timeoutId);
            return sendComplete(false, '不支持的备份平台');
        }

        // WebDAV 的凭证校验
        if (platform === 'webdav' && (!webdavUrl || !webdavUsername || !webdavPassword)) {
            clearTimeout(timeoutId);
            return sendComplete(false, '缺少 WebDAV 配置（URL / 用户名 / 密码）');
        }

        // Git 类平台需要 token 和 dataset
        if (platform !== 'webdav' && (!token || !dataset)) {
            clearTimeout(timeoutId);
            return sendComplete(false, '缺少必要参数（Token 或数据集名称）');
        }

        const timestamp = Date.now();
        const userDataDir = path.join(DATA_ROOT, userHandle);
        // 默认恢复自己的备份文件 backup-<handle>.zip；若用户指定了文件名/路径则用指定的，
        // 以便恢复从别的账号/别处备份过来的文件（避免账号 handle 对不上找不到文件）。
        // 只取文件名部分（basename）防止路径穿越；用户填 "a/b/backup.zip" 也只用 "backup.zip"。
        let backupFileName = `backup-${userHandle}.zip`;
        if (restoreFileName && String(restoreFileName).trim()) {
            let name = String(restoreFileName).trim().replace(/\\/g, '/');
            name = name.substring(name.lastIndexOf('/') + 1); // basename
            if (name) {
                if (!/\.zip$/i.test(name)) name += '.zip'; // 自动补 .zip 后缀
                backupFileName = name;
            }
        }

        // ── WebDAV 分支：直接 HTTP GET 下载 zip，无需 Git ──
        let backupFilePath;     // 解压前 zip 文件所在路径
        let fileSize = '';     // "XX MB"
        let tempCleanupDir;    // 用完后需清理的临时目录（WebDAV 用它，Git 用 tempGitDir）
        let fileSizeRaw = 0;   // 字节

        if (platform === 'webdav') {
            try {
                const auth = { username: webdavUsername, password: webdavPassword };
                const tempDir = path.join(getTempDir(), `webdav-restore-${userHandle}-${timestamp}`);
                fs.mkdirSync(tempDir, { recursive: true });
                tempCleanupDir = tempDir;
                backupFilePath = path.join(tempDir, backupFileName);

                // 先探测文件是否存在（HEAD 请求）
                sendProgress('正在连接 WebDAV 服务器...', 5);
                try {
                    const targetUrl = webdavUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(backupFileName);
                    await webdavRequest(targetUrl, 'HEAD', null, auth);
                } catch (headErr) {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    clearTimeout(timeoutId);
                    return sendComplete(false, 'WebDAV 连接失败或文件不存在：' + headErr.message);
                }

                sendProgress('正在从 WebDAV 下载备份文件...（可能需要几分钟）', 10);
                const result = await webdavDownload(backupFileName, webdavUrl, auth, backupFilePath);
                fileSize = result.size + ' MB';
                fileSizeRaw = fs.statSync(backupFilePath).size;
                sendProgress(`下载完成，文件大小：${fileSize}`, 60);
            } catch (webdavErr) {
                console.error('[WebDAV恢复] 错误:', webdavErr.message);
                if (tempCleanupDir && fs.existsSync(tempCleanupDir)) {
                    fs.rmSync(tempCleanupDir, { recursive: true, force: true });
                }
                clearTimeout(timeoutId);
                return sendComplete(false, 'WebDAV 恢复失败：' + webdavErr.message + '\n请检查 URL、用户名、密码和备份文件是否存在。');
            }
        } else {
            // ── Git 类分支：魔搭社区 / Hugging Face ──
            // 解析数据集名称
            const [namespace, datasetName] = dataset.split('/');
            if (!namespace || !datasetName) {
                clearTimeout(timeoutId);
                return sendComplete(false, '数据集名称格式错误，应为：用户名/数据集名称');
            }

            // 创建临时目录用于 Git 操作
            sendProgress('正在准备恢复...', 5);
            const tempGitDir = path.join(getTempDir(), `git-restore-${userHandle}-${timestamp}`);
            fs.mkdirSync(tempGitDir, { recursive: true });
            tempCleanupDir = tempGitDir;

            try {
                // 根据平台构建仓库 URL
                let repoUrl;
                const platformName = platform === 'modelscope' ? '魔搭社区' : 'Hugging Face';
                if (platform === 'modelscope') {
                    repoUrl = `https://oauth2:${token}@www.modelscope.cn/datasets/${namespace}/${datasetName}.git`;
                } else if (platform === 'huggingface') {
                    repoUrl = `https://user:${token}@huggingface.co/datasets/${namespace}/${datasetName}`;
                }

                sendProgress(`正在连接${platformName}...`, 10);

                try {
                    execSync(`git clone "${repoUrl}" "${tempGitDir}"`, {
                        stdio: 'pipe',
                        encoding: 'utf8'
                    });
                    sendProgress('克隆完成', 30);
                } catch (cloneErr) {
                    console.error('[恢复] 克隆失败:', cloneErr.message);
                    throw new Error('克隆仓库失败：' + cloneErr.message);
                }

                // 配置 Git LFS
                sendProgress('正在配置 Git LFS...', 35);
                try {
                    execSync('git lfs install', { cwd: tempGitDir, stdio: 'pipe' });
                } catch (lfsErr) {
                    console.error('[恢复] Git LFS 安装失败:', lfsErr.message);
                    throw new Error('Git LFS 未安装或配置失败');
                }

                // 拉取 LFS 文件
                sendProgress('正在下载备份文件...（可能需要较长时间）', 40);

                // 使用 spawn 来实时捕获 git lfs pull 输出
                await new Promise((resolve, reject) => {
                    const gitLfsPull = spawn('git', ['lfs', 'pull'], {
                        cwd: tempGitDir,
                        stdio: ['ignore', 'pipe', 'pipe']
                    });

                    let lastProgress = 40;

                    gitLfsPull.stderr.on('data', (data) => {
                        const output = data.toString();

                        // 解析 Git LFS 下载进度
                        const progressMatch = output.match(/(\d+)%/);
                        if (progressMatch) {
                            const percent = parseInt(progressMatch[1]);
                            // 将 0-100% 映射到 40-60%
                            const mappedProgress = 40 + Math.floor(percent * 0.20);
                            if (mappedProgress > lastProgress) {
                                lastProgress = mappedProgress;
                                sendProgress(`正在下载备份文件... ${percent}%`, mappedProgress);
                            }
                        }
                    });

                    gitLfsPull.on('close', (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`git lfs pull 失败，退出码: ${code}`));
                        }
                    });

                    gitLfsPull.on('error', (err) => {
                        console.error('[恢复] git lfs pull 进程错误:', err);
                        reject(err);
                    });
                });

                sendProgress('下载完成', 60);

                // 查找备份文件
                backupFilePath = path.join(tempGitDir, backupFileName);
                console.log(`[恢复] 查找备份文件: ${backupFileName}`);

                if (!fs.existsSync(backupFilePath)) {
                    console.error(`[恢复] 未找到备份文件: ${backupFilePath}`);
                    fs.rmSync(tempGitDir, { recursive: true, force: true });
                    return sendComplete(false, `未找到备份文件: ${backupFileName}`);
                }

                fileSizeRaw = fs.statSync(backupFilePath).size;
                fileSize = (fileSizeRaw / 1024 / 1024).toFixed(2);
                sendProgress(`找到备份文件，大小：${fileSize} MB`, 65);
                console.log(`[恢复] 找到备份文件: ${backupFileName} (${fileSize} MB)`);

            // 备份当前数据（以防恢复失败）
            sendProgress('正在备份当前数据...', 70);
            const backupDir = path.join(getTempDir(), `backup-before-restore-${userHandle}-${timestamp}`);
            console.log(`[恢复] 备份当前数据到: ${backupDir}`);
            if (fs.existsSync(userDataDir)) {
                fs.cpSync(userDataDir, backupDir, { recursive: true });
                console.log('[恢复] 当前数据备份完成');
            } else {
                console.log('[恢复] 当前数据目录不存在，跳过备份');
            }

            try {
                // 清空当前数据目录
                sendProgress('正在清空当前数据...', 75);
                console.log(`[恢复] 清空当前数据目录: ${userDataDir}`);
                if (fs.existsSync(userDataDir)) {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
                fs.mkdirSync(userDataDir, { recursive: true });
                console.log('[恢复] 数据目录已清空');

                // 解压恢复数据
                sendProgress('正在解压备份文件...', 80);
                console.log(`[恢复] 解压备份文件到: ${userDataDir}`);
                await extract(backupFilePath, { dir: userDataDir });
                console.log('[恢复] 解压完成');

                sendProgress('解压完成，正在清理临时文件...', 95);

                // 清理临时文件
                console.log('[恢复] 清理临时文件...');
                if (tempCleanupDir && fs.existsSync(tempCleanupDir)) {
                    fs.rmSync(tempCleanupDir, { recursive: true, force: true });
                }
                if (fs.existsSync(backupDir)) {
                    fs.rmSync(backupDir, { recursive: true, force: true });
                }
                console.log('[恢复] 临时文件清理完成');

                clearTimeout(timeoutId);
                console.log('[恢复] 恢复成功！');
                sendComplete(true, '恢复成功！', {
                    filename: backupFileName,
                    size: fileSize + ' MB'
                });

            } catch (extractErr) {
                // 恢复失败，回滚到备份
                console.error('[恢复] 解压失败，正在回滚:', extractErr);
                if (fs.existsSync(userDataDir)) {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
                if (fs.existsSync(backupDir)) {
                    fs.cpSync(backupDir, userDataDir, { recursive: true });
                    fs.rmSync(backupDir, { recursive: true, force: true });
                }
                if (tempCleanupDir && fs.existsSync(tempCleanupDir)) {
                    fs.rmSync(tempCleanupDir, { recursive: true, force: true });
                }
                throw extractErr;
            }

            } catch (gitErr) {
                console.error('[恢复] Git 操作失败:', gitErr.message);

                // 清理临时文件
                if (tempCleanupDir && fs.existsSync(tempCleanupDir)) {
                    fs.rmSync(tempCleanupDir, { recursive: true, force: true });
                }

                clearTimeout(timeoutId);
                sendComplete(false, 'Git 操作失败：' + gitErr.message + '。请确保已安装 Git 和 Git LFS，且数据集存在并有读取权限。');
            }
            } // else (Git flow)

        } catch (err) {
            console.error('[恢复] 错误:', err);
            clearTimeout(timeoutId);
            sendComplete(false, '恢复失败：' + err.message);
        }
    });
});

// 配置 multer 用于文件上传
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, getTempDir());
        },
        filename: (req, file, cb) => {
            const timestamp = Date.now();
            cb(null, `upload-${timestamp}-${file.originalname}`);
        }
    }),
    limits: {
        fileSize: BACKUP_CONFIG.MAX_SIZE_MB * 1024 * 1024 // 使用相同的大小限制
    },
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('只支持 .zip 格式的备份文件'));
        }
    }
});

// 恢复本地备份
app.post('/api/restore-local', upload.single('file'), async (req, res) => {
    // 设置 SSE 响应头，用于实时推送进度
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function sendProgress(message, progress = null) {
        const data = { message, progress };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    function sendComplete(success, message, data = {}) {
        const result = { success, message, ...data };
        res.write(`data: ${JSON.stringify(result)}\n\n`);
        res.end();
    }

    // 检查队列状态
    const queueStatus = restoreQueue.getStatus();
    if (queueStatus.queued > 0) {
        sendProgress(`当前有 ${queueStatus.running} 个恢复任务正在进行，您的任务排在第 ${queueStatus.queued + 1} 位...`, 0);
    }

    // 添加到任务队列
    await restoreQueue.add(async () => {
        // 设置超时保护
        const timeoutId = setTimeout(() => {
            sendComplete(false, `恢复超时（超过 ${BACKUP_CONFIG.TIMEOUT_MS / 60000} 分钟），已自动取消`);
        }, BACKUP_CONFIG.TIMEOUT_MS);

        let uploadedFilePath = null;

        try {
            const { userHandle } = req.body;

            if (!userHandle) {
                clearTimeout(timeoutId);
                return sendComplete(false, '缺少必要参数');
            }

            if (!req.file) {
                clearTimeout(timeoutId);
                return sendComplete(false, '未上传备份文件');
            }

            uploadedFilePath = req.file.path;
            const fileSize = (req.file.size / 1024 / 1024).toFixed(2);

            sendProgress('正在准备恢复...', 5);
            sendProgress(`已上传备份文件，大小：${fileSize} MB`, 10);

            const userDataDir = path.join(DATA_ROOT, userHandle);
            const timestamp = Date.now();

            // 备份当前数据（以防恢复失败）
            sendProgress('正在备份当前数据...', 20);
            const backupDir = path.join(getTempDir(), `backup-before-restore-${userHandle}-${timestamp}`);
            if (fs.existsSync(userDataDir)) {
                fs.cpSync(userDataDir, backupDir, { recursive: true });
            }

            try {
                // 清空当前数据目录
                sendProgress('正在清空当前数据...', 40);
                if (fs.existsSync(userDataDir)) {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
                fs.mkdirSync(userDataDir, { recursive: true });

                // 解压恢复数据
                sendProgress('正在解压备份文件...', 60);
                await extract(uploadedFilePath, { dir: userDataDir });

                sendProgress('解压完成，正在清理临时文件...', 90);

                // 清理临时文件
                if (fs.existsSync(uploadedFilePath)) {
                    fs.unlinkSync(uploadedFilePath);
                }
                if (fs.existsSync(backupDir)) {
                    fs.rmSync(backupDir, { recursive: true, force: true });
                }

                clearTimeout(timeoutId);
                sendComplete(true, '本地备份恢复成功！', {
                    filename: req.file.originalname,
                    size: fileSize + ' MB'
                });

            } catch (extractErr) {
                // 恢复失败，回滚到备份
                console.error('[恢复本地] 解压失败，正在回滚:', extractErr);
                if (fs.existsSync(userDataDir)) {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
                if (fs.existsSync(backupDir)) {
                    fs.cpSync(backupDir, userDataDir, { recursive: true });
                    fs.rmSync(backupDir, { recursive: true, force: true });
                }
                if (fs.existsSync(uploadedFilePath)) {
                    fs.unlinkSync(uploadedFilePath);
                }
                throw extractErr;
            }

        } catch (err) {
            console.error('[恢复本地] 错误:', err);

            // 清理上传的文件
            if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
                fs.unlinkSync(uploadedFilePath);
            }

            clearTimeout(timeoutId);
            sendComplete(false, '恢复失败：' + err.message);
        }
    });
});

// 获取当前登录用户的 handle（从 cookie 中解析）
async function getCurrentUserHandle(req) {
    try {
        // 从 cookie 中获取 session
        const cookies = req.headers.cookie;
        if (!cookies) {
            console.log('[getCurrentUserHandle] 没有 cookie');
            return null;
        }

        // 解析 connect.sid cookie
        const sidMatch = cookies.match(/connect\.sid=([^;]+)/);
        if (!sidMatch) {
            console.log('[getCurrentUserHandle] 没有找到 session cookie');
            return null;
        }

        // 从 node-persist 存储中查找所有用户，检查哪个用户当前登录
        // 这是一个简化的方法，实际上 SillyTavern 的 session 存储在内存中
        // 我们需要另一种方法

        // 更简单的方法：让前端传递用户名
        console.log('[getCurrentUserHandle] 无法从 cookie 解析用户，需要前端传递');
        return null;
    } catch (err) {
        console.error('[getCurrentUserHandle] 异常:', err.message);
        return null;
    }
}

// ─── Admin backend ────────────────────────────────────────────────────────────

// 挂载后台管理（/admin 与 /admin/api/*）。必须在反向代理兜底之前，
// 这样这些路由不会被转发给 SillyTavern。复用本文件已实现的用户操作函数。
mountAdmin(app, {
    storage, KEY_PREFIX, toKey, slugify,
    getPasswordSalt, getPasswordHash,
    getUserDirectories, createUserDirectories, seedDefaultContent,
    DATA_ROOT, ST_HOST, ST_PORT,
    adminConfig: ADMIN_CONFIG,
    site: SITE, saveSiteConfig,
    announce: ANNOUNCE, saveAnnounceConfig,
    registration: REGISTRATION, saveRegistrationConfig, countUsers,
    background: BACKGROUND, saveBackgroundConfig,
    card: CARD, saveCardConfig,
    friendLinks: FRIEND_LINKS, saveFriendLinksConfig,
    backupTempConfig: BACKUP_TEMP_CONFIG, saveBackupConfig, getTempDir,
    sillyTavernConfig: { path: stPath }, saveSillyTavernConfig, ST_DIR,
    ST_CONFIG_PATH, readSillyTavernSettings, saveSillyTavernSettings,
    mdRendererJs: MD_RENDERER_JS,
});

// ─── Reverse proxy to SillyTavern ─────────────────────────────────────────────

// SillyTavern 占据根路径 / 及所有未被自有页面占用的路径，由根路由+兜底代理转发。
// 使用 Node 内置 http 模块，零额外依赖，逐字节透传（支持 SSE 流式响应）。
// 对 SillyTavern 返回的 HTML 文档，会把标题/品牌名替换为站点标题（不改 ST 文件）。

// 复用到 SillyTavern 的 TCP 连接（keepAlive），降低高并发下的连接开销。
const proxyAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 256,
    maxFreeSockets: 64,
});

// 根路径：未登录跳登录页，已登录直接代理到 SillyTavern 根路径
app.get('/', (req, res) => {
    if (!isLoggedIn(req)) return res.redirect('/login');
    proxyToST(req, res, '/');
});

// 代理函数：转发请求到 SillyTavern
function proxyToST(req, res, targetPath) {
    // 是否需要改写响应（替换标题 / 注入公告）。仅在确有需要时才关压缩 + 缓冲，
    // 否则完全透传（保留 SillyTavern 的 gzip，前端 bundle 不被放大）。
    // 关键：只对「顶层页面导航」做改写，绝不碰 fetch 加载的 HTML 模板片段。
    const wantRewrite = (SITE.title && SITE.title !== 'SillyTavern')
        || (ANNOUNCE.enabled && ANNOUNCE.content);
    const mayRewrite = wantRewrite && isTopLevelDocument(req);

    const reqHeaders = { ...req.headers, host: `${ST_HOST}:${ST_PORT}` };
    // 反向代理在 SillyTavern 之前：本服务始终从 127.0.0.1 连接 SillyTavern，而 SillyTavern
    // 默认开了 whitelistMode + enableForwardedWhitelist。若把公网入口/隧道加的客户端 IP 转发头
    // 原样透传给 SillyTavern，它会拿真实公网 IP 去比对白名单 [127.0.0.1,::1] → 判定不在白名单
    // → 403，导致经本服务访问 SillyTavern 全部被拦。这里剥离这些头，让 SillyTavern 只看到可信
    // 的本地连接。（如需在 SillyTavern 侧按真实 IP 限流，可在其 config 关掉转发白名单后另行处理。）
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
        'x-forwarded-port', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'forwarded']) {
        delete reqHeaders[h];
    }
    // 只有可能改写时才关压缩（只影响那一次顶层页面请求，不影响 JS/CSS/API/片段）。
    if (mayRewrite) {
        reqHeaders['accept-encoding'] = 'identity';
    }

    const options = {
        host: ST_HOST,
        port: ST_PORT,
        method: req.method,
        path: targetPath,
        headers: reqHeaders,
        agent: proxyAgent,
    };

    const proxyReq = http.request(options, (proxyRes) => {
        // 修正可能指向内部地址的重定向，改为同源相对路径。
        // SillyTavern 现在运行在根路径，无需再加 /st 前缀。
        const location = proxyRes.headers['location'];
        if (location) {
            proxyRes.headers['location'] = location
                .replace(`http://${ST_HOST}:${ST_PORT}`, '')
                .replace(`http://localhost:${ST_PORT}`, '');
        }

        const contentType = String(proxyRes.headers['content-type'] || '');
        const isHtml = contentType.includes('text/html');
        // 仅当确需改写、响应是未压缩 HTML 时才缓冲改写；其余原样透传。
        const isPlain = !proxyRes.headers['content-encoding'];

        if (mayRewrite && isHtml && isPlain) {
            const chunks = [];
            proxyRes.on('data', (c) => chunks.push(c));
            proxyRes.on('end', () => {
                const html = rebrandHtml(Buffer.concat(chunks).toString('utf8'));
                const body = Buffer.from(html, 'utf8');
                const headers = { ...proxyRes.headers };
                // 我们重发的是定长 body：删掉分块/旧长度/压缩标记，避免破坏响应框架
                // （否则浏览器可能丢弃这次响应里的 Set-Cookie，导致 session/CSRF 失配）。
                delete headers['content-length'];
                delete headers['content-encoding'];
                delete headers['transfer-encoding'];
                headers['content-length'] = body.length;
                // headers 里已含 set-cookie（数组），writeHead 会正确按多条输出。
                res.writeHead(proxyRes.statusCode || 502, headers);
                res.end(body);
            });
            proxyRes.on('error', () => { if (!res.headersSent) res.sendStatus(502); });
            return;
        }

        // 透传路径：proxyRes.headers 里的 set-cookie 数组会被 writeHead 正确处理。
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('[代理] 转发失败:', err.message);
        if (!res.headersSent) {
            res.status(502).send('SillyTavern 暂时不可用，请确认它已在内部端口启动。');
        }
    });

    // 透传请求体（注意：/register 不会走到这里，所以请求体未被消费）。
    req.pipe(proxyReq);
}

// 获取当前用户信息（必须在通用 /api 代理之前）。
// 不再代理到 SillyTavern 的 /api/users/me —— 在公网部署下，经反向代理转发的请求会因
// SillyTavern 的 IP 白名单 / 转发头校验 / cookie 签名等机制被判定未认证而返回 403。
// 这里改为：从 session cookie 本地解出登录 handle，再直接读取与 SillyTavern 共用的
// node-persist 用户存储，零代理、零额外请求，稳定可靠。
app.get('/api/current-user', async (req, res) => {
    try {
        const sess = getSTSession(req);
        const handle = (sess && typeof sess.handle === 'string') ? sess.handle : '';
        if (!handle) {
            return res.status(401).json({ error: '未登录' });
        }
        const user = await storage.getItem(toKey(handle));
        if (!user) {
            return res.status(404).json({ error: '用户不存在: ' + handle });
        }
        return res.json({
            handle: user.handle,
            name: user.name || user.handle,
            admin: !!user.admin,
            enabled: user.enabled !== false,
        });
    } catch (err) {
        console.error('[current-user] 读取用户信息失败:', err);
        return res.status(500).json({ error: '读取用户信息失败' });
    }
});

// 退出登录：直接在本服务端清掉 SillyTavern 的 session cookie。
// SillyTavern 用 cookie-session（整个会话就存在 cookie 里，服务端无会话存储），所以
// 把浏览器里的 session cookie 及其签名 cookie(.sig) 过期，就等于彻底登出 —— 无需把
// POST /api/users/logout 代理给 SillyTavern（公网部署下那条请求会因白名单/CSRF 被拒，
// 导致 cookie 没被清除，跳回 /login 又被 isLoggedIn 判为已登录而弹回 /st）。
app.post('/api/logout', (req, res) => {
    // 用与 SillyTavern 完全一致的属性把两个 cookie 立刻过期。
    // SillyTavern cookie-session 配置：sameSite=lax, httpOnly, path=/。
    const expire = (name) =>
        `${name}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
    res.setHeader('Set-Cookie', [
        expire(ST_SESSION_COOKIE_NAME),
        expire(ST_SESSION_COOKIE_NAME + '.sig'),
    ]);
    return res.json({ ok: true });
});

// 重置一切：删除当前用户在 SillyTavern 的全部数据，恢复到初始状态。
// 等价于 SillyTavern 账号设置里的「Reset Everything」，但按需求免去输入当前密码与重置码：
// 直接从 session cookie 解出 handle（已登录即可），删掉其数据根目录后重建目录并写入默认内容。
// 为体贴用户，会保留云端备份配置（token/数据集），重置后无需重新填写。
app.post('/api/reset-everything', async (req, res) => {
    try {
        const handle = currentHandle(req);
        if (!handle) return res.status(401).json({ error: '未登录' });
        const user = await storage.getItem(toKey(handle));
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const userRoot = getUserDirectories(handle).root;

        // 先把云端备份配置读出来，重置后再写回（避免用户重新配置 token/数据集）。
        let savedBackupCfg = null;
        const cfgFile = backupConfigPathFor(handle);
        try {
            if (fs.existsSync(cfgFile)) savedBackupCfg = fs.readFileSync(cfgFile, 'utf8');
        } catch { /* 读不到就算了 */ }

        // 删除该用户整个数据目录（角色、聊天、设置、世界书等全部清空）。
        fs.rmSync(userRoot, { recursive: true, force: true });

        // 重建目录结构并写入默认内容（settings、默认角色、主题、预设等），让酒馆能正常启动。
        createUserDirectories(handle);
        seedDefaultContent(handle);

        // 还原云端备份配置。
        if (savedBackupCfg !== null) {
            try {
                fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
                fs.writeFileSync(cfgFile, savedBackupCfg, 'utf8');
            } catch (e) {
                console.warn('[重置] 还原备份配置失败（可忽略）:', e.message);
            }
        }

        console.log('[重置] 已重置用户数据:', handle);
        return res.json({ ok: true });
    } catch (err) {
        console.error('[重置] 失败:', err);
        return res.status(500).json({ error: '重置失败: ' + err.message });
    }
});

// ─── 备份配置（按用户存到其数据目录，换设备/恢复后免重配）──────────────────────
// 存储位置：DATA_ROOT/<handle>/user/backup-config.json。放在 user/ 子目录下，会随
// 整包备份一起打包，恢复到新机器后配置自动还原。这里解出登录 handle，校验后读写该文件。
// token 等敏感信息只落在该用户自己的数据目录里（与 SillyTavern 存放用户私密数据同级）。

const BACKUP_CONFIG_FILENAME = 'backup-config.json';

// 解析当前登录用户的 handle；未登录返回 ''。
function currentHandle(req) {
    const sess = getSTSession(req);
    return (sess && typeof sess.handle === 'string') ? sess.handle : '';
}

// 取某用户的备份配置文件绝对路径（确保落在该用户的 user 目录内，防止路径穿越）。
function backupConfigPathFor(handle) {
    const userDir = path.join(DATA_ROOT, handle, 'user');
    return path.join(userDir, BACKUP_CONFIG_FILENAME);
}

// 允许保存的字段白名单（避免把任意内容写进文件）。
const BACKUP_CONFIG_KEYS = [
    'platform', 'modelScopeToken', 'modelScopeDataset',
    'huggingFaceToken', 'huggingFaceDataset', 'gitUserName', 'gitUserEmail',
    'webdavUrl', 'webdavUsername', 'webdavPassword',
];

// 读取当前用户的备份配置
app.get('/api/backup-config', async (req, res) => {
    try {
        const handle = currentHandle(req);
        if (!handle) return res.status(401).json({ error: '未登录' });
        const user = await storage.getItem(toKey(handle));
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const file = backupConfigPathFor(handle);
        if (!fs.existsSync(file)) {
            return res.json({}); // 还没配置过，返回空对象
        }
        let cfg = {};
        try {
            cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        } catch (e) {
            console.error('[备份配置] 解析失败，返回空配置:', e.message);
            return res.json({});
        }
        // 只回传白名单字段
        const out = {};
        for (const k of BACKUP_CONFIG_KEYS) {
            if (cfg[k] !== undefined) out[k] = cfg[k];
        }
        return res.json(out);
    } catch (err) {
        console.error('[备份配置] 读取失败:', err);
        return res.status(500).json({ error: '读取备份配置失败' });
    }
});

// 保存当前用户的备份配置（整体覆盖白名单字段）
app.put('/api/backup-config', jsonParser, async (req, res) => {
    try {
        const handle = currentHandle(req);
        if (!handle) return res.status(401).json({ error: '未登录' });
        const user = await storage.getItem(toKey(handle));
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const body = req.body || {};
        const cfg = {};
        for (const k of BACKUP_CONFIG_KEYS) {
            if (typeof body[k] === 'string') cfg[k] = body[k];
        }

        const file = backupConfigPathFor(handle);
        const dir = path.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
        return res.json({ ok: true });
    } catch (err) {
        console.error('[备份配置] 保存失败:', err);
        return res.status(500).json({ error: '保存备份配置失败' });
    }
});

// /api/* 路径代理到 SillyTavern（用于登录、用户信息等 API）
app.use('/api', (req, res) => {
    proxyToST(req, res, req.originalUrl);
});

// /csrf-token 代理到 SillyTavern
app.use('/csrf-token', (req, res) => {
    proxyToST(req, res, req.originalUrl);
});

// SillyTavern 的 session cookie 名 = session-<sha256(主机名)[:8]>（见其 getCookieSessionName）。
// register-server 与 SillyTavern 跑在同一台机器（ST_HOST 默认 127.0.0.1、且本服务直接读取
// SillyTavern 本地的 config.yaml），所以这里能算出与 SillyTavern 完全一致的当前 cookie 名。
// 关键：必须只认这个「当前名字」的 cookie，绝不能用宽松正则匹配任意 session-xxxxxxxx ——
// 否则浏览器里残留的「旧主机名/旧部署」遗留 cookie（仍带着 handle）会被误判为已登录，导致
// /login 一直跳 /st，而 SillyTavern 用的是另一个当前名字的匿名 cookie，于是把 /
// 又跳回 /login，形成死循环（本机干净所以本地不复现，公网/容器换过主机名就中招）。
const ST_SESSION_COOKIE_NAME = (() => {
    const hostname = os.hostname() || 'localhost';
    const suffix = crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 8);
    return `session-${suffix}`;
})();
console.log(`SillyTavern 会话 cookie 名: ${ST_SESSION_COOKIE_NAME}`);

// 从 Cookie 头里取出指定名字的 cookie 值（精确匹配名字，避开 .sig 等同前缀 cookie）。
function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            return part.slice(i + 1).trim();
        }
    }
    return null;
}

// 解码 SillyTavern 的 cookie-session（值为 base64(JSON)）。纯本地解析，不向 SillyTavern
// 发任何请求，不会污染 session / CSRF token。注意：不校验签名（.sig），仅用于「是否已登录」
// 的页面跳转判断；真正的鉴权由 SillyTavern 自己在各 API 上完成，伪造 cookie 过不了它的校验。
function getSTSession(req) {
    let val = readCookie(req, ST_SESSION_COOKIE_NAME);
    if (!val) return null;
    try { val = decodeURIComponent(val); } catch { /* 非编码值，原样使用 */ }
    try {
        const json = Buffer.from(val, 'base64').toString('utf8');
        const obj = JSON.parse(json);
        return (obj && typeof obj === 'object') ? obj : null;
    } catch {
        return null;
    }
}

// 是否「真正登录」：session 里带有非空的用户 handle（SillyTavern 登录后才会写入）。
// 仅有匿名会话（只含 csrfToken、没有 handle）不算登录 —— 修复「打开登录页就被当成
// 已登录而跳转 /st，结果加载不出用户信息」的问题。
function isLoggedIn(req) {
    const sess = getSTSession(req);
    return !!(sess && typeof sess.handle === 'string' && sess.handle.length > 0);
}

// SillyTavern 的静态资源路径（从根路径页面加载的资源）
const stStaticPaths = ['/lib/', '/scripts/', '/css/', '/assets/', '/characters/', '/backgrounds/', '/user/', '/thumbnails/', '/worlds/', '/groups/', '/chats/', '/themes/', '/extensions/', '/instruct/', '/context/', '/QuickReplies/', '/vectors/', '/backups/', '/sysprompt/', '/reasoning/', '/User Avatars/', '/NovelAI Settings/', '/KoboldAI Settings/', '/OpenAI Settings/', '/TextGen Settings/', '/movingUI/', '/default-content/', '/img/', '/sound/', '/fonts/'];

app.use((req, res, next) => {
    const path = req.path;

    // 检查是否是 SillyTavern 的静态资源路径
    const isSTStatic = stStaticPaths.some(prefix => path.startsWith(prefix));

    if (isSTStatic) {
        // 代理到 SillyTavern
        proxyToST(req, res, req.originalUrl);
    } else {
        next();
    }
});

// 兜底：区分「SillyTavern 的资源/接口请求」与「用户输错地址的顶层导航」。
// - SillyTavern 的 JS 会用 fetch/xhr 请求 /thumbnail、/version 等动态路径（非文档请求），
//   这些必须代理给 SillyTavern；
// - 用户在地址栏打开一个不存在的路径（顶层文档导航）则返回 Not Found，绝不再代理或跳转 ——
//   因为 SillyTavern 是单页应用，真正的页面只有根路径 `/`（已由 app.get('/') 处理），
//   其余顶层路径要么是我方自有页（已有显式路由），要么就是输错的地址。
app.use((req, res) => {
    const p = req.path;

    // 我方自有页面（及其子路径）：一律 Not Found，绝不代理给 SillyTavern。
    const isOwnPath =
        p === '/st' || p.startsWith('/st/') ||
        p.startsWith('/register') ||
        p.startsWith('/login') ||
        p.startsWith('/admin') ||
        p === '/stats' || p === '/server-info' || p === '/bg-info' ||
        p === '/friend-links' || p === '/bg';
    if (isOwnPath) {
        return res.status(404).type('html').send(buildNotFoundPage());
    }

    // SillyTavern 自身合法的顶层文档路径（如 OAuth PKCE 回调 /callback/<source>），
    // 仍需代理给它，不能当作输错地址 404。
    const isSTDocPath = p === '/callback' || p.startsWith('/callback/');

    // 顶层文档导航到未知路径 = 用户输错地址：返回 Not Found，不代理、不跳转。
    if (!isSTDocPath && isTopLevelDocument(req)) {
        return res.status(404).type('html').send(buildNotFoundPage());
    }

    // 其余（SillyTavern 的接口 / 静态资源 / fetch 请求）代理到 SillyTavern。
    proxyToST(req, res, req.originalUrl);
});

// 简单的 404 页面（用户输错地址时显示，带返回数据管理页 / 进入酒馆的入口）。
function buildNotFoundPage() {
    const title = escapeHtml(SITE.title || 'SillyTavern');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>404 Not Found — ${title}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0f1117;color:#e8eaf2;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}
  .box{text-align:center;padding:40px}
  .code{font-size:84px;font-weight:800;letter-spacing:2px;color:#00ccff;line-height:1;margin-bottom:8px}
  .msg{font-size:18px;color:#aeb4c2;margin-bottom:28px}
  .links{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  .links a{display:inline-block;padding:10px 18px;border-radius:10px;text-decoration:none;
    font-size:14px;border:1px solid rgba(255,255,255,.15);color:#e8eaf2;transition:background .15s}
  .links a:hover{background:rgba(255,255,255,.08)}
  .links a.primary{background:#00ccff;color:#06121a;border-color:#00ccff;font-weight:600}
</style>
</head>
<body>
  <div class="box">
    <div class="code">404</div>
    <div class="msg">页面不存在 · Not Found</div>
    <div class="links">
      <a class="primary" href="/st">返回数据管理</a>
      <a href="/">进入酒馆</a>
    </div>
  </div>
</body>
</html>`;
}

// 判断请求是否在请求一个 HTML 文档（用于决定是否需要关压缩做改写）。
function acceptsHtml(req) {
    // 只有 GET/HEAD 的导航请求才可能是页面文档
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const accept = String(req.headers['accept'] || '');
    return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

// 判断是否「顶层页面导航」请求（即用户在地址栏打开页面那一次）。
// 关键：只对这种请求做 HTML 改写，绝不碰 fetch/xhr 加载的 HTML 模板片段
// （角色卡片、扩展面板等），否则缓冲改写会破坏这些片段，导致界面数据加载不出。
// 用现代浏览器的 Sec-Fetch-* 头精确判断；老浏览器（无此头）回退到 acceptsHtml。
function isTopLevelDocument(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const dest = req.headers['sec-fetch-dest'];
    const mode = req.headers['sec-fetch-mode'];
    if (dest !== undefined || mode !== undefined) {
        // 浏览器明确告知意图：只有顶层文档导航才改写
        return dest === 'document' || mode === 'navigate';
    }
    // 回退：无 Sec-Fetch 头时用 Accept 粗判
    return acceptsHtml(req);
}

// 把 SillyTavern 页面里的标题/品牌名替换为站点标题，并按需注入公告脚本。
function rebrandHtml(html) {
    // 标题替换（仅当自定义了标题时）
    if (SITE.title && SITE.title !== 'SillyTavern') {
        const title = escapeHtml(SITE.title);
        html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
    }
    // 公告注入（仅在完整 HTML 文档的 </body> 前插入；找不到 </body> 就不注入，
    // 避免把脚本追加到 HTML 片段末尾而破坏页面）。
    if (ANNOUNCE.enabled && ANNOUNCE.content && html.includes('</body>')) {
        const snippet = getAnnouncementSnippet();
        html = html.replace('</body>', snippet + '</body>');
    }
    return html;
}

// 公告脚本只在配置变化时重建（含 SHA1 + JSON 编码），高并发下避免重复计算。
const getAnnouncementSnippet = makeVersionedCache(() => buildAnnouncementSnippet());

// 生成进入 SillyTavern 后弹出公告的内联脚本。
// 用内容哈希作为 id，once 模式下同一条公告只弹一次（记在 localStorage）。
function buildAnnouncementSnippet() {
    const id = crypto.createHash('sha1').update(ANNOUNCE.content).digest('hex').slice(0, 12);
    // 传给前端的数据用 JSON 安全编码，避免破坏脚本
    const data = JSON.stringify({
        id,
        content: ANNOUNCE.content,
        frequency: ANNOUNCE.frequency,
        title: SITE.title || 'SillyTavern',
    }).replace(/</g, '\\u003c');

    return `
<script>(function(){
  var A = ${data};
  try {
    var KEY = 'st_announce_seen';
    if (A.frequency === 'once' && localStorage.getItem(KEY) === A.id) return;
  } catch(e){}
${MD_RENDERER_JS}
  function show(){
    if (document.getElementById('st-announce-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'st-announce-mask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    var box = document.createElement('div');
    box.style.cssText = 'max-width:520px;width:90%;background:#16213e;color:#e8eaf2;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;';
    var h = document.createElement('div');
    h.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:14px;background:linear-gradient(135deg,#fff,#c3c9ff 55%,#ff7a92);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;';
    h.textContent = '📢 ' + (A.title || '公告');
    var body = document.createElement('div');
    body.className = 'st-md-body';
    body.style.cssText = 'font-size:14px;line-height:1.8;word-break:break-word;max-height:55vh;overflow:auto;color:#cfd3e6;';
    body.innerHTML = stRenderMarkdown(A.content);
    var btn = document.createElement('button');
    btn.textContent = '我知道了';
    btn.style.cssText = 'margin-top:22px;width:100%;padding:12px;border:none;border-radius:11px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#e94560);';
    btn.onclick = function(){
      try { localStorage.setItem('st_announce_seen', A.id); } catch(e){}
      mask.remove();
    };
    var style = document.createElement('style');
    style.textContent = stMarkdownCss();
    box.appendChild(style); box.appendChild(h); box.appendChild(body); box.appendChild(btn); mask.appendChild(box);
    document.body.appendChild(mask);
  }
  // 等页面就绪后再弹，避免与 SillyTavern 启动竞争
  function ready(){ setTimeout(show, 1200); }
  if (document.readyState === 'complete' || document.readyState === 'interactive') ready();
  else window.addEventListener('DOMContentLoaded', ready);
})();</script>`;
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function main() {
    // Initialize node-persist storage (same as SillyTavern's initUserStorage)
    await storage.init({
        dir: STORAGE_DIR,
        ttl: false,         // Never expire
        expiredInterval: 0,
    });
    console.log(`存储已初始化: ${STORAGE_DIR}`);

    // List existing users
    const existingKeys = await storage.keys(x => x.key.startsWith(KEY_PREFIX));
    const existingHandles = existingKeys.map(k => k.replace(KEY_PREFIX, ''));
    console.log(`已有用户 (${existingHandles.length}): ${existingHandles.join(', ') || '(无)'}`);

    // 清理旧的临时文件
    console.log(`临时文件目录: ${getTempDir()}`);
    cleanupOldTempFiles();

    // 异步获取服务器公网 IP/地区（不阻塞启动）
    fetchServerInfo();

    // 用 http.Server 包裹 express，以便处理 WebSocket upgrade 请求。
    const server = http.createServer(app);

    // 转发 WebSocket 升级请求（若 SillyTavern 用到的话）。
    server.on('upgrade', (req, socket, head) => {
        const options = {
            host: ST_HOST,
            port: ST_PORT,
            method: req.method,
            path: req.url,
            headers: req.headers,
        };
        const proxyReq = http.request(options);
        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
            const headers = Object.entries(proxyRes.headers)
                .map(([k, v]) => `${k}: ${v}`).join('\r\n');
            socket.write(
                `HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`,
            );
            if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
            proxySocket.pipe(socket);
            socket.pipe(proxySocket);
            proxySocket.on('error', () => socket.destroy());
            socket.on('error', () => proxySocket.destroy());
        });
        proxyReq.on('error', () => socket.destroy());
        if (head && head.length) proxyReq.write(head);
        proxyReq.end();
    });

    server.listen(PUBLIC_PORT, () => {
        console.log('');
        console.log('══════════════════════════════════════════════════');
        console.log(`  对外服务运行在端口 ${PUBLIC_PORT}`);
        console.log(`  注册页面: http://localhost:${PUBLIC_PORT}/register`);
        console.log(`  登录/使用: http://localhost:${PUBLIC_PORT}/`);
        console.log(`  后台管理: http://localhost:${PUBLIC_PORT}/admin`);
        console.log(`  （内部转发至 SillyTavern http://${ST_HOST}:${ST_PORT}）`);
        console.log('══════════════════════════════════════════════════');
    });
}

main().catch(err => {
    console.error('启动注册服务器失败:', err);
    process.exit(1);
});
