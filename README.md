# 齐鲁工业大学图书馆座位预约助手

这是一个本地运行的 CMD 小工具，用来辅助预约齐鲁工业大学图书馆座位。程序不会保存你的校园网密码，只会在你登录成功后读取学校预约系统里的 `token`，并把 token 保存在本地 `.qlu-token.json` 文件中，方便下次继续使用。

## 重要说明

- 本项目仅供个人学习和自用。
- 不包含验证码绕过功能。
- 不保存账号密码。
- 是否预约成功以学校接口返回结果为准。
- 第一次使用前，请先完成下面的环境配置。

## 一、安装运行环境

### 1. 安装 Node.js

本项目主程序使用 Node.js 运行，建议安装 Node.js 20 或更高版本。

下载地址：

```text
https://nodejs.org/
```

安装时一路默认即可。安装完成后，打开 PowerShell 或 CMD，输入：

```powershell
node -v
```

如果能看到类似下面的版本号，说明安装成功：

```text
v20.11.0
```

再输入：

```powershell
npm -v
```

如果也能看到版本号，说明 npm 可用。

### 2. 安装 Python

自动打开学校 CAS 登录页面需要 Python 和 Playwright。

建议安装 Python 3.10 或更高版本。

下载地址：

```text
https://www.python.org/downloads/
```

安装 Python 时请勾选：

```text
Add python.exe to PATH
```

安装完成后，打开 PowerShell 或 CMD，输入：

```powershell
python --version
```

如果能看到类似下面的版本号，说明安装成功：

```text
Python 3.12.4
```

### 3. 安装 Playwright

Playwright 用来自动打开浏览器，让你登录学校统一认证页面。

在项目文件夹里打开 PowerShell，执行：

```powershell
python -m pip install playwright
python -m playwright install chromium
```

如果网络比较慢，请耐心等待。第二条命令会下载浏览器运行环境。

## 二、下载项目

如果你是从 GitHub 下载：

1. 打开本仓库页面。
2. 点击绿色按钮 `Code`。
3. 点击 `Download ZIP`。
4. 解压到一个你容易找到的位置，例如桌面。

解压后，文件夹里应该能看到这些文件：

```text
cli.js
cas_token_helper.py
token_lifetime_probe.js
QLU-LIB-CMD.bat
package.json
README.md
```

## 三、启动程序

进入项目文件夹，在地址栏输入 `cmd` 或 `powershell`，回车打开终端。

然后运行：

```powershell
npm start
```

也可以直接双击：

```text
QLU-LIB-CMD.bat
```

启动成功后，会看到一个 CMD 菜单。

## 四、第一次登录并获取 token

主菜单里选择：

```text
1. Auto open CAS and get token
```

程序会自动打开学校统一认证 CAS 登录页面。

你需要在弹出的浏览器里手动完成登录。登录成功后，程序会自动检测网页里的 `sessionStorage.token`，并导入到 CMD 程序中。

导入成功后，token 会保存到：

```text
.qlu-token.json
```

这个文件只保存在你的电脑本地，已经被 `.gitignore` 忽略，不应该上传到 GitHub。

## 五、查询座位并预约

登录成功后，在主菜单选择：

```text
2. Query seats and book
```

大致流程如下：

1. 选择预约日期。
2. 选择楼层，直接回车表示全部楼层。
3. 选择有空位的区域。
4. 程序读取该区域合法的预约时间段。
5. 程序加载座位列表。
6. 你可以按座位号搜索，也可以直接选择第一个空闲座位。
7. 程序显示最终预约参数。
8. 输入 `yes` 后才会真正提交预约。

普通座位的预约参数大概长这样：

```json
{
  "seat_id": "8462",
  "day": "2026-06-12",
  "segment": "1552988"
}
```

## 六、立即预约和定时预约

选好座位后，程序会显示：

```text
1. Book now
2. Scheduled booking
3. Back to main menu
```

### 立即预约

选择 `1`，然后输入：

```text
yes
```

程序才会提交预约。

### 定时预约

选择 `2` 可以创建定时预约。

默认执行时间是明天：

```text
05:00:00
```

如果你直接回车，就会使用默认时间。

程序还会让你输入：

- 重试次数，最多 10 次。
- 重试间隔，最少 2 秒。

## 七、校准学校时间

主菜单选择：

```text
3. School clock
```

程序会读取学校接口返回的时间，并显示本机时间和学校时间的偏差。定时预约时，如果能读取学校时间，程序会优先按学校时间计算。

## 八、清除本地 token

如果你想换账号，或者 token 失效，可以在主菜单选择：

```text
4. Clear local token
```

这会删除本地 `.qlu-token.json`。

之后重新选择菜单 `1` 登录即可。

## 九、检测 token 有效期

获取 token 后，可以运行：

```powershell
npm run probe-token
```

程序会每隔 300 秒检查一次 token 是否还有效，并把结果写入：

```text
token-lifetime.log
```

如果只想检查一次：

```powershell
node token_lifetime_probe.js --once
```

如果想改成每 60 秒检查一次：

```powershell
node token_lifetime_probe.js --interval 60
```

## 十、常见问题

### 1. 提示 `node` 不是内部或外部命令

说明 Node.js 没装好，或者没有加入 PATH。

解决办法：

1. 重新安装 Node.js。
2. 安装完成后关闭所有 CMD/PowerShell 窗口。
3. 重新打开终端，再输入 `node -v` 检查。

### 2. 提示 `python` 不是内部或外部命令

说明 Python 没装好，或者安装时没有勾选 `Add python.exe to PATH`。

解决办法：

1. 重新安装 Python。
2. 安装时勾选 `Add python.exe to PATH`。
3. 重新打开终端，输入 `python --version` 检查。

### 3. 打不开 CAS 登录浏览器

请确认已经安装 Playwright：

```powershell
python -m pip install playwright
python -m playwright install chromium
```

### 4. token 验证失败

可能是登录过期、账号状态异常，或者学校系统接口变化。

可以尝试：

1. 主菜单选择 `4` 清除本地 token。
2. 再选择 `1` 重新登录。
3. 确认浏览器登录后跳转到了 `libyuyue.qlu.edu.cn`。

### 5. 查询不到座位

可能原因：

- 当前日期不能预约。
- 该区域没有空闲座位。
- 学校接口维护或返回数据变化。
- token 已经过期。

可以先清除 token 后重新登录，再尝试查询。

## 十一、项目文件说明

```text
cli.js                  主程序，负责菜单、查询座位、提交预约
cas_token_helper.py     打开 CAS 登录页并读取 token
token_lifetime_probe.js token 有效期检测工具
QLU-LIB-CMD.bat         Windows 双击启动脚本
package.json            npm 启动脚本配置
.gitignore              忽略 token、日志、缓存等本地文件
```

## 十二、主要接口

程序目前用到的学校预约系统接口包括：

- 配置：`/v4/index/peizhi`
- 可选日期/楼层：`/v4/space/index`
- 区域：`/v4/space/pick`
- 区域规则：`/v4/Space/map`
- 座位：`/v4/Space/seat`
- 普通预约：`/v4/space/confirm`
