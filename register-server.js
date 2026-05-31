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
const ST_DIR = path.join(__dirname, '..', 'SillyTavern');
const ST_CONFIG_PATH = path.join(ST_DIR, 'config.yaml');
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

// 读取 SillyTavern 的配置（仅用于定位数据目录与内部端口，只读不改）
let stConfig;
try {
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
                window.location.href = '/dashboard';
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
      window.location.href = '/dashboard';
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
            padding: 46px 42px;
            width: 100%;
            max-width: 600px;
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
    </style>
</head>
<body>
    <div class="container">
        ${brand}
        <h1>数据管理中心</h1>
        <p class="subtitle">备份和恢复您的 SillyTavern 数据</p>

        <div class="user-info" id="userInfo">
            <div><span class="label">当前用户：</span><span class="value" id="userName">加载中...</span></div>
            <div><span class="label">登录账号：</span><span class="value" id="userHandle">加载中...</span></div>
        </div>

        <div class="message" id="message"></div>

        <div class="progress-container" id="progressContainer">
            <div class="progress-bar">
                <div class="progress-fill" id="progressFill"></div>
            </div>
            <div class="progress-text" id="progressText">准备中...</div>
        </div>

        <div class="section">
            <div class="section-title">备份平台选择</div>
            <div class="config-section">
                <label for="backupPlatform">选择备份平台</label>
                <select id="backupPlatform">
                    <option value="modelscope">魔搭社区 (ModelScope)</option>
                    <option value="huggingface">Hugging Face</option>
                </select>
            </div>
        </div>

        <div class="section" id="modelScopeConfig">
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

        <div class="section" id="huggingFaceConfig" style="display:none;">
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

        <div class="section">
            <div class="section-title">数据操作</div>
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

        <div class="section">
            <div class="section-title">本地备份管理</div>
            <div class="config-section">
                <label for="localBackupFile">上传本地备份文件</label>
                <input type="file" id="localBackupFile" accept=".zip" style="display:none;">
                <button class="btn-secondary" id="uploadBackupBtn" style="width:100%;margin-bottom:12px;">
                    📁 选择备份文件
                </button>
                <div class="hint" id="uploadHint">支持 .zip 格式的备份文件</div>
                <button class="btn-primary" id="restoreLocalBtn" style="width:100%;display:none;">
                    <span class="spinner" id="restoreLocalSpinner"></span>
                    恢复本地备份
                </button>
            </div>
        </div>

        <div class="section">
            <button class="btn-enter" id="enterBtn">
                🏰 进入酒馆
            </button>
        </div>

        <div class="logout-link">
            <a id="logoutLink">退出登录</a>
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
        const modelScopeTokenInput = document.getElementById('modelScopeToken');
        const modelScopeDatasetInput = document.getElementById('modelScopeDataset');
        const huggingFaceTokenInput = document.getElementById('huggingFaceToken');
        const huggingFaceDatasetInput = document.getElementById('huggingFaceDataset');
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

        // 从 localStorage 加载配置
        const savedPlatform = localStorage.getItem('backupPlatform') || 'modelscope';
        const savedModelScopeToken = localStorage.getItem('modelScopeToken');
        const savedModelScopeDataset = localStorage.getItem('modelScopeDataset');
        const savedHuggingFaceToken = localStorage.getItem('huggingFaceToken');
        const savedHuggingFaceDataset = localStorage.getItem('huggingFaceDataset');

        platformSelect.value = savedPlatform;
        if (savedModelScopeToken) modelScopeTokenInput.value = savedModelScopeToken;
        if (savedModelScopeDataset) modelScopeDatasetInput.value = savedModelScopeDataset;
        if (savedHuggingFaceToken) huggingFaceTokenInput.value = savedHuggingFaceToken;
        if (savedHuggingFaceDataset) huggingFaceDatasetInput.value = savedHuggingFaceDataset;

        // 平台切换
        function switchPlatform() {
            const platform = platformSelect.value;
            localStorage.setItem('backupPlatform', platform);

            if (platform === 'modelscope') {
                modelScopeConfig.style.display = 'block';
                huggingFaceConfig.style.display = 'none';
            } else if (platform === 'huggingface') {
                modelScopeConfig.style.display = 'none';
                huggingFaceConfig.style.display = 'block';
            }
        }

        platformSelect.addEventListener('change', switchPlatform);
        switchPlatform(); // 初始化显示

        // 保存配置到 localStorage（使用 input 事件实时保存）
        modelScopeTokenInput.addEventListener('input', () => {
            localStorage.setItem('modelScopeToken', modelScopeTokenInput.value.trim());
        });
        modelScopeTokenInput.addEventListener('blur', () => {
            localStorage.setItem('modelScopeToken', modelScopeTokenInput.value.trim());
        });
        modelScopeDatasetInput.addEventListener('input', () => {
            localStorage.setItem('modelScopeDataset', modelScopeDatasetInput.value.trim());
        });
        modelScopeDatasetInput.addEventListener('blur', () => {
            localStorage.setItem('modelScopeDataset', modelScopeDatasetInput.value.trim());
        });

        huggingFaceTokenInput.addEventListener('input', () => {
            localStorage.setItem('huggingFaceToken', huggingFaceTokenInput.value.trim());
        });
        huggingFaceTokenInput.addEventListener('blur', () => {
            localStorage.setItem('huggingFaceToken', huggingFaceTokenInput.value.trim());
        });
        huggingFaceDatasetInput.addEventListener('input', () => {
            localStorage.setItem('huggingFaceDataset', huggingFaceDatasetInput.value.trim());
        });
        huggingFaceDatasetInput.addEventListener('blur', () => {
            localStorage.setItem('huggingFaceDataset', huggingFaceDatasetInput.value.trim());
            localStorage.setItem('datasetName', datasetInput.value.trim());
        });

        // 备份数据
        backupBtn.addEventListener('click', async () => {
            const platform = platformSelect.value;
            const userHandle = localStorage.getItem('currentUserHandle');

            let token, dataset;
            if (platform === 'modelscope') {
                token = modelScopeTokenInput.value.trim();
                dataset = modelScopeDatasetInput.value.trim();
            } else if (platform === 'huggingface') {
                token = huggingFaceTokenInput.value.trim();
                dataset = huggingFaceDatasetInput.value.trim();
            }

            if (!token || !dataset) {
                showMessage('请先配置 Token 和数据集名称', 'error');
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
            showMessage('正在备份数据，请稍候...', 'info');

            try {
                const response = await fetch('/api/backup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform, token, dataset, userHandle })
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
                                        showMessage(msg, 'success');
                                    } else {
                                        showMessage(data.message || '备份失败', 'error');
                                    }
                                } else if (data.progress !== null) {
                                    // 进度更新
                                    showProgress(data.message, data.progress);
                                } else {
                                    // 普通消息
                                    showMessage(data.message, 'info');
                                }
                            } catch (e) {
                                console.error('解析 SSE 数据失败:', e, line);
                            }
                        }
                    }
                }

            } catch (err) {
                hideProgress();
                showMessage('备份失败：' + err.message, 'error');
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

            let token, dataset;
            if (platform === 'modelscope') {
                token = modelScopeTokenInput.value.trim();
                dataset = modelScopeDatasetInput.value.trim();
            } else if (platform === 'huggingface') {
                token = huggingFaceTokenInput.value.trim();
                dataset = huggingFaceDatasetInput.value.trim();
            }

            if (!token || !dataset) {
                showMessage('请先配置 Token 和数据集名称', 'error');
                return;
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
            showMessage('正在恢复数据，请稍候...', 'info');

            try {
                const response = await fetch('/api/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform, token, dataset, userHandle })
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
                                        showMessage(msg, 'success');
                                    } else {
                                        showMessage(data.message || '恢复失败', 'error');
                                    }
                                } else if (data.progress !== null) {
                                    // 进度更新
                                    showProgress(data.message, data.progress);
                                } else {
                                    // 普通消息
                                    showMessage(data.message, 'info');
                                }
                            } catch (parseErr) {
                                console.error('解析 SSE 数据失败:', parseErr);
                            }
                        }
                    }
                }
            } catch (err) {
                hideProgress();
                showMessage('恢复失败：' + err.message, 'error');
            } finally {
                backupBtn.disabled = false;
                restoreBtn.disabled = false;
                restoreSpinner.style.display = 'none';
            }
        });

        // 进入酒馆
        document.getElementById('enterBtn').addEventListener('click', () => {
            window.location.href = '/st';
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
            showMessage('正在上传并恢复本地备份，请稍候...', 'info');

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
                                        showMessage('本地备份恢复成功！', 'success');
                                        // 清除选择的文件
                                        selectedFile = null;
                                        localBackupFile.value = '';
                                        uploadHint.textContent = '支持 .zip 格式的备份文件';
                                        uploadHint.style.color = '#6b7290';
                                        restoreLocalBtn.style.display = 'none';
                                    } else {
                                        showMessage(data.message || '恢复失败', 'error');
                                    }
                                } else if (data.progress !== null) {
                                    showProgress(data.message, data.progress);
                                } else {
                                    showMessage(data.message, 'info');
                                }
                            } catch (parseErr) {
                                console.error('解析 SSE 数据失败:', parseErr);
                            }
                        }
                    }
                }
            } catch (err) {
                hideProgress();
                showMessage('恢复失败：' + err.message, 'error');
            } finally {
                backupBtn.disabled = false;
                restoreBtn.disabled = false;
                restoreLocalBtn.disabled = false;
                restoreLocalSpinner.style.display = 'none';
            }
        });

        // 退出登录
        document.getElementById('logoutLink').addEventListener('click', async () => {
            const confirmed = await customConfirm('确定要退出登录吗？');
            if (confirmed) {
                try {
                    await fetch('/api/users/logout', {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    console.error('退出登录失败:', e);
                }
                // 无论是否成功，都跳转到登录页
                window.location.href = '/login';
            }
        });
    </script>
</body>
</html>`;
}

// ─── Authentication Middleware ───────────────────────────────────────────────

// 检查用户是否已登录（通过代理到 SillyTavern 的 /api/users/me）
async function checkAuth(req) {
    return new Promise((resolve) => {
        const options = {
            host: ST_HOST,
            port: ST_PORT,
            method: 'GET',
            path: '/api/users/me',
            headers: {
                'Cookie': req.headers.cookie || '',
            },
        };

        const proxyReq = http.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                if (proxyRes.statusCode === 200) {
                    try {
                        const user = JSON.parse(data);
                        resolve({ authenticated: true, user });
                    } catch {
                        resolve({ authenticated: false });
                    }
                } else {
                    resolve({ authenticated: false });
                }
            });
        });

        proxyReq.on('error', () => {
            resolve({ authenticated: false });
        });

        proxyReq.end();
    });
}

// 需要登录的中间件
async function requireAuth(req, res, next) {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
        return res.redirect('/login');
    }
    req.user = auth.user;
    next();
}

// 已登录则重定向到 dashboard
async function redirectIfAuth(req, res, next) {
    const auth = await checkAuth(req);
    if (auth.authenticated) {
        return res.redirect('/dashboard');
    }
    next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Dashboard 页面（登录后的数据管理中心）
app.get('/dashboard', requireAuth, (_req, res) => {
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

// 备份当前用户数据到魔搭社区（使用 Git LFS）
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
            const { platform, token, dataset, userHandle } = req.body;

            if (!platform || !token || !dataset || !userHandle) {
                clearTimeout(timeoutId);
                return sendComplete(false, '缺少必要参数');
            }

            // 验证平台
            if (platform !== 'modelscope' && platform !== 'huggingface') {
                clearTimeout(timeoutId);
                return sendComplete(false, '不支持的备份平台');
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

            try {
                execSync(`git clone --depth 1 "${repoUrl}" "${tempGitDir}"`, {
                    stdio: 'pipe',
                    encoding: 'utf8'
                });
                sendProgress('克隆完成', 50);
            } catch (cloneErr) {
                console.error('[备份] 克隆失败:', cloneErr.message);
                throw new Error('克隆仓库失败：' + cloneErr.message);
            }

            // 配置 Git LFS
            sendProgress('正在配置 Git LFS...', 55);
            try {
                execSync('git lfs install', { cwd: tempGitDir, stdio: 'pipe' });

                // 配置 Git 用户信息（提交需要）
                execSync('git config user.name "ST-Register"', { cwd: tempGitDir, stdio: 'pipe' });
                execSync('git config user.email "backup@st-register.local"', { cwd: tempGitDir, stdio: 'pipe' });
            } catch (lfsErr) {
                console.error('[备份] Git LFS 安装失败:', lfsErr.message);
                throw new Error('Git LFS 未安装或配置失败');
            }

            // 复制备份文件到仓库
            sendProgress(`正在准备上传 ${fileSize} MB 文件...`, 60);
            const backupFileName = `backup-${userHandle}.zip`;
            const targetPath = path.join(tempGitDir, backupFileName);
            fs.copyFileSync(tempZipPath, targetPath);

            // 添加到 Git LFS 跟踪
            sendProgress('正在配置 LFS 跟踪...', 65);
            execSync(`git lfs track "*.zip"`, { cwd: tempGitDir, stdio: 'pipe' });

            // 提交并推送
            sendProgress('正在添加文件到 Git...', 70);
            execSync('git add .gitattributes', { cwd: tempGitDir, stdio: 'pipe' });
            execSync(`git add "${backupFileName}"`, { cwd: tempGitDir, stdio: 'pipe' });

            sendProgress('正在提交更改...', 75);
            const commitMessage = `Backup for ${userHandle} at ${new Date().toISOString()}`;
            try {
                execSync(`git commit -m "${commitMessage}"`, { cwd: tempGitDir, stdio: 'pipe' });
            } catch (commitErr) {
                // 检查是否没有变化需要提交
                const statusOutput = execSync('git status --porcelain', { cwd: tempGitDir, encoding: 'utf8' });
                if (!statusOutput.trim()) {
                    // 没有变化需要提交，跳过
                } else {
                    console.error('[备份] 提交失败:', commitErr.message);
                    throw commitErr;
                }
            }

            sendProgress(`正在推送 ${fileSize} MB 到远程仓库...（可能需要较长时间）`, 80);

            // 使用 spawn 来实时捕获 git push 输出，避免阻塞
            await new Promise((resolve, reject) => {
                const gitPush = spawn('git', ['push', 'origin', 'master'], {
                    cwd: tempGitDir,
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                let lastProgress = 80;

                // Git LFS 的进度信息通常在 stderr
                gitPush.stderr.on('data', (data) => {
                    const output = data.toString();

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
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`git push 失败，退出码: ${code}`));
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
        const { platform, token, dataset, userHandle } = req.body;

        if (!platform || !token || !dataset || !userHandle) {
            clearTimeout(timeoutId);
            return sendComplete(false, '缺少必要参数');
        }

        // 验证平台
        if (platform !== 'modelscope' && platform !== 'huggingface') {
            clearTimeout(timeoutId);
            return sendComplete(false, '不支持的备份平台');
        }

        const userDataDir = path.join(DATA_ROOT, userHandle);

        // 解析数据集名称
        const [namespace, datasetName] = dataset.split('/');
        if (!namespace || !datasetName) {
            clearTimeout(timeoutId);
            return sendComplete(false, '数据集名称格式错误，应为：用户名/数据集名称');
        }

        // 创建临时目录用于 Git 操作
        sendProgress('正在准备恢复...', 5);
        const timestamp = Date.now();
        const tempGitDir = path.join(getTempDir(), `git-restore-${userHandle}-${timestamp}`);
        fs.mkdirSync(tempGitDir, { recursive: true });

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
            const backupFileName = `backup-${userHandle}.zip`;
            const backupFilePath = path.join(tempGitDir, backupFileName);

            if (!fs.existsSync(backupFilePath)) {
                fs.rmSync(tempGitDir, { recursive: true, force: true });
                return sendComplete(false, `未找到备份文件: ${backupFileName}`);
            }

            const fileSize = (fs.statSync(backupFilePath).size / 1024 / 1024).toFixed(2);
            sendProgress(`找到备份文件，大小：${fileSize} MB`, 65);

            // 备份当前数据（以防恢复失败）
            sendProgress('正在备份当前数据...', 70);
            const backupDir = path.join(getTempDir(), `backup-before-restore-${userHandle}-${timestamp}`);
            if (fs.existsSync(userDataDir)) {
                fs.cpSync(userDataDir, backupDir, { recursive: true });
            }

            try {
                // 清空当前数据目录
                sendProgress('正在清空当前数据...', 75);
                if (fs.existsSync(userDataDir)) {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
                fs.mkdirSync(userDataDir, { recursive: true });

                // 解压恢复数据
                sendProgress('正在解压备份文件...', 80);
                await extract(backupFilePath, { dir: userDataDir });

                sendProgress('解压完成，正在清理临时文件...', 95);

                // 清理临时文件
                fs.rmSync(tempGitDir, { recursive: true, force: true });
                if (fs.existsSync(backupDir)) {
                    fs.rmSync(backupDir, { recursive: true, force: true });
                }

                clearTimeout(timeoutId);
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
                if (fs.existsSync(tempGitDir)) {
                    fs.rmSync(tempGitDir, { recursive: true, force: true });
                }
                throw extractErr;
            }

        } catch (gitErr) {
            console.error('[恢复] Git 操作失败:', gitErr.message);

            // 清理临时文件
            if (fs.existsSync(tempGitDir)) fs.rmSync(tempGitDir, { recursive: true, force: true });

            clearTimeout(timeoutId);
            sendComplete(false, 'Git 操作失败：' + gitErr.message + '。请确保已安装 Git 和 Git LFS，且数据集存在并有读取权限。');
        }

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
    mdRendererJs: MD_RENDERER_JS,
});

// ─── Reverse proxy to SillyTavern ─────────────────────────────────────────────

// /st 及其子路径代理到 SillyTavern，其他路径按需处理。
// 使用 Node 内置 http 模块，零额外依赖，逐字节透传（支持 SSE 流式响应）。
// 对 SillyTavern 返回的 HTML 文档，会把标题/品牌名替换为站点标题（不改 ST 文件）。

// 复用到 SillyTavern 的 TCP 连接（keepAlive），降低高并发下的连接开销。
const proxyAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 256,
    maxFreeSockets: 64,
});

// 根路径重定向到 dashboard
app.get('/', requireAuth, (req, res) => {
    res.redirect('/dashboard');
});

// 代理函数：转发请求到 SillyTavern
function proxyToST(req, res, targetPath) {
    // 是否需要改写响应（替换标题 / 注入公告）。仅在确有需要时才关压缩 + 缓冲，
    // 否则完全透传（保留 SillyTavern 的 gzip，前端 bundle 不被放大）。
    const mayRewrite = (SITE.title && SITE.title !== 'SillyTavern')
        || (ANNOUNCE.enabled && ANNOUNCE.content);

    const reqHeaders = { ...req.headers, host: `${ST_HOST}:${ST_PORT}` };
    // 只有可能改写时才关压缩，且仅针对页面文档请求（避免影响 JS/CSS/API）。
    if (mayRewrite && acceptsHtml(req)) {
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
        // SillyTavern 的重定向需要加上 /st 前缀
        const location = proxyRes.headers['location'];
        if (location) {
            let newLocation = location
                .replace(`http://${ST_HOST}:${ST_PORT}`, '')
                .replace(`http://localhost:${ST_PORT}`, '');

            // 如果是相对路径且不是以 /st 开头，添加 /st 前缀
            if (newLocation && newLocation.startsWith('/') && !newLocation.startsWith('/st')) {
                newLocation = '/st' + newLocation;
            }
            proxyRes.headers['location'] = newLocation;
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

// 获取当前用户信息（必须在通用 /api 代理之前）
app.get('/api/current-user', (req, res) => {
    console.log('[/api/current-user] 收到请求');
    console.log('[/api/current-user] Cookie:', req.headers.cookie);

    // 直接代理到 SillyTavern 的 /api/users/me
    proxyToST(req, res, '/api/users/me');
});

// /api/* 路径代理到 SillyTavern（用于登录、用户信息等 API）
app.use('/api', (req, res) => {
    console.log('[/api 通用代理] 拦截到请求:', req.method, req.originalUrl);
    proxyToST(req, res, req.originalUrl);
});

// /csrf-token 代理到 SillyTavern
app.use('/csrf-token', (req, res) => {
    proxyToST(req, res, req.originalUrl);
});

// /st 及其子路径代理到 SillyTavern
app.use('/st', async (req, res, next) => {
    // 检查是否已登录
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
        return res.redirect('/login');
    }

    // 去掉 /st 前缀，转发到 SillyTavern 的根路径
    const targetPath = req.originalUrl.replace(/^\/st/, '') || '/';
    proxyToST(req, res, targetPath);
});

// SillyTavern 的静态资源路径（从 /st 页面加载的资源）
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

// 兜底：其他所有未匹配的路径也代理到 SillyTavern（用于静态资源）
// 这样 /lib/*, /scripts/*, /css/* 等资源都能正确加载
app.use((req, res) => {
    // 排除已经处理过的路径
    const path = req.path;
    if (path.startsWith('/register') ||
        path.startsWith('/login') ||
        path.startsWith('/dashboard') ||
        path.startsWith('/admin') ||
        path === '/stats' ||
        path === '/server-info' ||
        path === '/bg-info' ||
        path === '/friend-links' ||
        path === '/bg') {
        return res.status(404).send('Not Found');
    }

    // 其他路径代理到 SillyTavern
    proxyToST(req, res, req.originalUrl);
});

// 判断请求是否在请求一个 HTML 文档（用于决定是否需要关压缩做改写）。
function acceptsHtml(req) {
    // 只有 GET/HEAD 的导航请求才可能是页面文档
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const accept = String(req.headers['accept'] || '');
    return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

// 把 SillyTavern 页面里的标题/品牌名替换为站点标题，并按需注入公告脚本。
function rebrandHtml(html) {
    // 标题替换（仅当自定义了标题时）
    if (SITE.title && SITE.title !== 'SillyTavern') {
        const title = escapeHtml(SITE.title);
        html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
    }
    // 公告注入（在 </body> 前插入脚本）
    if (ANNOUNCE.enabled && ANNOUNCE.content) {
        const snippet = getAnnouncementSnippet();
        if (html.includes('</body>')) {
            html = html.replace('</body>', snippet + '</body>');
        } else {
            html += snippet;
        }
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
