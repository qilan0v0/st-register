/**
 * SillyTavern 进程托管 + 崩溃守护 + 更新模块
 *
 * 由 register-server 调用：init() 注入 SillyTavern 目录/端口等，start() 拉起进程，
 * 崩溃自动重启（退避），后台可 start/stop/restart，以及 update 到指定 git 版本。
 *
 * 纯 Node child_process + setTimeout 实现，无第三方进程管理依赖（pm2 等）。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';

const IS_WIN = process.platform === 'win32';
const MAX_LOG_LINES = 200;       // 环形日志缓存行数
const STABLE_MS = 60_000;        // 连续运行超过此时长视为「稳定」，重启计数清零
const MAX_RESTARTS = 5;          // 连续崩溃超过此次数则停在 crashed，不再自动重启
const MAX_BACKOFF_MS = 30_000;   // 退避上限

class STProcessManager {
    constructor() {
        this.child = null;
        this.status = 'stopped'; // stopped | starting | running | stopping | crashed | updating
        this.restartCount = 0;
        this.lastExitCode = null;
        this.manualStop = false;
        this.startedAt = 0;
        this.stableTimer = null;
        this.backoffTimer = null;
        this.logBuffer = [];

        // 由 init() 注入
        this.stDir = '';
        this.stHost = '127.0.0.1';
        this.stPort = 8000;
        this.entry = 'server.js';
    }

    init({ stDir, stHost, stPort, entry }) {
        this.stDir = stDir;
        if (stHost) this.stHost = stHost;
        if (stPort) this.stPort = stPort;
        if (entry) this.entry = entry;
    }

    _log(line) {
        const text = String(line).replace(/\r?\n$/, '');
        for (const part of text.split(/\r?\n/)) {
            this.logBuffer.push(part);
            // 转发到主进程，带 [ST] 前缀便于区分
            console.log('[ST] ' + part);
        }
        if (this.logBuffer.length > MAX_LOG_LINES) {
            this.logBuffer.splice(0, this.logBuffer.length - MAX_LOG_LINES);
        }
    }

    getLogs() {
        return this.logBuffer.slice();
    }

    getStatus() {
        return {
            status: this.status,
            pid: this.child ? this.child.pid : null,
            restartCount: this.restartCount,
            lastExitCode: this.lastExitCode,
            uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
        };
    }

    isRunning() {
        return this.status === 'running' || this.status === 'starting';
    }

    // 探测内部端口是否已被（别的进程）占用
    _portInUse() {
        return new Promise((resolve) => {
            const req = http.request(
                { host: this.stHost, port: this.stPort, method: 'HEAD', path: '/', timeout: 1500 },
                (res) => { res.resume(); resolve(true); },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    async start() {
        if (this.child) return { ok: true, message: '已在运行' };
        if (!this.stDir) return { ok: false, message: '未配置 SillyTavern 目录' };

        // 端口已被别的进程占用 → 不重复拉起，仅作守护监测
        if (await this._portInUse()) {
            this._log(`端口 ${this.stPort} 已被占用，跳过自动启动（仅监测）。如需托管请先停掉外部 SillyTavern。`);
            this.status = 'running';
            this.startedAt = Date.now();
            return { ok: true, message: '端口已被占用，按外部已运行处理' };
        }

        this.manualStop = false;
        this.status = 'starting';
        this._log(`启动 SillyTavern: ${process.execPath} ${this.entry} (cwd=${this.stDir})`);

        try {
            const child = spawn(process.execPath, [this.entry], {
                cwd: this.stDir,
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            this.child = child;
            this.startedAt = Date.now();
            this.status = 'running';

            child.stdout.on('data', (d) => this._log(d.toString()));
            child.stderr.on('data', (d) => this._log(d.toString()));

            // 稳定运行超过 STABLE_MS → 重启计数清零
            if (this.stableTimer) clearTimeout(this.stableTimer);
            this.stableTimer = setTimeout(() => { this.restartCount = 0; }, STABLE_MS);

            child.on('exit', (code, signal) => {
                this.lastExitCode = (code != null ? code : signal);
                this.child = null;
                if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
                this._log(`进程退出 (code=${code}, signal=${signal})`);

                // 人为停止 / 更新中 → 不自动重启
                if (this.manualStop || this.status === 'stopping' || this.status === 'updating') {
                    if (this.status !== 'updating') this.status = 'stopped';
                    return;
                }

                // 崩溃 → 退避重启
                this.status = 'crashed';
                this.restartCount++;
                if (this.restartCount > MAX_RESTARTS) {
                    this._log(`连续崩溃 ${this.restartCount - 1} 次，停止自动重启，请到后台手动启动或查看日志。`);
                    return;
                }
                const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, this.restartCount - 1));
                this._log(`将在 ${Math.round(delay / 1000)}s 后自动重启（第 ${this.restartCount} 次）...`);
                this.backoffTimer = setTimeout(() => { this.start(); }, delay);
            });

            child.on('error', (err) => {
                this._log('进程错误: ' + err.message);
                this.child = null;
                this.status = 'crashed';
            });

            return { ok: true, message: '已启动' };
        } catch (err) {
            this.status = 'crashed';
            this._log('启动失败: ' + err.message);
            return { ok: false, message: '启动失败: ' + err.message };
        }
    }

    _killTree() {
        return new Promise((resolve) => {
            const child = this.child;
            if (!child || child.pid == null) return resolve();
            if (IS_WIN) {
                // Windows 下 child.kill() 杀不掉派生子进程，用 taskkill 杀整棵树
                try {
                    const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
                    tk.on('exit', () => resolve());
                    tk.on('error', () => { try { child.kill(); } catch {} resolve(); });
                } catch {
                    try { child.kill(); } catch {}
                    resolve();
                }
            } else {
                try { child.kill('SIGTERM'); } catch {}
                resolve();
            }
        });
    }

    async stop() {
        if (this.backoffTimer) { clearTimeout(this.backoffTimer); this.backoffTimer = null; }
        if (!this.child) {
            if (this.status !== 'updating') this.status = 'stopped';
            return { ok: true, message: '未在运行' };
        }
        this.manualStop = true;
        this.status = (this.status === 'updating') ? 'updating' : 'stopping';
        this._log('正在停止 SillyTavern...');

        const exited = new Promise((resolve) => {
            const child = this.child;
            if (!child) return resolve();
            const t = setTimeout(resolve, 8000); // 兜底超时
            child.on('exit', () => { clearTimeout(t); resolve(); });
        });
        await this._killTree();
        await exited;
        this.child = null;
        if (this.status !== 'updating') this.status = 'stopped';
        this._log('已停止。');
        return { ok: true, message: '已停止' };
    }

    async restart() {
        await this.stop();
        // 稍等端口释放
        await new Promise((r) => setTimeout(r, 800));
        return this.start();
    }

    // ── 更新 ──────────────────────────────────────────────────────────────────
    // onProgress(line): 实时把 git/npm 输出推给调用方（用于 SSE）。
    async update({ ref, onProgress } = {}) {
        const emit = (line) => { try { onProgress && onProgress(line); } catch {} };
        if (!this.stDir) return { ok: false, message: '未配置 SillyTavern 目录' };

        this.status = 'updating';
        try {
            emit('准备更新：先停止 SillyTavern...');
            await this.stop();
            this.status = 'updating'; // stop 可能把状态改成 stopped，这里恢复

            emit('git fetch --all --tags --prune ...');
            await this._run('git', ['fetch', '--all', '--tags', '--prune'], emit);

            if (ref && ref !== '__latest__') {
                emit(`git checkout ${ref} ...`);
                await this._run('git', ['checkout', ref], emit);
                // 若是分支，再 ff 拉一下最新
                try {
                    emit('git pull --ff-only ...');
                    await this._run('git', ['pull', '--ff-only'], emit);
                } catch {
                    emit('（当前为 tag/分离头，跳过 pull）');
                }
            } else {
                emit('git pull --ff-only ...（更新当前分支到最新）');
                await this._run('git', ['pull', '--ff-only'], emit);
            }

            emit('npm install --no-audit --no-fund ...（耗时较长，请耐心等待）');
            await this._run(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], emit);

            emit('更新完成，正在重启 SillyTavern...');
            this.status = 'stopped';
            this.restartCount = 0;
            const r = await this.start();
            emit(r.ok ? '✅ 重启成功，更新生效。' : ('⚠️ 重启失败：' + r.message));
            return { ok: true, message: '更新完成' };
        } catch (err) {
            emit('❌ 更新失败：' + err.message);
            // 尽量把服务拉回来
            try {
                this.status = 'stopped';
                await this.start();
                emit('已尝试用现有版本重新启动。');
            } catch {}
            return { ok: false, message: '更新失败：' + err.message };
        } finally {
            // 兜底：若仍卡在 updating（start 未改写状态），按已停止处理，避免状态僵死
            if (this.status === 'updating') this.status = this.child ? 'running' : 'stopped';
        }
    }

    // spawn 一个命令，cwd=stDir，实时把 stdout/stderr 推给 emit；失败 reject。
    _run(cmd, args, emit) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = spawn(cmd, args, { cwd: this.stDir, env: { ...process.env }, windowsHide: true });
            } catch (e) {
                return reject(e);
            }
            const onData = (d) => {
                const s = d.toString();
                for (const line of s.split(/\r?\n/)) {
                    if (line.trim()) emit(line);
                }
            };
            proc.stdout.on('data', onData);
            proc.stderr.on('data', onData);
            proc.on('error', (err) => reject(new Error(`${cmd} 启动失败: ${err.message}`)));
            proc.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`));
            });
        });
    }

    // 列出可选版本：tags + 分支 + 当前 ref
    listVersions() {
        return new Promise((resolve) => {
            const result = { tags: [], branches: [], current: '' };
            if (!this.stDir) return resolve(result);
            const run = (args) => new Promise((res) => {
                let out = '';
                const p = spawn('git', args, { cwd: this.stDir, windowsHide: true });
                p.stdout.on('data', (d) => out += d.toString());
                p.on('error', () => res(''));
                p.on('exit', () => res(out));
            });
            Promise.all([
                run(['tag', '-l', '--sort=-v:refname']),
                run(['branch', '-r']),
                run(['describe', '--tags', '--always']),
                run(['rev-parse', '--abbrev-ref', 'HEAD']),
            ]).then(([tagsOut, branchesOut, describeOut, headOut]) => {
                result.tags = tagsOut.split('\n').map((s) => s.trim()).filter(Boolean);
                result.branches = branchesOut.split('\n')
                    .map((s) => s.trim().replace(/^origin\//, ''))
                    .filter((s) => s && !s.includes('->'));
                // 去重分支
                result.branches = [...new Set(result.branches)];
                const head = (headOut || '').trim();
                const desc = (describeOut || '').trim();
                result.current = (head && head !== 'HEAD') ? head : desc;
                resolve(result);
            });
        });
    }
}

export const stProcess = new STProcessManager();
