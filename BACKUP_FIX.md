# 备份进度条优化修复说明

## 问题描述

备份数据时，进度条会卡在以下两个位置：
1. **压缩阶段**：进度到"正在压缩数据... 23.5 MB / 23.5 MB"就不动了
2. **Git 推送阶段**：进度到"正在推送到远程仓库..."后长时间无响应

## 根本原因

### 问题 1：压缩完成后卡住

**原代码问题**：
```javascript
archive.pipe(output);
archive.directory(userDataDir, false);
await archive.finalize();  // 等待压缩完成

await new Promise((resolve, reject) => {
    output.on('close', resolve);  // 此时 close 事件可能已经触发过了
    output.on('error', reject);
});
```

- `archive.finalize()` 完成后，输出流的 `close` 事件可能已经触发
- 之后再设置 `output.on('close')` 监听器时，事件已经错过
- 导致 Promise 永远不会 resolve，程序卡住

### 问题 2：Git LFS 推送时无进度

**原代码问题**：
```javascript
execSync('git push origin master', { cwd: tempGitDir, stdio: 'pipe' });
```

- 使用 `execSync` 同步执行，会阻塞整个进程
- `stdio: 'pipe'` 会隐藏所有输出，无法获取 Git LFS 的上传进度
- 推送大文件时用户看不到任何反馈，以为程序卡死了

## 解决方案

### 修复 1：压缩流事件监听顺序

**修复后的代码**：
```javascript
// 先设置 close 事件监听器，再开始压缩
const compressionPromise = new Promise((resolve, reject) => {
    output.on('close', () => {
        console.log('[备份] 压缩流已关闭');
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
```

**关键改进**：
- 在调用 `archive.finalize()` **之前**就创建 Promise 并设置事件监听器
- 确保在 close 事件触发时，监听器已经就位
- 添加了日志输出，便于调试

### 修复 2：使用 spawn 实时捕获 Git 推送进度

**修复后的代码**：
```javascript
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
        console.log('[备份] Git 输出:', output);

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
            console.log('[备份] 推送成功');
            resolve();
        } else {
            reject(new Error(`git push 失败，退出码: ${code}`));
        }
    });

    gitPush.on('error', (err) => {
        reject(err);
    });
});
```

**关键改进**：
- 使用 `spawn` 替代 `execSync`，异步执行不阻塞
- 实时捕获 stderr 输出（Git LFS 进度信息在这里）
- 解析 Git LFS 的百分比进度并更新前端进度条
- 将 Git LFS 的 0-100% 映射到总进度的 80-95%
- 添加详细的日志输出

## 修改的文件

- `register-server.js`
  - 第 22 行：导入 `spawn` 函数
  - 第 2659-2674 行：修复压缩流事件监听顺序
  - 第 2761-2809 行：使用 spawn 实时捕获 Git 推送进度

## 测试建议

1. **测试压缩阶段**：
   - 备份一个较大的数据目录（>20MB）
   - 观察进度条是否从"正在压缩数据..."顺利过渡到"压缩完成"

2. **测试 Git 推送阶段**：
   - 备份到魔搭社区数据集
   - 观察进度条是否显示"正在推送到远程仓库... X%"
   - 查看服务器控制台是否有 Git LFS 的详细输出

3. **测试完整流程**：
   - 从注册 → 备份 → 恢复，确保整个流程顺畅
   - 检查进度条是否在每个阶段都有更新

## 预期效果

修复后，备份流程的进度条应该：
1. ✅ 压缩阶段：显示实时的 MB 进度，完成后立即进入下一阶段
2. ✅ Git 推送阶段：显示 Git LFS 的上传百分比，不再卡住
3. ✅ 整个流程：从 0% 顺利推进到 100%，用户体验流畅

## 技术要点

### Node.js 流事件处理
- 必须在流操作开始**之前**设置事件监听器
- `close` 事件只触发一次，错过就无法再捕获

### Git LFS 进度解析
- Git LFS 的进度信息输出到 stderr（不是 stdout）
- 进度格式：`Uploading LFS objects: XX% (n/total), size | speed`
- 需要用正则表达式提取百分比

### 异步进程管理
- `execSync` 会阻塞整个 Node.js 事件循环
- `spawn` 是异步的，可以实时处理输出
- 使用 Promise 包装 spawn 使其可以 await

## 日期

2026-05-31
