# 备份恢复详细日志输出

## ✅ 已完成的功能

### 1. **备份功能详细日志**
- ✅ 克隆仓库日志（stdout/stderr）
- ✅ Git LFS 配置日志
- ✅ 文件复制日志
- ✅ Git 提交日志
- ✅ Git 推送日志（实时输出）
- ✅ 错误详细信息

### 2. **恢复功能详细日志**
- ✅ 克隆仓库日志
- ✅ Git LFS 下载日志
- ✅ 备份文件查找日志
- ✅ 当前数据备份日志
- ✅ 解压日志
- ✅ 清理日志

---

## 📋 备份日志输出

### 完整备份流程日志

```
[备份] 克隆仓库: username/st-backup
[备份] 克隆输出: Cloning into '/tmp/git-temp-user-1234567890'...
[备份] 配置 Git LFS...
[备份] Git LFS 安装成功
[备份] Git 用户信息配置成功
[备份] 备份文件已复制: backup-user.zip (23.5 MB)
[备份] 配置 LFS 跟踪 *.zip 文件...
[备份] 添加文件到 Git...
[备份] 文件已添加到 Git
[备份] 提交更改: Backup for user at 2026-05-31T12:00:00.000Z
[备份] 提交输出: [master abc1234] Backup for user at 2026-05-31T12:00:00.000Z
 2 files changed, 1 insertion(+)
 create mode 100644 backup-user.zip
[备份] 开始推送到远程仓库...
[备份] git push stdout: 
[备份] git push stderr: Uploading LFS objects:   0% (0/1), 0 B | 0 B/s
[备份] git push stderr: Uploading LFS objects:  50% (1/2), 10 MB | 1.2 MB/s
[备份] git push stderr: Uploading LFS objects: 100% (2/2), 23 MB | 1.5 MB/s
[备份] git push 退出码: 0
[备份] 推送成功
```

### 备份失败日志

```
[备份] 克隆仓库: username/st-backup
[备份] 克隆失败: Command failed: git clone --depth 1 "https://..." "/tmp/..."
[备份] 克隆 stderr: fatal: repository 'https://...' not found
[备份] 克隆 stdout: 
[备份] Git 操作失败: 克隆仓库失败：Command failed: git clone...
```

### Git 推送失败日志

```
[备份] 开始推送到远程仓库...
[备份] git push stdout: 
[备份] git push stderr: remote: Permission denied
[备份] git push stderr: fatal: unable to access 'https://...': The requested URL returned error: 403
[备份] git push 退出码: 1
[备份] git push 失败
[备份] stdout: 
[备份] stderr: remote: Permission denied
fatal: unable to access 'https://...': The requested URL returned error: 403
[备份] Git 操作失败: git push 失败，退出码: 1
stderr: remote: Permission denied
fatal: unable to access 'https://...': The requested URL returned error: 403
```

---

## 📋 恢复日志输出

### 完整恢复流程日志

```
[恢复] 克隆仓库: username/st-backup
[恢复] 克隆输出: Cloning into '/tmp/git-restore-user-1234567890'...
[恢复] 配置 Git LFS...
[恢复] Git LFS 安装成功
[恢复] 开始下载 LFS 文件...
[恢复] git lfs pull stdout: 
[恢复] git lfs pull stderr: Downloading LFS objects:   0% (0/1), 0 B | 0 B/s
[恢复] git lfs pull stderr: Downloading LFS objects:  50% (1/2), 10 MB | 2.5 MB/s
[恢复] git lfs pull stderr: Downloading LFS objects: 100% (2/2), 23 MB | 3.0 MB/s
[恢复] git lfs pull 退出码: 0
[恢复] LFS 文件下载成功
[恢复] 查找备份文件: backup-user.zip
[恢复] 找到备份文件: backup-user.zip (23.5 MB)
[恢复] 备份当前数据到: /tmp/backup-before-restore-user-1234567890
[恢复] 当前数据备份完成
[恢复] 清空当前数据目录: /data/SillyTavern/data/user
[恢复] 数据目录已清空
[恢复] 解压备份文件到: /data/SillyTavern/data/user
[恢复] 解压完成
[恢复] 清理临时文件...
[恢复] 临时文件清理完成
[恢复] 恢复成功！
```

### 恢复失败日志

```
[恢复] 克隆仓库: username/st-backup
[恢复] 克隆输出: Cloning into '/tmp/git-restore-user-1234567890'...
[恢复] 配置 Git LFS...
[恢复] Git LFS 安装成功
[恢复] 开始下载 LFS 文件...
[恢复] git lfs pull 退出码: 0
[恢复] LFS 文件下载成功
[恢复] 查找备份文件: backup-user.zip
[恢复] 未找到备份文件: /tmp/git-restore-user-1234567890/backup-user.zip
[恢复] 错误: 未找到备份文件: backup-user.zip
```

---

## 🔍 日志详细程度

### 备份阶段日志

| 阶段 | 日志内容 |
|------|---------|
| 克隆仓库 | 仓库名称、克隆输出、错误信息 |
| Git LFS 配置 | 安装状态、用户信息配置 |
| 文件复制 | 文件名、文件大小 |
| LFS 跟踪 | 跟踪规则 |
| Git 添加 | 添加的文件 |
| Git 提交 | 提交消息、提交输出 |
| Git 推送 | 实时 stdout/stderr、退出码 |

### 恢复阶段日志

