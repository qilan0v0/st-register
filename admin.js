/**
 * SillyTavern 后台管理模块
 *
 * 通过 mountAdmin(app, deps) 挂载到主服务器。提供 /admin 管理页面与 /admin/api/*
 * 接口：用户列表、创建/删除、启用/禁用、提升/降级管理员、改密码、服务器状态。
 *
 * 认证：独立后台密码（st-register/config.yaml 的 admin.password）。登录后下发
 * HMAC 签名的 httpOnly cookie，仅作用于 /admin 路径。后台直接读写 node-persist
 * 存储，复用主服务器传入的用户操作函数，不依赖 SillyTavern 的管理员会话。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

import express from 'express';

// 后台运行时配置（由 mountAdmin 从 config.yaml 注入）
const ADMIN = {
    enabled: false,
    password: '',
};

// 会话签名密钥：每次启动随机生成（重启后需重新登录，可接受）。
const ADMIN_SECRET = crypto.randomBytes(32).toString('hex');
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 小时
const COOKIE_NAME = 'admin_session';
const DEFAULT_USER_HANDLE = 'default-user';

// ─── 认证工具 ─────────────────────────────────────────────────────────────────

function sign(value) {
    return crypto.createHmac('sha256', ADMIN_SECRET).update(value).digest('base64url');
}

function makeToken() {
    const payload = String(Date.now() + SESSION_MS);
    return payload + '.' + sign(payload);
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    const idx = token.lastIndexOf('.');
    if (idx < 0) return false;
    const payload = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    if (!crypto.timingSafeEqual(a, b)) return false;
    const exp = parseInt(payload, 10);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    return true;
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > 0) {
            out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        }
    }
    return out;
}

function checkPassword(input) {
    if (!input || !ADMIN.password) return false;
    const a = Buffer.from(String(input));
    const b = Buffer.from(ADMIN.password);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function isAuthed(req) {
    return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

function requireAdmin(req, res, next) {
    if (!ADMIN.enabled) {
        return res.status(503).json({ error: '后台未启用：请在 config.yaml 中开启 admin 并设置密码。' });
    }
    if (isAuthed(req)) return next();
    return res.status(401).json({ error: '未授权，请先登录后台。' });
}

// 递归统计目录大小（字节）。出错的项跳过。
async function dirSize(dir) {
    let total = 0;
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
            if (entry.isDirectory()) {
                total += await dirSize(full);
            } else if (entry.isFile()) {
                const st = await fs.promises.stat(full);
                total += st.size;
            }
        } catch {
            // 跳过无法访问的项
        }
    }
    return total;
}

// 检测 SillyTavern 内部端口是否在线
function checkSillyTavernOnline(host, port) {
    return new Promise((resolve) => {
        const req = http.request(
            { host, port, method: 'GET', path: '/', timeout: 2000 },
            (res) => {
                res.resume();
                resolve(true);
            },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

// ─── 后台页面 ─────────────────────────────────────────────────────────────────

function buildAdminPage(mdRendererJs) {
    // 把共享的 Markdown 渲染器注入页面，供公告预览复用。
    const mdScript = mdRendererJs ? `<script>${mdRendererJs}</script>` : '';
    return ADMIN_HTML_HEAD + ADMIN_HTML_BODY + mdScript + ADMIN_HTML_SCRIPT;
}

const ADMIN_HTML_HEAD = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>后台管理 — SillyTavern</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box;
        -webkit-font-smoothing: antialiased; }
    :root {
        --accent: #7c3aed; --accent2: #e94560; --ok: #22c55e; --warn: #f59e0b;
        --danger: #ef4444; --text: #e8eaf2; --muted: #8b93ad;
        --line: rgba(255,255,255,0.09); --radius: 14px;
    }
    body {
        font-family: 'Inter','Segoe UI',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;
        color: var(--text); min-height: 100vh; padding: 28px 18px;
        background: #070a14;
        background-image:
            radial-gradient(at 12% 10%, rgba(124,58,237,0.22), transparent 42%),
            radial-gradient(at 88% 4%, rgba(233,69,96,0.16), transparent 44%);
        background-attachment: fixed;
    }
    .wrap { max-width: 1040px; margin: 0 auto; }
    .panel {
        background: rgba(18,22,38,0.72);
        backdrop-filter: blur(20px) saturate(160%);
        -webkit-backdrop-filter: blur(20px) saturate(160%);
        border: 1px solid var(--line); border-radius: var(--radius);
        box-shadow: 0 20px 60px rgba(0,0,0,0.45);
    }
    /* 登录视图 */
    #loginView { max-width: 400px; margin: 8vh auto 0; padding: 40px; }
    #loginView h1 {
        font-size: 24px; text-align: center; margin-bottom: 6px;
        background: linear-gradient(135deg,#fff,#c3c9ff 55%,#ff7a92);
        -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    #loginView .sub { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 26px; }
    label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px;
        text-transform: uppercase; letter-spacing:.5px; }
    input, select {
        width: 100%; padding: 11px 14px; background: rgba(255,255,255,0.04);
        border: 1px solid var(--line); border-radius: 11px; color: var(--text);
        font-size: 14px; outline: none; transition: border-color .2s, box-shadow .2s;
    }
    select { color-scheme: dark; }
    /* 修复下拉展开后选项白底看不清：强制深色背景 + 浅色文字 */
    select option { background: #16213e; color: #e8eaf2; }
    select option:checked { background: #2a3358; }
    input:focus, select:focus { border-color:#8a96ff; box-shadow:0 0 0 4px rgba(124,138,255,0.15); }
    .field { margin-bottom: 16px; }
    .btn {
        border: none; border-radius: 11px; padding: 11px 18px; font-size: 14px;
        font-weight: 600; cursor: pointer; color: #fff; transition: transform .15s, filter .2s, box-shadow .2s;
        background: linear-gradient(135deg,var(--accent),var(--accent2));
        box-shadow: 0 8px 22px rgba(124,58,237,0.32);
    }
    .btn:hover { transform: translateY(-1px); filter: brightness(1.08); }
    .btn:disabled { opacity:.5; cursor:not-allowed; transform:none; }
    .btn.full { width: 100%; }
    .btn.sm { padding: 6px 11px; font-size: 12.5px; box-shadow:none; border-radius: 9px; }
    .btn.ghost { background: rgba(255,255,255,0.06); box-shadow:none; }
    .btn.danger { background: linear-gradient(135deg,#ef4444,#b91c1c); box-shadow:none; }
    .btn.warn { background: linear-gradient(135deg,#f59e0b,#d97706); box-shadow:none; }
    .btn.okbtn { background: linear-gradient(135deg,#22c55e,#14b8a6); box-shadow:none; }
    .err { background: rgba(239,68,68,0.12); border:1px solid var(--danger); color:#fca5a5;
        border-radius:11px; padding:11px; font-size:13px; margin-bottom:16px; display:none; }
    .err.show { display:block; }
    /* 顶栏 */
    .topbar { display:flex; align-items:center; justify-content:space-between;
        padding: 18px 24px; margin-bottom: 18px; }
    .topbar .title { font-size: 18px; font-weight: 700; }
    .topbar .title small { color: var(--muted); font-weight: 400; font-size: 12px; margin-left:8px; }
    /* 状态卡片 */
    .cards { display:grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr));
        gap: 14px; margin-bottom: 18px; }
    .card { padding: 18px 20px; }
    .card .k { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .card .v { font-size: 22px; font-weight: 700; }
    .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:7px; vertical-align:middle; }
    .dot.on { background: var(--ok); box-shadow:0 0 8px var(--ok); }
    .dot.off { background: var(--danger); box-shadow:0 0 8px var(--danger); }
    /* 区块 */
    .section { padding: 20px 24px; margin-bottom: 18px; }
    .section h2 { font-size: 15px; margin-bottom: 16px; display:flex; align-items:center; gap:8px; }
    .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
    .row .field { flex:1; min-width: 160px; margin-bottom:0; }
    .checkline { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; }
    .checkline input { width:auto; }
    /* 可收缩分组 */
    .stgroup { border:1px solid var(--border); border-radius:10px; margin-bottom:10px; overflow:hidden; background:rgba(255,255,255,0.02); }
    .stgroup > summary { cursor:pointer; padding:11px 14px; font-size:13.5px; font-weight:600; list-style:none;
        display:flex; align-items:center; gap:8px; user-select:none; }
    .stgroup > summary::-webkit-details-marker { display:none; }
    .stgroup > summary::before { content:'▸'; font-size:12px; opacity:.7; transition:transform .15s; }
    .stgroup[open] > summary::before { transform:rotate(90deg); }
    .stgroup > summary:hover { background:rgba(255,255,255,0.04); }
    .stgroup-body { padding:6px 14px 14px; border-top:1px solid var(--border); }
    /* 表格 */
    .tablewrap { overflow-x:auto; }
    table { width:100%; border-collapse: collapse; font-size: 13.5px; }
    th, td { text-align:left; padding: 11px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
    th { color: var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
    tbody tr:hover { background: rgba(255,255,255,0.03); }
    .badge { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11.5px; font-weight:600; }
    .badge.admin { background: rgba(124,58,237,0.2); color:#c4b5fd; }
    .badge.user { background: rgba(255,255,255,0.08); color: var(--muted); }
    .badge.on { background: rgba(34,197,94,0.16); color:#86efac; }
    .badge.off { background: rgba(239,68,68,0.16); color:#fca5a5; }
    .acts { display:flex; gap:6px; flex-wrap:wrap; }
    .muted { color: var(--muted); }
    .hidden { display:none !important; }
    .spin { display:inline-block; width:16px; height:16px; border:2px solid rgba(255,255,255,.3);
        border-top-color:#fff; border-radius:50%; animation: sp .6s linear infinite; vertical-align:middle; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(20,24,40,0.95); border:1px solid var(--line); color:#fff;
        padding: 12px 20px; border-radius: 11px; font-size: 14px; box-shadow:0 10px 30px rgba(0,0,0,.5);
        opacity:0; transition: opacity .25s, transform .25s; pointer-events:none; z-index:50; }
    .toast.show { opacity:1; transform: translateX(-50%) translateY(-4px); }
</style>
</head>`;

const ADMIN_HTML_BODY = `
<body>
<div class="wrap">
    <!-- 登录视图 -->
    <div id="loginView" class="panel hidden">
        <h1>后台管理</h1>
        <p class="sub">请输入后台密码登录</p>
        <div class="err" id="loginErr"></div>
        <form id="loginForm">
            <div class="field">
                <label for="adminPwd">后台密码</label>
                <input type="password" id="adminPwd" autocomplete="current-password" autofocus>
            </div>
            <button class="btn full" type="submit" id="loginBtn">登录</button>
        </form>
    </div>

    <!-- 未启用提示 -->
    <div id="disabledView" class="panel hidden" style="max-width:520px;margin:8vh auto 0;padding:36px;text-align:center;">
        <h1 style="font-size:20px;margin-bottom:12px;">后台尚未启用</h1>
        <p class="muted" style="font-size:14px;line-height:1.7;">
            请编辑 st-register 目录下的 <code style="color:#c4b5fd;">config.yaml</code>，设置：<br><br>
            <code style="color:#86efac;">admin:<br>&nbsp;&nbsp;enabled: true<br>&nbsp;&nbsp;password: "你的强密码"</code><br><br>
            保存后重启服务即可使用后台。
        </p>
    </div>

    <!-- 仪表盘 -->
    <div id="dashView" class="hidden">
        <div class="topbar panel">
            <div class="title">SillyTavern 后台管理 <small>用户与服务器管理</small></div>
            <button class="btn ghost sm" id="logoutBtn">退出登录</button>
        </div>

        <div class="cards" id="statusCards"></div>

        <div class="section panel">
            <h2>🎨 网站设置</h2>
            <div class="err" id="siteErr"></div>
            <form id="siteForm">
                <div class="row">
                    <div class="field">
                        <label for="siteTitle">网站标题</label>
                        <input type="text" id="siteTitle" placeholder="例如：我的 AI 聊天站">
                    </div>
                    <div class="field" style="flex:2;">
                        <label for="siteLogo">Logo 图片地址（URL，留空只显示标题）</label>
                        <input type="text" id="siteLogo" placeholder="https://example.com/logo.png">
                    </div>
                    <button class="btn" type="submit" id="siteBtn">保存</button>
                </div>
                <div id="logoPreviewWrap" style="margin-top:14px;display:none;">
                    <div class="muted" style="font-size:12px;margin-bottom:6px;">Logo 预览：</div>
                    <img id="logoPreview" style="max-width:180px;max-height:72px;object-fit:contain;background:rgba(255,255,255,0.04);border:1px solid var(--line);border-radius:10px;padding:8px;">
                </div>
            </form>
        </div>

        <div class="section panel">
            <h2>📢 公告设置</h2>
            <div class="err" id="annErr"></div>
            <form id="annForm">
                <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
                    <label class="checkline">
                        <input type="checkbox" id="annEnabled"> 启用公告
                    </label>
                    <div class="checkline">
                        弹出频率：
                        <select id="annFreq" style="width:auto;">
                            <option value="once">同一条只弹一次</option>
                            <option value="always">每次进入都弹</option>
                        </select>
                    </div>
                </div>
                <div class="field">
                    <label for="annContent">公告内容（支持 <b style="color:#b9a3ff;">Markdown</b>：# 标题、**粗体**、*斜体*、\`代码\`、- 列表、&gt; 引用、[链接](网址)、--- 分割线）</label>
                    <textarea id="annContent" rows="5" placeholder="例如：&#10;## 系统维护通知&#10;服务器将于 **今晚 12 点** 维护。&#10;- 请提前保存对话&#10;- 预计 30 分钟"
                        style="width:100%;padding:11px 14px;background:rgba(255,255,255,0.04);border:1px solid var(--line);border-radius:11px;color:var(--text);font-size:14px;font-family:inherit;outline:none;resize:vertical;"></textarea>
                </div>
                <div id="annPreviewWrap" style="margin-bottom:14px;display:none;">
                    <div class="muted" style="font-size:12px;margin-bottom:6px;">预览：</div>
                    <div id="annPreview" class="st-md-body" style="background:rgba(255,255,255,0.04);border:1px solid var(--line);border-radius:11px;padding:14px 16px;font-size:14px;line-height:1.8;color:#cfd3e6;max-height:300px;overflow:auto;"></div>
                </div>
                <button class="btn" type="submit" id="annBtn">保存公告</button>
            </form>
        </div>

        <div class="section panel">
            <h2>➕ 创建用户</h2>
            <div class="err" id="createErr"></div>
            <form id="createForm">
                <div class="row">
                    <div class="field">
                        <label for="newName">显示名称</label>
                        <input type="text" id="newName" placeholder="例如：张三">
                    </div>
                    <div class="field">
                        <label for="newPwd">密码（可选）</label>
                        <input type="password" id="newPwd" placeholder="留空则无密码">
                    </div>
                    <label class="checkline" style="margin-bottom:2px;">
                        <input type="checkbox" id="newAdmin"> 设为管理员
                    </label>
                    <button class="btn" type="submit" id="createBtn">创建</button>
                </div>
            </form>
        </div>

        <div class="section panel">
            <h2>🖼️ 背景设置</h2>
            <div class="err" id="bgErr"></div>
            <form id="bgForm">
                <div class="field" style="margin-bottom:14px;">
                    <label for="bgMode">背景模式</label>
                    <select id="bgMode">
                        <option value="none">无（极光流光）</option>
                        <option value="api">随机图 API（一个接口，每次随机）</option>
                        <option value="urls">多个图片链接（随机选一张）</option>
                        <option value="local">本地图片（单张）</option>
                        <option value="folder">本地文件夹（随机一张）</option>
                    </select>
                </div>

                <div class="field bg-field" data-mode="api" style="display:none;">
                    <label for="bgApi">API 地址（返回一张图片的接口）</label>
                    <input type="text" id="bgApi" placeholder="https://api.example.com/random">
                </div>
                <div class="field bg-field" data-mode="urls" style="display:none;">
                    <label for="bgUrls">图片链接（每行一个）</label>
                    <textarea id="bgUrls" rows="4" placeholder="https://example.com/1.jpg&#10;https://example.com/2.jpg"
                        style="width:100%;padding:11px 14px;background:rgba(255,255,255,0.04);border:1px solid var(--line);border-radius:11px;color:var(--text);font-size:14px;font-family:inherit;outline:none;resize:vertical;"></textarea>
                </div>
                <div class="field bg-field" data-mode="local" style="display:none;">
                    <label for="bgLocal">本地图片路径（相对 st-register 目录或绝对路径）</label>
                    <input type="text" id="bgLocal" placeholder="./backgrounds/login.jpg">
                </div>
                <div class="field bg-field" data-mode="folder" style="display:none;">
                    <label for="bgFolder">本地文件夹路径（从中随机取图）</label>
                    <input type="text" id="bgFolder" placeholder="./backgrounds">
                </div>

                <div class="row" style="margin-top:6px;">
                    <div class="field">
                        <label for="bgDim">暗化遮罩 <span class="muted" id="bgDimVal"></span></label>
                        <input type="range" id="bgDim" min="0" max="100" step="5" style="width:100%;">
                    </div>
                    <div class="field">
                        <label for="bgBlur">模糊像素 <span class="muted" id="bgBlurVal"></span></label>
                        <input type="range" id="bgBlur" min="0" max="30" step="1" style="width:100%;">
                    </div>
                    <button class="btn" type="submit" id="bgBtn">保存</button>
                </div>
                <div class="muted" style="font-size:12px;margin-top:8px;">
                    提示：保存后到登录页刷新查看效果。本地路径需服务器上真实存在的图片。
                </div>
            </form>
        </div>

        <div class="section panel">
            <h2>🎴 卡片样式</h2>
            <div class="err" id="cardErr"></div>
            <form id="cardForm">
                <div class="row">
                    <div class="field" style="flex:0 0 auto;">
                        <label for="cardAccent">主强调色</label>
                        <input type="color" id="cardAccent" style="width:60px;height:42px;padding:4px;cursor:pointer;">
                    </div>
                    <div class="field" style="flex:0 0 auto;">
                        <label for="cardAccent2">副强调色</label>
                        <input type="color" id="cardAccent2" style="width:60px;height:42px;padding:4px;cursor:pointer;">
                    </div>
                    <div class="field">
                        <label for="cardOpacity">卡片不透明度 <span class="muted" id="cardOpacityVal"></span></label>
                        <input type="range" id="cardOpacity" min="0" max="100" step="1" style="width:100%;">
                    </div>
                </div>
                <div class="row" style="margin-top:6px;">
                    <div class="field">
                        <label for="cardRadius">圆角 <span class="muted" id="cardRadiusVal"></span></label>
                        <input type="range" id="cardRadius" min="0" max="40" step="1" style="width:100%;">
                    </div>
                    <div class="field">
                        <label for="cardBlur">毛玻璃模糊 <span class="muted" id="cardBlurVal"></span></label>
                        <input type="range" id="cardBlur" min="0" max="60" step="1" style="width:100%;">
                    </div>
                </div>

                <div style="border-top:1px solid var(--line);margin:18px 0 14px;padding-top:14px;">
                    <div class="muted" style="font-size:12px;margin-bottom:10px;">文字样式</div>
                    <div class="row">
                        <div class="field" style="flex:0 0 auto;">
                            <label for="cardTextColor">文字主色</label>
                            <input type="color" id="cardTextColor" style="width:60px;height:42px;padding:4px;cursor:pointer;">
                        </div>
                        <div class="field" style="flex:0 0 auto;">
                            <label>标题颜色</label>
                            <div class="checkline" style="height:42px;">
                                <input type="checkbox" id="cardTitleSolid"> 纯色
                                <input type="color" id="cardTitleColor" style="width:50px;height:34px;padding:3px;cursor:pointer;margin-left:6px;">
                            </div>
                        </div>
                        <div class="field">
                            <label for="cardFont">字体</label>
                            <select id="cardFont">
                                <option value="system">系统默认</option>
                                <option value="rounded">圆润</option>
                                <option value="serif">衬线</option>
                                <option value="mono">等宽</option>
                            </select>
                        </div>
                        <div class="field">
                            <label for="cardFontScale">字号 <span class="muted" id="cardFontScaleVal"></span></label>
                            <input type="range" id="cardFontScale" min="70" max="150" step="5" style="width:100%;">
                        </div>
                    </div>
                </div>

                <button class="btn" type="submit" id="cardBtn">保存</button>
            </form>
        </div>

        <div class="section panel">
            <h2>🔗 友情链接</h2>
            <div class="err" id="flErr"></div>
            <label class="checkline" style="margin-bottom:12px;">
                <input type="checkbox" id="flEnabled"> 启用友情链接（显示在登录/注册页底部）
            </label>
            <div id="flList"></div>
            <div style="display:flex;gap:10px;margin-top:10px;">
                <button class="btn ghost sm" type="button" id="flAdd">+ 添加一条</button>
                <button class="btn sm" type="button" id="flSave">保存</button>
            </div>
        </div>

        <div class="section panel">
            <h2>🔢 注册设置</h2>
            <div class="err" id="regErr"></div>
            <form id="regForm">
                <div class="row">
                    <div class="field">
                        <label for="regMax">注册人数上限（0 = 不限制）</label>
                        <input type="number" id="regMax" min="0" step="1" placeholder="0">
                    </div>
                    <div class="checkline" style="margin-bottom:2px;" id="regNow">当前已注册 — 人</div>
                    <button class="btn" type="submit" id="regBtn">保存</button>
                </div>
            </form>
        </div>

        <div class="section panel">
            <h2>💾 备份/恢复设置</h2>
            <div class="err" id="backupErr"></div>
            <form id="backupForm">
                <div class="row">
                    <div class="field">
                        <label for="backupTempDir">临时文件目录（留空 = 使用系统临时目录）</label>
                        <input type="text" id="backupTempDir" placeholder="留空使用系统临时目录">
                        <div class="hint">相对路径基于 st-register 目录，或使用绝对路径</div>
                    </div>
                    <div class="field">
                        <label for="backupCleanupHours">自动清理超过 N 小时的临时文件（0 = 不清理）</label>
                        <input type="number" id="backupCleanupHours" min="0" step="1" placeholder="24">
                    </div>
                    <div class="checkline" style="margin-bottom:2px;" id="backupCurrentDir">当前临时目录：加载中...</div>
                    <button class="btn" type="submit" id="backupBtn">保存</button>
                </div>
            </form>
        </div>

        <div class="section panel">
            <h2>🏰 SillyTavern 设置</h2>
            <div class="err" id="stErr"></div>
            <form id="stForm">
                <div class="row">
                    <div class="field">
                        <label for="stPath">SillyTavern 安装目录（留空 = 默认 ../SillyTavern）</label>
                        <input type="text" id="stPath" placeholder="例如：/data/SillyTavern">
                        <div class="hint">绝对路径或相对于 st-register 的路径，修改后需重启服务</div>
                    </div>
                    <div class="checkline" style="margin-bottom:2px;" id="stCurrentPath">当前路径：加载中...</div>
                    <button class="btn" type="submit" id="stBtn">保存</button>
                </div>
            </form>
        </div>

        <div class="section panel">
            <h2>🛠️ SillyTavern 傻瓜配置 <small>常用参数，看不懂的开关在这里改</small></h2>
            <div class="err" id="stSetErr"></div>
            <div class="checkline" style="margin-bottom:10px;" id="stSetStatus">读取中…</div>

            <div id="stSetBody">
                <div style="display:flex;gap:10px;margin-bottom:10px;">
                    <button class="btn ghost sm" type="button" id="stSetExpandAll">全部展开</button>
                    <button class="btn ghost sm" type="button" id="stSetCollapseAll">全部收起</button>
                </div>

                <details class="stgroup" open>
                    <summary>🌐 网络与访问</summary>
                    <div class="stgroup-body">
                        <label class="checkline">
                            <input type="checkbox" id="stProxyEnabled"> 启用网络请求代理
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">让 SillyTavern 通过代理访问 OpenAI / Claude / Gemini 等外部 AI 接口，解决"连不上 / 超时"。</div>
                        <div class="field" id="stProxyUrlField">
                            <label for="stProxyUrl">代理地址</label>
                            <input type="text" id="stProxyUrl" placeholder="例如：http://127.0.0.1:7890 或 socks5://127.0.0.1:10808">
                            <div class="hint">填本机代理软件地址。HTTP 代理用 http://，Shadowsocks/V2Ray 等用 socks5://。</div>
                        </div>

                        <label class="checkline" style="margin-top:6px;">
                            <input type="checkbox" id="stListen"> 允许局域网 / 外部设备直接访问 SillyTavern
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">开启后同一网络的其它设备可直连 SillyTavern（端口 8000）。一般通过本服务访问即可，无需开启。</div>

                        <label class="checkline">
                            <input type="checkbox" id="stWhitelist"> 开启 IP 白名单保护（推荐开启）
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">只允许白名单内的 IP 直连 SillyTavern，更安全。关闭后任何 IP 都能直连。</div>

                        <label class="checkline">
                            <input type="checkbox" id="stCorsProxy"> 启用内置 CORS 代理
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">部分需要跨域的接口/扩展会用到。不清楚就保持关闭。</div>

                        <div class="field" style="margin-top:8px;">
                            <label for="stPort">SillyTavern 内部端口</label>
                            <input type="number" id="stPort" min="1" max="65535" step="1" placeholder="8000">
                            <div class="hint" style="color:#f0a;">⚠️ 改了端口后必须同时重启 SillyTavern 和本服务，否则会连不上。不懂请勿改。</div>
                        </div>
                    </div>
                </details>

                <details class="stgroup">
                    <summary>🔒 安全与账户</summary>
                    <div class="stgroup-body">
                        <label class="checkline">
                            <input type="checkbox" id="stEnableAccounts"> 启用多用户账户系统（本服务需要开启）
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">本注册/登录服务依赖该功能，请保持开启，否则用户无法登录。</div>

                        <label class="checkline">
                            <input type="checkbox" id="stDiscreetLogin"> 隐私登录（登录页不显示用户列表）
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">开启后登录页不再列出已有账号，需手动输入用户名，更隐私。</div>

                        <label class="checkline">
                            <input type="checkbox" id="stBasicAuth"> 开启访问密码（HTTP Basic Auth）
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">开启后直接访问 SillyTavern 会先弹出浏览器账号密码框。下面填账号密码。</div>
                        <div class="row" id="stBasicAuthFields">
                            <div class="field">
                                <label for="stBasicUser">访问账号</label>
                                <input type="text" id="stBasicUser" placeholder="user">
                            </div>
                            <div class="field">
                                <label for="stBasicPass">访问密码</label>
                                <input type="text" id="stBasicPass" placeholder="password">
                            </div>
                        </div>

                        <div class="field" style="margin-top:6px;">
                            <label for="stSessionTimeout">登录会话有效期（秒，-1 = 永不过期）</label>
                            <input type="number" id="stSessionTimeout" min="-1" step="1" placeholder="-1">
                            <div class="hint">超过这个时间未操作就需要重新登录。填 -1 永不过期。</div>
                        </div>
                    </div>
                </details>

                <details class="stgroup">
                    <summary>💾 自动备份</summary>
                    <div class="stgroup-body">
                        <div class="row">
                            <div class="field">
                                <label for="stNumBackups">备份保留数量</label>
                                <input type="number" id="stNumBackups" min="0" step="1" placeholder="50">
                                <div class="hint">设置/角色等自动备份保留份数，超出删最旧。</div>
                            </div>
                            <div class="field">
                                <label for="stChatMaxBackups">聊天备份上限（-1 = 不限制）</label>
                                <input type="number" id="stChatMaxBackups" min="-1" step="1" placeholder="-1">
                            </div>
                        </div>
                        <label class="checkline">
                            <input type="checkbox" id="stChatBackup"> 启用聊天自动备份
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stChatIntegrity"> 备份时校验完整性
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stFullDataBackup"> 允许完整数据备份
                        </label>
                    </div>
                </details>

                <details class="stgroup">
                    <summary>🧩 扩展与功能</summary>
                    <div class="stgroup-body">
                        <label class="checkline">
                            <input type="checkbox" id="stExtEnabled"> 启用扩展系统
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stExtAutoUpdate"> 启动时自动更新扩展
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stExtModelsDownload"> 自动下载扩展所需模型
                        </label>
                        <div class="hint" style="margin:-4px 0 8px;">表情识别、图像描述等扩展会自动下载模型（较大，需联网）。</div>
                        <label class="checkline">
                            <input type="checkbox" id="stServerPlugins"> 启用服务器插件
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stServerPluginsUpdate"> 服务器插件自动更新
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stDownloadableTokenizers"> 允许下载分词器
                        </label>
                    </div>
                </details>

                <details class="stgroup">
                    <summary>🖼️ 缩略图与性能</summary>
                    <div class="stgroup-body">
                        <label class="checkline">
                            <input type="checkbox" id="stThumbEnabled"> 启用缩略图（角色/背景列表用小图，更快）
                        </label>
                        <div class="row" style="margin-top:8px;">
                            <div class="field">
                                <label for="stThumbQuality">缩略图质量（1–100）</label>
                                <input type="number" id="stThumbQuality" min="1" max="100" step="1" placeholder="95">
                            </div>
                            <div class="field">
                                <label for="stThumbFormat">缩略图格式</label>
                                <select id="stThumbFormat">
                                    <option value="jpg">jpg（更小）</option>
                                    <option value="png">png（更清晰）</option>
                                </select>
                            </div>
                        </div>
                        <label class="checkline">
                            <input type="checkbox" id="stLazyLoad"> 角色懒加载（角色很多时加快启动）
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stDiskCache"> 启用磁盘缓存
                        </label>
                    </div>
                </details>

                <details class="stgroup">
                    <summary>⚙️ 启动与日志</summary>
                    <div class="stgroup-body">
                        <label class="checkline">
                            <input type="checkbox" id="stBrowserLaunch"> SillyTavern 启动时自动打开浏览器
                        </label>
                        <label class="checkline">
                            <input type="checkbox" id="stAccessLog"> 记录访问日志
                        </label>
                    </div>
                </details>

                <div class="hint" style="margin:12px 0 10px;color:#f0a;">⚠️ 以上修改保存后，需要<b>重启 SillyTavern</b> 才会生效（重启本服务不够）。</div>
                <button class="btn" type="button" id="stSetBtn">保存 SillyTavern 配置</button>
            </div>
        </div>

        <div class="section panel">
            <h2>👥 用户列表 <span class="muted" id="userCount" style="font-weight:400;font-size:12px;"></span></h2>
            <div class="tablewrap">
                <table>
                    <thead>
                        <tr>
                            <th>显示名称</th><th>登录账号</th><th>角色</th>
                            <th>状态</th><th>密码</th><th>创建时间</th><th>操作</th>
                        </tr>
                    </thead>
                    <tbody id="userRows"></tbody>
                </table>
            </div>
        </div>
    </div>
</div>
<div class="toast" id="toast"></div>
</body>`;

const ADMIN_HTML_SCRIPT = `
<script>
const $ = (id) => document.getElementById(id);
const loginView = $('loginView'), dashView = $('dashView'), disabledView = $('disabledView');

function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
}
function showErr(el, msg) { el.textContent = msg; el.classList.add('show'); }
function hideErr(el) { el.classList.remove('show'); }

async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(url, opt);
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
}

function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B','KB','MB','GB','TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}
function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 视图切换 ──
async function refreshSession() {
    const { data } = await api('GET', '/admin/api/session');
    if (!data || !data.enabled) {
        loginView.classList.add('hidden'); dashView.classList.add('hidden');
        disabledView.classList.remove('hidden');
        return;
    }
    if (data.authed) { showDash(); }
    else {
        loginView.classList.remove('hidden'); dashView.classList.add('hidden');
        disabledView.classList.add('hidden');
        $('adminPwd').focus();
    }
}

async function showDash() {
    loginView.classList.add('hidden'); disabledView.classList.add('hidden');
    dashView.classList.remove('hidden');
    await Promise.all([loadStatus(), loadUsers(), loadSite(), loadAnnounce(), loadRegistration(), loadBackupConfig(), loadSTConfig(), loadSTSettings(), loadBackground(), loadCard(), loadFriendLinks()]);
}

// ── 登录 / 登出 ──
$('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('loginErr'));
    const btn = $('loginBtn'); btn.disabled = true;
    const r = await api('POST', '/admin/api/login', { password: $('adminPwd').value });
    btn.disabled = false;
    if (!r.ok) { showErr($('loginErr'), (r.data && r.data.error) || '登录失败。'); return; }
    $('adminPwd').value = '';
    showDash();
});
$('logoutBtn').addEventListener('click', async () => {
    await api('POST', '/admin/api/logout');
    refreshSession();
});

// ── 状态卡片 ──
async function loadStatus() {
    const { ok, data } = await api('GET', '/admin/api/status');
    if (!ok || !data) return;
    const onDot = data.sillyTavernOnline ? '<span class="dot on"></span>在线' : '<span class="dot off"></span>离线';
    $('statusCards').innerHTML =
        card('SillyTavern 状态', onDot) +
        card('用户总数', data.userCount) +
        card('管理员', data.adminCount) +
        card('启用中', data.enabledCount) +
        card('数据占用', fmtBytes(data.dataSizeBytes));
}
function card(k, v) {
    return '<div class="card panel"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
}

// ── 网站设置 ──
function updateLogoPreview(url) {
    const wrap = $('logoPreviewWrap'), img = $('logoPreview');
    if (url) { img.src = url; wrap.style.display = 'block'; }
    else { wrap.style.display = 'none'; }
}
async function loadSite() {
    const { ok, data } = await api('GET', '/admin/api/site');
    if (!ok || !data) return;
    $('siteTitle').value = data.title || '';
    $('siteLogo').value = data.logo || '';
    updateLogoPreview(data.logo || '');
}
$('siteLogo').addEventListener('input', () => updateLogoPreview($('siteLogo').value.trim()));
$('siteForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('siteErr'));
    const btn = $('siteBtn'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/site', {
        title: $('siteTitle').value.trim(),
        logo: $('siteLogo').value.trim(),
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('siteErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('网站设置已保存（登录/注册页刷新后生效）');
});

// ── 公告设置 ──
function renderAnnPreview() {
    var wrap = $('annPreviewWrap'), box = $('annPreview');
    var txt = $('annContent').value;
    if (txt && typeof stRenderMarkdown === 'function') {
        box.innerHTML = stRenderMarkdown(txt);
        wrap.style.display = 'block';
    } else {
        wrap.style.display = 'none';
    }
}
async function loadAnnounce() {
    const { ok, data } = await api('GET', '/admin/api/announce');
    if (!ok || !data) return;
    $('annEnabled').checked = !!data.enabled;
    $('annContent').value = data.content || '';
    $('annFreq').value = data.frequency === 'always' ? 'always' : 'once';
    renderAnnPreview();
}
$('annContent').addEventListener('input', renderAnnPreview);
$('annForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('annErr'));
    const btn = $('annBtn'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/announce', {
        enabled: $('annEnabled').checked,
        content: $('annContent').value,
        frequency: $('annFreq').value,
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('annErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('公告已保存（用户进入 SillyTavern 时生效）');
});

// ── 注册设置 ──
async function loadRegistration() {
    const { ok, data } = await api('GET', '/admin/api/registration');
    if (!ok || !data) return;
    $('regMax').value = data.maxUsers || 0;
    var now = $('regNow');
    if (now) {
        now.textContent = '当前已注册 ' + (data.users || 0) + ' 人'
            + (data.maxUsers ? '（上限 ' + data.maxUsers + '）' : '（不限）');
    }
}
$('regForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('regErr'));
    const btn = $('regBtn'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/registration', {
        maxUsers: parseInt($('regMax').value, 10) || 0,
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('regErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('注册设置已保存');
    await loadRegistration();
});

// ── 备份/恢复设置 ──
async function loadBackupConfig() {
    const { ok, data } = await api('GET', '/admin/api/backup-config');
    if (!ok || !data) return;
    $('backupTempDir').value = data.tempDir || '';
    $('backupCleanupHours').value = data.autoCleanupHours || 24;
    var currentDir = $('backupCurrentDir');
    if (currentDir) {
        currentDir.textContent = '当前临时目录：' + (data.currentTempDir || '系统临时目录');
    }
}
$('backupForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('backupErr'));
    const btn = $('backupBtn'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/backup-config', {
        tempDir: $('backupTempDir').value.trim(),
        autoCleanupHours: parseInt($('backupCleanupHours').value, 10) || 0,
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('backupErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('备份设置已保存（重启服务后生效）');
    await loadBackupConfig();
});

// ── SillyTavern 路径设置 ──
async function loadSTConfig() {
    const { ok, data } = await api('GET', '/admin/api/st-config');
    if (!ok || !data) return;
    $('stPath').value = data.path || '';
    var currentPath = $('stCurrentPath');
    if (currentPath) {
        currentPath.textContent = '当前路径：' + (data.currentPath || '../SillyTavern');
    }
}
$('stForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('stErr'));
    const btn = $('stBtn'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/st-config', {
        path: $('stPath').value.trim(),
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('stErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('SillyTavern 路径已保存（重启服务后生效）');
    await loadSTConfig();
});

// ── SillyTavern 傻瓜配置（直接读写 SillyTavern 的 config.yaml）──
// 字段映射表：[元素id, 数据键, 类型]。类型 b=复选框 t=文本(去空格) p=密码(不去空格) n=数字 s=下拉。
var ST_SET_MAP = [
    ['stProxyEnabled', 'requestProxyEnabled', 'b'],
    ['stProxyUrl', 'requestProxyUrl', 't'],
    ['stListen', 'listen', 'b'],
    ['stWhitelist', 'whitelistMode', 'b'],
    ['stCorsProxy', 'enableCorsProxy', 'b'],
    ['stPort', 'port', 'n'],
    ['stEnableAccounts', 'enableUserAccounts', 'b'],
    ['stDiscreetLogin', 'enableDiscreetLogin', 'b'],
    ['stBasicAuth', 'basicAuthMode', 'b'],
    ['stBasicUser', 'basicAuthUsername', 't'],
    ['stBasicPass', 'basicAuthPassword', 'p'],
    ['stSessionTimeout', 'sessionTimeout', 'n'],
    ['stNumBackups', 'numberOfBackups', 'n'],
    ['stChatMaxBackups', 'chatMaxTotalBackups', 'n'],
    ['stChatBackup', 'chatBackupEnabled', 'b'],
    ['stChatIntegrity', 'chatCheckIntegrity', 'b'],
    ['stFullDataBackup', 'allowFullDataBackup', 'b'],
    ['stExtEnabled', 'extensionsEnabled', 'b'],
    ['stExtAutoUpdate', 'extensionsAutoUpdate', 'b'],
    ['stExtModelsDownload', 'extensionModelsAutoDownload', 'b'],
    ['stServerPlugins', 'enableServerPlugins', 'b'],
    ['stServerPluginsUpdate', 'enableServerPluginsAutoUpdate', 'b'],
    ['stDownloadableTokenizers', 'enableDownloadableTokenizers', 'b'],
    ['stThumbEnabled', 'thumbnailsEnabled', 'b'],
    ['stThumbQuality', 'thumbnailsQuality', 'n'],
    ['stThumbFormat', 'thumbnailsFormat', 's'],
    ['stLazyLoad', 'lazyLoadCharacters', 'b'],
    ['stDiskCache', 'useDiskCache', 'b'],
    ['stBrowserLaunch', 'browserLaunch', 'b'],
    ['stAccessLog', 'enableAccessLog', 'b'],
];
function stSetSyncFields() {
    var pf = $('stProxyUrlField'); if (pf) pf.style.display = $('stProxyEnabled').checked ? 'block' : 'none';
    var bf = $('stBasicAuthFields'); if (bf) bf.style.display = $('stBasicAuth').checked ? 'flex' : 'none';
}
async function loadSTSettings() {
    const { ok, data } = await api('GET', '/admin/api/st-settings');
    const status = $('stSetStatus'), body = $('stSetBody');
    if (!ok || !data) {
        if (status) status.textContent = '无法读取 SillyTavern 配置（请先在上方设置正确的安装目录）';
        if (body) body.style.display = 'none';
        return;
    }
    if (!data.exists) {
        if (status) status.textContent = '⚠️ 未找到 config.yaml：' + (data.configPath || '');
        if (body) body.style.display = 'none';
        return;
    }
    if (status) status.textContent = '配置文件：' + data.configPath;
    if (body) body.style.display = 'block';
    for (var i = 0; i < ST_SET_MAP.length; i++) {
        var id = ST_SET_MAP[i][0], key = ST_SET_MAP[i][1], type = ST_SET_MAP[i][2];
        var el = $(id); if (!el) continue;
        if (type === 'b') el.checked = !!data[key];
        else el.value = (data[key] != null ? data[key] : '');
    }
    stSetSyncFields();
}
if ($('stProxyEnabled')) $('stProxyEnabled').addEventListener('change', stSetSyncFields);
if ($('stBasicAuth')) $('stBasicAuth').addEventListener('change', stSetSyncFields);
if ($('stSetExpandAll')) $('stSetExpandAll').addEventListener('click', function () {
    var ds = document.querySelectorAll('#stSetBody .stgroup'); for (var i = 0; i < ds.length; i++) ds[i].open = true;
});
if ($('stSetCollapseAll')) $('stSetCollapseAll').addEventListener('click', function () {
    var ds = document.querySelectorAll('#stSetBody .stgroup'); for (var i = 0; i < ds.length; i++) ds[i].open = false;
});
if ($('stSetBtn')) $('stSetBtn').addEventListener('click', async () => {
    hideErr($('stSetErr'));
    const btn = $('stSetBtn'); btn.disabled = true;
    var payload = {};
    for (var i = 0; i < ST_SET_MAP.length; i++) {
        var id = ST_SET_MAP[i][0], key = ST_SET_MAP[i][1], type = ST_SET_MAP[i][2];
        var el = $(id); if (!el) continue;
        if (type === 'b') payload[key] = el.checked;
        else if (type === 'n') payload[key] = parseInt(el.value, 10);
        else if (type === 'p') payload[key] = el.value;
        else if (type === 's') payload[key] = el.value;
        else payload[key] = el.value.trim();
    }
    const r = await api('PUT', '/admin/api/st-settings', payload);
    btn.disabled = false;
    if (!r.ok) { showErr($('stSetErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('已保存到 SillyTavern config.yaml（需重启 SillyTavern 生效）');
    await loadSTSettings();
});

// ── 背景设置 ──
function bgUpdateFields() {
    var mode = $('bgMode').value;
    var fields = document.querySelectorAll('.bg-field');
    for (var i = 0; i < fields.length; i++) {
        fields[i].style.display = (fields[i].getAttribute('data-mode') === mode) ? 'block' : 'none';
    }
}
function bgUpdateLabels() {
    $('bgDimVal').textContent = $('bgDim').value + '%';
    $('bgBlurVal').textContent = $('bgBlur').value + 'px';
}
async function loadBackground() {
    const { ok, data } = await api('GET', '/admin/api/background');
    if (!ok || !data) return;
    $('bgMode').value = data.mode || 'none';
    $('bgApi').value = data.api || '';
    $('bgUrls').value = (data.urls || []).join('\\n');
    $('bgLocal').value = data.local || '';
    $('bgFolder').value = data.folder || '';
    $('bgDim').value = (data.dim != null ? data.dim : 45);
    $('bgBlur').value = (data.blur != null ? data.blur : 0);
    bgUpdateFields(); bgUpdateLabels();
}
$('bgMode').addEventListener('change', bgUpdateFields);
$('bgDim').addEventListener('input', bgUpdateLabels);
$('bgBlur').addEventListener('input', bgUpdateLabels);
$('bgForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('bgErr'));
    const btn = $('bgBtn'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/background', {
        mode: $('bgMode').value,
        api: $('bgApi').value,
        urls: $('bgUrls').value,
        local: $('bgLocal').value,
        folder: $('bgFolder').value,
        dim: parseInt($('bgDim').value, 10),
        blur: parseInt($('bgBlur').value, 10),
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('bgErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('背景已保存（登录页刷新后生效）');
});

// ── 卡片样式 ──
function cardUpdateLabels() {
    $('cardOpacityVal').textContent = $('cardOpacity').value + '%';
    $('cardRadiusVal').textContent = $('cardRadius').value + 'px';
    $('cardBlurVal').textContent = $('cardBlur').value + 'px';
    $('cardFontScaleVal').textContent = $('cardFontScale').value + '%';
}
async function loadCard() {
    const { ok, data } = await api('GET', '/admin/api/card');
    if (!ok || !data) return;
    $('cardAccent').value = data.accent || '#7c3aed';
    $('cardAccent2').value = data.accent2 || '#e94560';
    $('cardOpacity').value = (data.opacity != null ? data.opacity : 72);
    $('cardRadius').value = (data.radius != null ? data.radius : 22);
    $('cardBlur').value = (data.blur != null ? data.blur : 22);
    $('cardTextColor').value = data.textColor || '#e8eaf2';
    // 标题：有颜色=纯色勾选，空=渐变
    var hasTitle = !!data.titleColor;
    $('cardTitleSolid').checked = hasTitle;
    $('cardTitleColor').value = data.titleColor || '#ffffff';
    $('cardFont').value = data.fontFamily || 'system';
    $('cardFontScale').value = (data.fontScale != null ? data.fontScale : 100);
    cardUpdateLabels();
}
$('cardOpacity').addEventListener('input', cardUpdateLabels);
$('cardRadius').addEventListener('input', cardUpdateLabels);
$('cardBlur').addEventListener('input', cardUpdateLabels);
$('cardFontScale').addEventListener('input', cardUpdateLabels);
$('cardForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('cardErr'));
    const btn = $('cardBtn'); btn.disabled = true;
    // 标题：勾了纯色才传颜色，否则传空字符串=渐变
    var titleColor = $('cardTitleSolid').checked ? $('cardTitleColor').value : '';
    const r = await api('PUT', '/admin/api/card', {
        accent: $('cardAccent').value,
        accent2: $('cardAccent2').value,
        opacity: parseInt($('cardOpacity').value, 10),
        radius: parseInt($('cardRadius').value, 10),
        blur: parseInt($('cardBlur').value, 10),
        textColor: $('cardTextColor').value,
        titleColor: titleColor,
        fontFamily: $('cardFont').value,
        fontScale: parseInt($('cardFontScale').value, 10),
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('cardErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('卡片样式已保存（登录页刷新后生效）');
});

// ── 友情链接 ──
function flAddRow(name, url) {
    var wrap = document.createElement('div');
    wrap.className = 'fl-row';
    wrap.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';
    var n = document.createElement('input');
    n.type = 'text'; n.placeholder = '名称'; n.value = name || '';
    n.style.cssText = 'flex:1;';
    var u = document.createElement('input');
    u.type = 'text'; u.placeholder = 'https://example.com'; u.value = url || '';
    u.style.cssText = 'flex:2;';
    var del = document.createElement('button');
    del.type = 'button'; del.className = 'btn sm danger'; del.textContent = '删除';
    del.onclick = function(){ wrap.remove(); };
    wrap.appendChild(n); wrap.appendChild(u); wrap.appendChild(del);
    $('flList').appendChild(wrap);
}
function flCollect() {
    var rows = $('flList').querySelectorAll('.fl-row');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var ins = rows[i].querySelectorAll('input');
        var name = ins[0].value.trim(), url = ins[1].value.trim();
        if (name && url) out.push({ name: name, url: url });
    }
    return out;
}
async function loadFriendLinks() {
    const { ok, data } = await api('GET', '/admin/api/friend-links');
    if (!ok || !data) return;
    $('flEnabled').checked = !!data.enabled;
    $('flList').innerHTML = '';
    (data.links || []).forEach(function(it){ flAddRow(it.name, it.url); });
}
$('flAdd').addEventListener('click', function(){ flAddRow('', ''); });
$('flSave').addEventListener('click', async function(){
    hideErr($('flErr'));
    const btn = $('flSave'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/friend-links', {
        enabled: $('flEnabled').checked,
        links: flCollect(),
    });
    btn.disabled = false;
    if (!r.ok) { showErr($('flErr'), (r.data && r.data.error) || '保存失败。'); return; }
    toast('友情链接已保存（登录页刷新后生效）');
    await loadFriendLinks();
});

// ── 用户列表渲染 ──
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function loadUsers() {
    const { ok, data } = await api('GET', '/admin/api/users');
    if (!ok || !Array.isArray(data)) return;
    $('userCount').textContent = '共 ' + data.length + ' 个';
    const rows = data.map(u => {
        const h = esc(u.handle);
        const roleBadge = u.admin
            ? '<span class="badge admin">管理员</span>'
            : '<span class="badge user">普通</span>';
        const stBadge = u.enabled
            ? '<span class="badge on">启用</span>'
            : '<span class="badge off">禁用</span>';
        const pwd = u.hasPassword ? '🔒 有' : '— 无';
        const isDefault = u.handle === 'default-user';

        const toggleBtn = u.enabled
            ? '<button class="btn sm warn" data-act="disable" data-h="' + h + '"' + (isDefault?' disabled':'') + '>禁用</button>'
            : '<button class="btn sm okbtn" data-act="enable" data-h="' + h + '">启用</button>';
        const roleBtn = u.admin
            ? '<button class="btn sm ghost" data-act="demote" data-h="' + h + '">降为普通</button>'
            : '<button class="btn sm ghost" data-act="promote" data-h="' + h + '">设管理员</button>';
        const pwdBtn = '<button class="btn sm ghost" data-act="pwd" data-h="' + h + '">改密</button>';
        const delBtn = isDefault ? ''
            : '<button class="btn sm danger" data-act="delete" data-h="' + h + '">删除</button>';

        return '<tr>' +
            '<td>' + esc(u.name) + '</td>' +
            '<td class="muted">' + h + '</td>' +
            '<td>' + roleBadge + '</td>' +
            '<td>' + stBadge + '</td>' +
            '<td>' + pwd + '</td>' +
            '<td class="muted">' + fmtDate(u.created) + '</td>' +
            '<td><div class="acts">' + toggleBtn + roleBtn + pwdBtn + delBtn + '</div></td>' +
            '</tr>';
    }).join('');
    $('userRows').innerHTML = rows;
}

// ── 创建用户 ──
$('createForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr($('createErr'));
    const name = $('newName').value.trim();
    const password = $('newPwd').value;
    const admin = $('newAdmin').checked;
    if (!name) { showErr($('createErr'), '请填写显示名称。'); return; }
    const btn = $('createBtn'); btn.disabled = true;
    const r = await api('POST', '/admin/api/users', { name, password, admin });
    btn.disabled = false;
    if (!r.ok) { showErr($('createErr'), (r.data && r.data.error) || '创建失败。'); return; }
    $('newName').value = ''; $('newPwd').value = ''; $('newAdmin').checked = false;
    toast('已创建用户：' + r.data.handle);
    await Promise.all([loadUsers(), loadStatus()]);
});

// ── 用户操作（事件委托）──
$('userRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const handle = btn.dataset.h;

    if (act === 'delete') {
        if (!confirm('确定删除用户 "' + handle + '"？\\n\\n点“确定”后会询问是否同时删除其数据。')) return;
        const purge = confirm('是否同时删除该用户的所有数据目录？\\n\\n确定 = 彻底删除数据（不可恢复）\\n取消 = 仅删除账号，保留数据');
        const r = await api('DELETE', '/admin/api/users/' + encodeURIComponent(handle) + (purge ? '?purge=true' : ''));
        if (!r.ok) { toast((r.data && r.data.error) || '删除失败'); return; }
        toast('已删除：' + handle);
        await Promise.all([loadUsers(), loadStatus()]);
        return;
    }

    if (act === 'pwd') {
        const np = prompt('为 "' + handle + '" 设置新密码：\\n（留空并确定 = 清除密码，可无密码登录）');
        if (np === null) return;
        const r = await api('PATCH', '/admin/api/users/' + encodeURIComponent(handle), { password: np });
        if (!r.ok) { toast((r.data && r.data.error) || '操作失败'); return; }
        toast(np ? '密码已更新' : '密码已清除');
        await loadUsers();
        return;
    }

    let patch = null;
    if (act === 'enable') patch = { enabled: true };
    else if (act === 'disable') patch = { enabled: false };
    else if (act === 'promote') patch = { admin: true };
    else if (act === 'demote') patch = { admin: false };
    if (!patch) return;

    const r = await api('PATCH', '/admin/api/users/' + encodeURIComponent(handle), patch);
    if (!r.ok) { toast((r.data && r.data.error) || '操作失败'); return; }
    toast('已更新：' + handle);
    await Promise.all([loadUsers(), loadStatus()]);
});

// ── 初始化 ──
refreshSession();
</script>`;

// ─── 挂载后台路由 ─────────────────────────────────────────────────────────────

/**
 * 把后台管理路由挂到 Express app 上。必须在反向代理兜底中间件之前调用。
 * @param {import('express').Express} app
 * @param {object} deps 主服务器传入的共享依赖
 */
export function mountAdmin(app, deps) {
    const {
        storage, KEY_PREFIX, toKey, slugify,
        getPasswordSalt, getPasswordHash,
        getUserDirectories, createUserDirectories, seedDefaultContent,
        DATA_ROOT, ST_HOST, ST_PORT, adminConfig,
        site, saveSiteConfig,
        announce, saveAnnounceConfig,
        registration, saveRegistrationConfig, countUsers,
        background, saveBackgroundConfig,
        card, saveCardConfig,
        friendLinks, saveFriendLinksConfig,
        backupTempConfig, saveBackupConfig, getTempDir,
        sillyTavernConfig, saveSillyTavernConfig, ST_DIR,
        ST_CONFIG_PATH, readSillyTavernSettings, saveSillyTavernSettings,
        mdRendererJs,
    } = deps;

    // 从 config.yaml 注入后台配置
    ADMIN.enabled = !!(adminConfig && adminConfig.enabled && adminConfig.password);
    ADMIN.password = (adminConfig && adminConfig.password) || '';

    const jsonParser = express.json();

    if (!ADMIN.enabled) {
        if (adminConfig && adminConfig.enabled && !adminConfig.password) {
            console.warn('⚠️  后台管理已开启但未设置密码：请在 config.yaml 的 admin.password 填写强密码。');
        } else {
            console.warn('⚠️  后台管理未启用：在 config.yaml 中设置 admin.enabled: true 并填写 admin.password。');
        }
    } else {
        console.log('后台管理已启用: /admin');
    }

    // 后台页面（GET /admin）。未启用时也返回页面，由页面提示需要配置。
    app.get('/admin', (_req, res) => {
        res.send(buildAdminPage(mdRendererJs));
    });

    // 登录
    app.post('/admin/api/login', jsonParser, (req, res) => {
        if (!ADMIN.enabled) {
            return res.status(503).json({ error: '后台未启用：请在 config.yaml 中开启 admin 并设置密码。' });
        }
        if (!checkPassword(req.body && req.body.password)) {
            return res.status(401).json({ error: '后台密码错误。' });
        }
        const token = makeToken();
        res.setHeader('Set-Cookie',
            `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${Math.floor(SESSION_MS / 1000)}`);
        return res.json({ ok: true });
    });

    // 登出
    app.post('/admin/api/logout', (_req, res) => {
        res.setHeader('Set-Cookie',
            `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`);
        return res.json({ ok: true });
    });

    // 会话状态（页面用来判断显示登录框还是面板）
    app.get('/admin/api/session', (req, res) => {
        return res.json({ enabled: ADMIN.enabled, authed: ADMIN.enabled && isAuthed(req) });
    });

    // 用户列表
    app.get('/admin/api/users', requireAdmin, async (_req, res) => {
        try {
            const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));
            const list = users.map(u => ({
                handle: u.handle,
                name: u.name,
                admin: !!u.admin,
                enabled: u.enabled !== false,
                created: u.created || 0,
                hasPassword: !!u.password,
            }));
            list.sort((a, b) => (a.created || 0) - (b.created || 0));
            return res.json(list);
        } catch (err) {
            console.error('[后台] 用户列表失败:', err);
            return res.status(500).json({ error: '读取用户列表失败。' });
        }
    });

    // 创建用户
    app.post('/admin/api/users', requireAdmin, jsonParser, async (req, res) => {
        try {
            const { name, password, admin } = req.body || {};
            if (!name || !String(name).trim()) {
                return res.status(400).json({ error: '请填写显示名称。' });
            }
            const trimmedName = String(name).trim();
            const handle = slugify(trimmedName);
            if (!handle) {
                return res.status(400).json({ error: '名称需至少包含一个字母或数字。' });
            }
            if (handle === DEFAULT_USER_HANDLE) {
                return res.status(400).json({ error: '该名称为保留名称。' });
            }
            const existing = await storage.getItem(toKey(handle));
            if (existing) {
                return res.status(409).json({ error: `登录账号 "${handle}" 已存在。` });
            }
            let hashedPassword = '';
            let salt = '';
            if (password) {
                salt = getPasswordSalt();
                hashedPassword = getPasswordHash(String(password), salt);
            }
            const newUser = {
                handle, name: trimmedName, created: Date.now(),
                password: hashedPassword, salt, admin: !!admin, enabled: true,
            };
            await storage.setItem(toKey(handle), newUser);
            createUserDirectories(handle);
            seedDefaultContent(handle);
            console.log(`[后台] 创建用户: ${handle}`);
            return res.status(201).json({ handle });
        } catch (err) {
            console.error('[后台] 创建用户失败:', err);
            return res.status(500).json({ error: '创建用户失败。' });
        }
    });

    // 删除用户（?purge=true 同时删除数据目录）
    app.delete('/admin/api/users/:handle', requireAdmin, async (req, res) => {
        try {
            const handle = req.params.handle;
            if (handle === DEFAULT_USER_HANDLE) {
                return res.status(400).json({ error: '默认用户不可删除（系统回退账户）。' });
            }
            const user = await storage.getItem(toKey(handle));
            if (!user) return res.status(404).json({ error: '用户不存在。' });

            await storage.removeItem(toKey(handle));
            if (req.query.purge === 'true') {
                const dirs = getUserDirectories(handle);
                await fs.promises.rm(dirs.root, { recursive: true, force: true });
                console.log(`[后台] 删除用户及数据目录: ${handle}`);
            } else {
                console.log(`[后台] 删除用户(保留数据): ${handle}`);
            }
            return res.json({ ok: true });
        } catch (err) {
            console.error('[后台] 删除用户失败:', err);
            return res.status(500).json({ error: '删除用户失败。' });
        }
    });

    // 启用/禁用、提升/降级、改密码：合并到一个 PATCH
    app.patch('/admin/api/users/:handle', requireAdmin, jsonParser, async (req, res) => {
        try {
            const handle = req.params.handle;
            const user = await storage.getItem(toKey(handle));
            if (!user) return res.status(404).json({ error: '用户不存在。' });

            const body = req.body || {};

            if (typeof body.enabled === 'boolean') {
                if (handle === DEFAULT_USER_HANDLE && body.enabled === false) {
                    return res.status(400).json({ error: '默认用户不可禁用。' });
                }
                user.enabled = body.enabled;
            }
            if (typeof body.admin === 'boolean') {
                user.admin = body.admin;
            }
            if (Object.prototype.hasOwnProperty.call(body, 'password')) {
                if (body.password) {
                    const salt = getPasswordSalt();
                    user.password = getPasswordHash(String(body.password), salt);
                    user.salt = salt;
                } else {
                    // 清除密码
                    user.password = '';
                    user.salt = '';
                }
            }
            await storage.setItem(toKey(handle), user);
            console.log(`[后台] 更新用户: ${handle}`);
            return res.json({ ok: true });
        } catch (err) {
            console.error('[后台] 更新用户失败:', err);
            return res.status(500).json({ error: '更新用户失败。' });
        }
    });

    // 服务器状态
    app.get('/admin/api/status', requireAdmin, async (_req, res) => {
        try {
            const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));
            const online = await checkSillyTavernOnline(ST_HOST, ST_PORT);
            const size = await dirSize(DATA_ROOT);
            return res.json({
                sillyTavernOnline: online,
                sillyTavernUrl: `http://${ST_HOST}:${ST_PORT}`,
                userCount: users.length,
                adminCount: users.filter(u => u.admin).length,
                enabledCount: users.filter(u => u.enabled !== false).length,
                dataRoot: DATA_ROOT,
                dataSizeBytes: size,
            });
        } catch (err) {
            console.error('[后台] 状态获取失败:', err);
            return res.status(500).json({ error: '获取状态失败。' });
        }
    });

    // 获取网站外观设置
    app.get('/admin/api/site', requireAdmin, (_req, res) => {
        return res.json({ title: site.title || '', logo: site.logo || '' });
    });

    // 保存网站外观设置（写回 config.yaml）
    app.put('/admin/api/site', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if (typeof body.title === 'string') patch.title = body.title.trim();
            if (typeof body.logo === 'string') patch.logo = body.logo.trim();
            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: '没有可保存的内容。' });
            }
            saveSiteConfig(patch);
            console.log('[后台] 已更新网站外观设置');
            return res.json({ ok: true, title: site.title, logo: site.logo });
        } catch (err) {
            console.error('[后台] 保存网站设置失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });

    // 获取公告设置
    app.get('/admin/api/announce', requireAdmin, (_req, res) => {
        return res.json({
            enabled: !!announce.enabled,
            content: announce.content || '',
            frequency: announce.frequency || 'once',
        });
    });

    // 保存公告设置（写回 config.yaml）
    app.put('/admin/api/announce', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
            if (typeof body.content === 'string') patch.content = body.content;
            if (body.frequency === 'once' || body.frequency === 'always') patch.frequency = body.frequency;
            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: '没有可保存的内容。' });
            }
            saveAnnounceConfig(patch);
            console.log('[后台] 已更新公告设置');
            return res.json({
                ok: true,
                enabled: !!announce.enabled,
                content: announce.content,
                frequency: announce.frequency,
            });
        } catch (err) {
            console.error('[后台] 保存公告失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });

    // 获取注册设置（含当前人数）
    app.get('/admin/api/registration', requireAdmin, async (_req, res) => {
        try {
            const count = await countUsers();
            return res.json({ maxUsers: registration.maxUsers || 0, users: count });
        } catch (err) {
            console.error('[后台] 读取注册设置失败:', err);
            return res.status(500).json({ error: '读取失败。' });
        }
    });

    // 保存注册设置（写回 config.yaml）。maxUsers=0 表示不限。
    app.put('/admin/api/registration', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            let max = parseInt(body.maxUsers, 10);
            if (!Number.isFinite(max) || max < 0) max = 0;
            saveRegistrationConfig({ maxUsers: max });
            console.log('[后台] 已更新注册上限:', max || '不限');
            return res.json({ ok: true, maxUsers: registration.maxUsers });
        } catch (err) {
            console.error('[后台] 保存注册设置失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });

    // 获取备份/恢复配置
    app.get('/admin/api/backup-config', requireAdmin, (_req, res) => {
        try {
            return res.json({
                tempDir: backupTempConfig.tempDir || '',
                autoCleanupHours: backupTempConfig.autoCleanupHours || 24,
                currentTempDir: getTempDir(),
            });
        } catch (err) {
            console.error('[后台] 读取备份配置失败:', err);
            return res.status(500).json({ error: '读取失败。' });
        }
    });

    // 保存备份/恢复配置（写回 config.yaml）
    app.put('/admin/api/backup-config', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};

            if (typeof body.tempDir === 'string') {
                patch.tempDir = body.tempDir.trim();
            }

            if (typeof body.autoCleanupHours === 'number') {
                let hours = parseInt(body.autoCleanupHours, 10);
                if (!Number.isFinite(hours) || hours < 0) hours = 0;
                patch.autoCleanupHours = hours;
            }

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: '没有可保存的内容。' });
            }

            saveBackupConfig(patch);
            console.log('[后台] 已更新备份配置:', patch);
            return res.json({
                ok: true,
                tempDir: backupTempConfig.tempDir,
                autoCleanupHours: backupTempConfig.autoCleanupHours,
                currentTempDir: getTempDir(),
            });
        } catch (err) {
            console.error('[后台] 保存备份配置失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });

    // 获取 SillyTavern 路径配置
    app.get('/admin/api/st-config', requireAdmin, (_req, res) => {
        try {
            return res.json({
                path: sillyTavernConfig.path || '',
                currentPath: ST_DIR,
            });
        } catch (err) {
            console.error('[后台] 读取 SillyTavern 配置失败:', err);
            return res.status(500).json({ error: '读取失败。' });
        }
    });

    // 保存 SillyTavern 路径配置（写回 config.yaml）
    app.put('/admin/api/st-config', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};

            if (typeof body.path === 'string') {
                patch.path = body.path.trim();
            }

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: '没有可保存的内容。' });
            }

            saveSillyTavernConfig(patch);
            console.log('[后台] 已更新 SillyTavern 路径:', patch.path || '默认');
            return res.json({
                ok: true,
                path: patch.path,
                currentPath: ST_DIR,
            });
        } catch (err) {
            console.error('[后台] 保存 SillyTavern 配置失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });

    // 获取 SillyTavern config.yaml「傻瓜配置」当前值
    app.get('/admin/api/st-settings', requireAdmin, (_req, res) => {
        try {
            if (typeof readSillyTavernSettings !== 'function') {
                return res.status(500).json({ error: '服务未提供该功能。' });
            }
            return res.json(readSillyTavernSettings());
        } catch (err) {
            console.error('[后台] 读取 SillyTavern 配置失败:', err);
            return res.status(500).json({ error: '读取 SillyTavern config.yaml 失败：' + err.message });
        }
    });

    // 保存 SillyTavern config.yaml「傻瓜配置」（写回 SillyTavern 的 config.yaml）
    app.put('/admin/api/st-settings', requireAdmin, jsonParser, (req, res) => {
        try {
            if (typeof saveSillyTavernSettings !== 'function') {
                return res.status(500).json({ error: '服务未提供该功能。' });
            }
            // 直接把整个 body 交给写入函数；它按字段定义表逐项校验类型，忽略未知键。
            saveSillyTavernSettings(req.body || {});
            console.log('[后台] 已更新 SillyTavern config.yaml 傻瓜配置');
            return res.json({ ok: true, ...readSillyTavernSettings() });
        } catch (err) {
            console.error('[后台] 保存 SillyTavern 配置失败:', err);
            return res.status(500).json({ error: '保存失败：' + err.message });
        }
    });

    // 获取背景设置
    app.get('/admin/api/background', requireAdmin, (_req, res) => {
        return res.json({
            mode: background.mode || 'none',
            api: background.api || '',
            urls: background.urls || [],
            local: background.local || '',
            folder: background.folder || '',
            dim: background.dim,
            blur: background.blur,
        });
    });

    // 保存背景设置（写回 config.yaml）
    app.put('/admin/api/background', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if (['none', 'api', 'urls', 'local', 'folder'].includes(body.mode)) patch.mode = body.mode;
            if (typeof body.api === 'string') patch.api = body.api.trim();
            if (typeof body.local === 'string') patch.local = body.local.trim();
            if (typeof body.folder === 'string') patch.folder = body.folder.trim();
            if (typeof body.urls === 'string') {
                patch.urls = body.urls.split('\n').map(s => s.trim()).filter(Boolean);
            } else if (Array.isArray(body.urls)) {
                patch.urls = body.urls;
            }
            if (body.dim !== undefined) patch.dim = parseInt(body.dim, 10);
            if (body.blur !== undefined) patch.blur = parseInt(body.blur, 10);
            saveBackgroundConfig(patch);
            console.log('[后台] 已更新背景设置:', background.mode);
            return res.json({ ok: true, mode: background.mode });
        } catch (err) {
            console.error('[后台] 保存背景设置失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });

    // 获取卡片样式
    app.get('/admin/api/card', requireAdmin, (_req, res) => {
        return res.json({
            accent: card.accent, accent2: card.accent2,
            opacity: card.opacity, radius: card.radius, blur: card.blur,
            textColor: card.textColor, titleColor: card.titleColor,
            fontScale: card.fontScale, fontFamily: card.fontFamily,
        });
    });

    // 保存卡片样式（写回 config.yaml）
    app.put('/admin/api/card', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if (typeof body.accent === 'string') patch.accent = body.accent.trim();
            if (typeof body.accent2 === 'string') patch.accent2 = body.accent2.trim();
            if (body.opacity !== undefined) patch.opacity = parseInt(body.opacity, 10);
            if (body.radius !== undefined) patch.radius = parseInt(body.radius, 10);
            if (body.blur !== undefined) patch.blur = parseInt(body.blur, 10);
            if (typeof body.textColor === 'string') patch.textColor = body.textColor.trim();
            if (typeof body.titleColor === 'string') patch.titleColor = body.titleColor.trim();
            if (body.fontScale !== undefined) patch.fontScale = parseInt(body.fontScale, 10);
            if (typeof body.fontFamily === 'string') patch.fontFamily = body.fontFamily;
            saveCardConfig(patch);
            console.log('[后台] 已更新卡片样式');
            return res.json({ ok: true });
        } catch (err) {
            console.error('[后台] 保存卡片样式失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });

    // 获取友情链接
    app.get('/admin/api/friend-links', requireAdmin, (_req, res) => {
        return res.json({ enabled: !!friendLinks.enabled, links: friendLinks.links || [] });
    });

    // 保存友情链接（写回 config.yaml）
    app.put('/admin/api/friend-links', requireAdmin, jsonParser, (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
            if (Array.isArray(body.links)) patch.links = body.links;
            saveFriendLinksConfig(patch);
            console.log('[后台] 已更新友情链接:', friendLinks.links.length, '条');
            return res.json({ ok: true, count: friendLinks.links.length });
        } catch (err) {
            console.error('[后台] 保存友情链接失败:', err);
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 是否可写。' });
        }
    });
}
