# 齐鲁工业大学图书馆座位预约 CMD 助手

这是一个本地运行的单用户 CMD 小工具，用来辅助查询和预约齐鲁工业大学图书馆座位。

程序不会保存校园网密码，不包含验证码绕过功能。是否预约成功以学校接口返回结果为准。

## 启动

在项目目录打开 PowerShell 或 CMD，运行：

```powershell
npm start
```

也可以直接双击：

```text
QLU-LIB-CMD.bat
```

如果自动打开 CAS 登录页时报 Chromium 缺失，先安装 Playwright 浏览器运行环境：

```powershell
python -m pip install playwright
python -m playwright install chromium
```

## 登录和 token

学校当前使用 CAS / 统一认证登录。CMD 程序不会保存你的账号密码。

在主菜单选择：

```text
1. 自动打开 CAS 获取 token
```

然后在弹出的浏览器里完成学校统一认证登录。登录成功后，程序会检测网页里的 `sessionStorage.token`，并自动导入到 CMD 程序。

token 会保存在本地 `.qlu-token.json`，下次启动会自动读取。需要清除时，在主菜单选择：

```text
4. 清除本地 token
```

程序会先检查 JWT 的 `exp` 过期时间，再用需要登录权限的 `/v4/space/pick` 接口验证 token。因为 `/v4/space/index` 是公开接口，即使 token 过期也可能返回成功。

## 预约流程

1. 选择 `1. 自动打开 CAS 获取 token`。
2. 选择 `2. 查询座位并预约`。
3. 选择预约日期和楼层。
4. 校区/馆舍默认使用 `图书馆 (1)`。
5. 类型默认使用 `普通座位 (1)`。
6. 选择有空位的区域。
7. 程序读取学校接口返回的合法预约时间段，包括 `segment`。
8. 搜索座位号、选择第一个空闲座位，或从列表里选择座位。
9. 确认生成的预约参数。
10. 选择立即预约或定时预约。

普通座位的预约参数示例：

```json
{
  "seat_id": "8462",
  "day": "2026-06-12",
  "segment": "1552988"
}
```

## 定时预约

选择定时预约后，如果执行时间直接回车，默认在明天：

```text
05:00:00
```

执行时间是程序提交预约请求的时间。预约目标时段仍然以学校接口返回的合法时段为准，通常是：

```text
08:30~22:00
```

程序会优先读取学校时间接口进行校时。定时预约的重试次数最多 10 次，重试间隔最少 2 秒。

## token 存活时间测试

获取 token 后，可以运行：

```powershell
npm run probe-token
```

默认每 300 秒检查一次。也可以指定间隔：

```powershell
node token_lifetime_probe.js --interval 60
```

只检查一次：

```powershell
node token_lifetime_probe.js --once
```

结果会写入 `token-lifetime.log`。该文件只保存在本地，不会上传到 GitHub。

## 安全限制

- 不保存账号密码。
- 不包含验证码识别或绕过功能。
- token 只保存在本地 `.qlu-token.json`，并已被 `.gitignore` 忽略。
- 日志、缓存、浏览器 profile 都不会上传。
- 预约结果以学校接口返回为准。
- 定时预约重试次数和间隔有上限，避免高频请求。

## 主要文件

- `cli.js`：CMD 主程序，负责菜单、座位查询、预约和定时任务。
- `cas_token_helper.py`：打开 CAS 登录页并读取登录后的 token。
- `token_lifetime_probe.js`：测试 token 是否仍然有效。
- `QLU-LIB-CMD.bat`：Windows 双击启动脚本。
- `package.json`：npm 启动脚本配置。
- `.gitignore`：忽略本地 token、日志、缓存等文件。

## 主要接口

- 配置：`/v4/index/peizhi`
- 日期/楼层/类型：`/v4/space/index`
- 区域：`/v4/space/pick`
- 区域规则：`/v4/Space/map`
- 座位：`/v4/Space/seat`
- 提交预约：`/v4/space/confirm`