| 阶段 | 日志内容 |
|------|---------|
| 克隆仓库 | 仓库名称、克隆输出 |
| Git LFS 配置 | 安装状态 |
| LFS 下载 | 实时下载进度、退出码 |
| 查找备份 | 文件名、文件路径 |
| 备份当前数据 | 备份目录路径 |
| 清空数据 | 数据目录路径 |
| 解压文件 | 解压目标路径 |
| 清理临时文件 | 清理状态 |

---

## 🐛 错误诊断

### 常见错误及日志

#### 1. 仓库不存在

**日志**：
```
[备份] 克隆失败: Command failed: git clone...
[备份] 克隆 stderr: fatal: repository 'https://...' not found
```

**原因**：
- 数据集不存在
- 数据集名称错误
- 数据集是私有的但 Token 无权限

**解决**：
- 检查数据集名称格式（username/dataset-name）
- 确认数据集已创建
- 检查 Token 权限

#### 2. Token 权限不足

**日志**：
```
[备份] git push stderr: remote: Permission denied
[备份] git push stderr: fatal: unable to access 'https://...': The requested URL returned error: 403
[备份] git push 退出码: 1
```

**原因**：
- Token 没有 write 权限
- Token 已过期
- Token 不正确

**解决**：
- 重新生成 Token（确保有 write 权限）
- 检查 Token 是否正确复制

#### 3. Git LFS 未安装

**日志**：
```
[备份] Git LFS 安装失败: Command failed: git lfs install
[备份] LFS stderr: git: 'lfs' is not a git command
```

**原因**：
- 服务器未安装 Git LFS

**解决**：
```bash
# Ubuntu/Debian
sudo apt-get install git-lfs

# CentOS/RHEL
sudo yum install git-lfs

# macOS
brew install git-lfs
```

#### 4. 网络问题

**日志**：
```
[备份] git push stderr: fatal: unable to access 'https://...': Could not resolve host
```

**原因**：
- 网络连接问题
- DNS 解析失败
- 防火墙阻止

**解决**：
- 检查网络连接
- 检查 DNS 设置
- 检查防火墙规则

#### 5. 备份文件不存在

**日志**：
```
[恢复] 未找到备份文件: /tmp/git-restore-user-1234567890/backup-user.zip
```

**原因**：
- 数据集中没有备份文件
- 备份文件名不匹配
- LFS 文件未下载

**解决**：
- 先执行一次备份
- 检查数据集中是否有 backup-{username}.zip 文件

---

## 📊 日志级别

### 正常日志（INFO）

```
[备份] 克隆仓库: username/st-backup
[备份] Git LFS 安装成功
[备份] 备份文件已复制: backup-user.zip (23.5 MB)
[备份] 推送成功
```

### 错误日志（ERROR）

```
[备份] 克隆失败: Command failed: git clone...
[备份] 克隆 stderr: fatal: repository not found
[备份] Git 操作失败: 克隆仓库失败
```

### 调试日志（DEBUG）

```
[备份] 克隆输出: Cloning into '/tmp/...'
[备份] 提交输出: [master abc1234] Backup for user...
[备份] git push stdout: 
[备份] git push stderr: Uploading LFS objects: 50%
```

---

## 🔧 查看日志

### 启动服务时查看日志

```bash
node register-server.js
```

### 使用 PM2 查看日志

```bash
# 实时查看日志
pm2 logs st-register

# 查看错误日志
pm2 logs st-register --err

# 查看最近 100 行日志
pm2 logs st-register --lines 100
```

### 重定向日志到文件

```bash
# 启动时重定向
node register-server.js > logs/output.log 2>&1

# 或使用 tee 同时输出到终端和文件
node register-server.js 2>&1 | tee logs/output.log
```

---

## 📝 修改的文件

### register-server.js

**备份 - 克隆仓库**（第 3389-3404 行）：
- 添加克隆日志
- 输出 stdout/stderr

**备份 - Git LFS 配置**（第 3406-3418 行）：
- 添加配置日志
- 输出错误信息

**备份 - 文件操作**（第 3420-3432 行）：
- 添加文件复制日志
- 添加 LFS 跟踪日志
- 添加 Git 添加日志

**备份 - Git 提交**（第 3434-3448 行）：
- 添加提交日志
- 输出提交结果

**备份 - Git 推送**（第 3450-3502 行）：
- 实时输出 stdout/stderr
- 输出退出码
- 详细错误信息

**恢复 - 文件查找**（第 3687-3697 行）：
- 添加查找日志
- 输出文件信息

**恢复 - 数据备份**（第 3699-3709 行）：
- 添加备份日志
- 输出备份路径

**恢复 - 解压恢复**（第 3711-3730 行）：
- 添加解压日志
- 添加清理日志

---

## 🎯 最终效果

### 备份成功
- ✅ 每个步骤都有日志输出
- ✅ 实时显示 Git 推送进度
- ✅ 显示文件大小和状态

### 备份失败
- ✅ 详细的错误信息
- ✅ stdout 和 stderr 输出
- ✅ 退出码显示

### 恢复成功
- ✅ 每个步骤都有日志输出
- ✅ 实时显示下载进度
- ✅ 显示文件路径和状态

### 恢复失败
- ✅ 详细的错误信息
- ✅ 文件路径显示
- ✅ 清晰的错误原因

---

## 📅 完成日期

2026-05-31

## 👨‍💻 开发人员

Claude (Opus 4.8)
