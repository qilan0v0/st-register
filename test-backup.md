# 测试备份功能

## 步骤

1. 重启服务器：`node register-server.js`

2. 登录账号

3. 进入 dashboard

4. 填写魔搭配置：
   - Token: 你的魔搭 Access Token
   - 数据集: 用户名/数据集名（例如：zhangsan/st-backup）

5. 点击"备份数据"按钮

6. 查看服务器控制台输出，应该会看到类似这样的日志：
   ```
   [备份] 收到备份请求
   [备份] 数据集: zhangsan/st-backup
   [备份] 用户: your-username
   [备份] 用户数据目录: E:\A\ST2\SillyTavern\data\your-username
   [备份] 创建临时文件: E:\A\ST2\st-register\backup-your-username-1234567890.zip
   [备份] 已创建备份文件: ... (XX MB)
   [备份] 创建临时 Git 目录: ...
   [备份] 正在克隆数据集: zhangsan/st-backup
   ...
   ```

7. 如果出现错误，查看具体的错误信息

## 常见问题

### 问题1：一直转圈，没有任何反应

**可能原因**：
- 浏览器控制台有 JavaScript 错误
- 后端没有收到请求
- 请求被阻塞

**排查方法**：
1. 打开浏览器开发者工具（F12）
2. 切换到 Console 标签，查看是否有错误
3. 切换到 Network 标签，点击备份按钮，查看是否有 `/api/backup` 请求
4. 查看服务器控制台是否有 `[备份] 收到备份请求` 日志

### 问题2：提示 Git 相关错误

**解决方法**：
确保已安装 Git 和 Git LFS：
```bash
git --version
git lfs version
```

如果没有安装，请先安装：
- Windows: 下载 Git for Windows (https://git-scm.com/download/win)
- Linux: `sudo apt-get install git git-lfs && git lfs install`
- macOS: `brew install git git-lfs && git lfs install`

### 问题3：提示数据集不存在或无权限

**解决方法**：
1. 确认已在魔搭社区创建数据集
2. 确认数据集名称格式正确：`用户名/数据集名`
3. 确认 Access Token 有效且有写入权限

### 问题4：克隆仓库失败

**可能原因**：
- Token 无效
- 数据集不存在
- 网络问题

**解决方法**：
手动测试 Git 克隆：
```bash
git clone https://oauth2:YOUR_TOKEN@www.modelscope.cn/datasets/USERNAME/DATASET.git
```

如果手动克隆成功，说明配置正确，问题可能在代码中。
