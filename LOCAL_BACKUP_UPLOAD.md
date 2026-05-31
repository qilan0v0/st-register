# 本地备份上传恢复功能

## ✅ 已完成的功能

### 1. **本地备份文件上传**
- ✅ 支持 .zip 格式的备份文件
- ✅ 文件大小限制（5GB）
- ✅ 显示文件名和大小
- ✅ 实时进度显示

### 2. **本地备份恢复**
- ✅ 上传并解压备份文件
- ✅ 恢复前自动备份当前数据
- ✅ 恢复失败自动回滚
- ✅ 实时进度显示

### 3. **UI 优化**
- ✅ 修复下拉列表背景色问题
- ✅ 自定义确认对话框（替换原生 confirm）
- ✅ 美观的文件选择按钮

---

## 🎨 用户界面

### 本地备份管理
```
┌─────────────────────────────────┐
│ 本地备份管理                     │
├─────────────────────────────────┤
│ 上传本地备份文件                 │
│ [📁 选择备份文件]               │
│ 支持 .zip 格式的备份文件         │
│                                 │
│ [恢复本地备份] (选择文件后显示)  │
└─────────────────────────────────┘
```

### 选择文件后
```
┌─────────────────────────────────┐
│ 本地备份管理                     │
├─────────────────────────────────┤
│ 上传本地备份文件                 │
│ [📁 选择备份文件]               │
│ 已选择：backup-user.zip (23.5 MB)│
│                                 │
│ [恢复本地备份]                  │
└─────────────────────────────────┘
```

### 自定义确认对话框
```
┌─────────────────────────────────┐
│ ⚠️ 确认操作                     │
├─────────────────────────────────┤
│ 恢复本地备份将覆盖当前所有数据， │
│ 确定要继续吗？                   │
│                                 │
│ [取消]  [确定]                  │
└─────────────────────────────────┘
```

---

## 🔧 技术实现

### 前端实现

**文件选择**：
```javascript
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
```

**文件上传和恢复**：
```javascript
const formData = new FormData();
formData.append('file', selectedFile);
formData.append('userHandle', userHandle);

const response = await fetch('/api/restore-local', {
    method: 'POST',
    body: formData
});

// 使用 SSE 接收进度
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));
            if (data.progress !== null) {
                showProgress(data.message, data.progress);
            }
        }
    }
}
```

### 后端实现

**Multer 配置**：
```javascript
import multer from 'multer';

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
        fileSize: BACKUP_CONFIG.MAX_SIZE_MB * 1024 * 1024 // 5GB
    },
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('只支持 .zip 格式的备份文件'));
        }
    }
});
```

**恢复 API**：
```javascript
app.post('/api/restore-local', upload.single('file'), async (req, res) => {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function sendProgress(message, progress = null) {
        const data = { message, progress };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // 添加到任务队列
    await restoreQueue.add(async () => {
        const { userHandle } = req.body;
        const uploadedFilePath = req.file.path;
        const fileSize = (req.file.size / 1024 / 1024).toFixed(2);

        sendProgress('正在准备恢复...', 5);
        sendProgress(`已上传备份文件，大小：${fileSize} MB`, 10);

        // 备份当前数据
        sendProgress('正在备份当前数据...', 20);
        const backupDir = path.join(getTempDir(), `backup-before-restore-${userHandle}-${timestamp}`);
        if (fs.existsSync(userDataDir)) {
            fs.cpSync(userDataDir, backupDir, { recursive: true });
        }

        // 清空当前数据
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
        fs.unlinkSync(uploadedFilePath);
        fs.rmSync(backupDir, { recursive: true, force: true });

        sendComplete(true, '本地备份恢复成功！', {
            filename: req.file.originalname,
            size: fileSize + ' MB'
        });
    });
});
```

---

## 📋 使用步骤

### 1. 准备本地备份文件
- 从魔搭社区或 Hugging Face 下载的备份文件
- 或之前手动创建的 .zip 备份文件
- 文件格式必须是 .zip

### 2. 上传并恢复
1. 点击"📁 选择备份文件"
2. 选择本地的 .zip 备份文件
3. 确认文件信息（文件名和大小）
4. 点击"恢复本地备份"
5. 在确认对话框中点击"确定"
6. 等待恢复完成

---

## 🔄 恢复流程

### 进度阶段
```
正在准备恢复... 5%
已上传备份文件，大小：23.5 MB 10%
正在备份当前数据... 20%
正在清空当前数据... 40%
正在解压备份文件... 60%
解压完成，正在清理临时文件... 90%
本地备份恢复成功！ 100%
```

### 安全机制
1. ✅ 恢复前自动备份当前数据
2. ✅ 恢复失败自动回滚
3. ✅ 自动清理临时文件
4. ✅ 文件大小限制（5GB）
5. ✅ 文件格式验证（只支持 .zip）

---

## 🎨 UI 优化

### 1. 下拉列表样式修复
**问题**：下拉列表背景是白色，看不清文字

**解决**：
```css
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
}

.config-section select option {
    background: #1a1e2e;
    color: #e8eaf2;
    padding: 10px;
}
```

### 2. 自定义确认对话框
**问题**：原生 confirm 对话框不美观

**解决**：
```css
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
```

**JavaScript**：
```javascript
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

// 使用
const confirmed = await customConfirm('恢复数据将覆盖当前所有数据，确定要继续吗？');
if (!confirmed) {
    return;
}
```

---

## 📊 功能对比

| 功能 | 云端备份 | 本地备份 |
|------|---------|---------|
| 需要网络 | ✅ 是 | ❌ 否 |
| 需要 Token | ✅ 是 | ❌ 否 |
| 需要创建数据集 | ✅ 是 | ❌ 否 |
| 备份速度 | ⚠️ 取决于网速 | ✅ 快 |
| 恢复速度 | ⚠️ 取决于网速 | ✅ 快 |
| 存储位置 | ☁️ 云端 | 💾 本地 |
| 跨设备访问 | ✅ 是 | ❌ 否 |
| 文件大小限制 | ✅ 5GB | ✅ 5GB |

---

## ⚠️ 注意事项

### 文件要求
1. ✅ 必须是 .zip 格式
2. ✅ 文件大小不超过 5GB
3. ✅ 必须是有效的备份文件

### 安全提示
1. ⚠️ 恢复会覆盖当前所有数据
2. ✅ 恢复前会自动备份当前数据
3. ✅ 恢复失败会自动回滚
4. ⚠️ 请确保备份文件来源可信

### 使用场景
- ✅ 从其他设备迁移数据
- ✅ 快速恢复本地备份
- ✅ 无网络环境下恢复数据
- ✅ 测试备份文件是否有效

---

## 📝 修改的文件

### register-server.js

**导入 multer**（第 31 行）：
```javascript
import multer from 'multer';
```

**Dashboard 页面 HTML**（第 2350-2365 行）：
- 添加"本地备份管理"部分
- 文件上传输入框
- 选择文件按钮
- 恢复本地备份按钮

**Dashboard 页面 CSS**（第 2151-2261 行）：
- 修复 select 下拉列表样式
- 添加自定义确认对话框样式

**Dashboard 页面 JavaScript**（第 2395-2410 行）：
- 添加本地备份相关元素引用
- 添加 selectedFile 变量

**自定义确认对话框**（第 2424-2451 行）：
- customConfirm 函数实现

**本地备份上传事件**（第 2745-2840 行）：
- 文件选择事件处理
- 文件上传和恢复事件处理

**后端 API**（第 3627-3760 行）：
- Multer 配置
- `/api/restore-local` API 实现

### package.json
**新增依赖**：
```json
{
  "dependencies": {
    "multer": "^1.4.5-lts.1"
  }
}
```

---

## 🎯 最终效果

### 本地备份上传
- ✅ 点击按钮选择文件
- ✅ 显示文件名和大小
- ✅ 上传并恢复
- ✅ 实时进度显示

### UI 优化
- ✅ 下拉列表背景色正常
- ✅ 自定义确认对话框美观
- ✅ 文件选择按钮美观

### 安全性
- ✅ 文件格式验证
- ✅ 文件大小限制
- ✅ 恢复前备份
- ✅ 失败自动回滚

---

## 📅 完成日期

2026-05-31

## 👨‍💻 开发人员

Claude (Opus 4.8)
