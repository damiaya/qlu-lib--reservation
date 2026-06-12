const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

const REMOTE_ORIGIN = "https://libyuyue.qlu.edu.cn";
const TIME_ZONE = "Asia/Shanghai";
const MIN_RETRY_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 10;
const TOKEN_FILE = path.join(__dirname, ".qlu-token.json");

const session = {
  token: "",
  cookies: new Map()
};

const rl = readline.createInterface({ input, output });

class UserExit extends Error {}

async function ask(prompt) {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if (String(error?.message || "").includes("readline was closed")) {
      throw new UserExit();
    }
    throw error;
  }
}

function cleanJsonText(text) {
  return text.replace(/^\uFEFF/, "").trim();
}

function parseJson(text) {
  const first = JSON.parse(cleanJsonText(text));
  if (typeof first === "string") return JSON.parse(cleanJsonText(first));
  return first;
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function tokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp)) return null;
  return {
    expMs: exp * 1000,
    expired: Date.now() >= exp * 1000
  };
}

function formatShanghaiDateTime(ms) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function resultMessage(result, fallback) {
  return result?.message || result?.msg || fallback;
}

function isAuthError(result) {
  const message = String(resultMessage(result, ""));
  return Number(result?.code) === 10001 || message.includes("尚未登录") || message.includes("未登录");
}

function invalidateToken() {
  session.token = "";
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

function ensureApiOk(result, fallback) {
  if (result.code === 0) return;
  if (isAuthError(result)) {
    invalidateToken();
    throw new Error("登录已失效，请重新通过 CAS 获取 token");
  }
  throw new Error(resultMessage(result, fallback));
}

function shanghaiDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}${values.month}${values.day}`;
}

function cryptKey() {
  const day = shanghaiDay();
  return Buffer.from(`${day}${day.split("").reverse().join("")}`, "utf8");
}

function encryptPayload(payload) {
  const cipher = crypto.createCipheriv("aes-128-cbc", cryptKey(), Buffer.from("ZZWBKJ_ZHIHUAWEI", "utf8"));
  return cipher.update(JSON.stringify(payload || {}), "utf8", "base64") + cipher.final("base64");
}

function decryptPayload(cipherText) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", cryptKey(), Buffer.from("ZZWBKJ_ZHIHUAWEI", "utf8"));
  return decipher.update(cipherText, "base64", "utf8") + decipher.final("utf8");
}

function splitSetCookie(headerValue) {
  if (!headerValue) return [];
  return headerValue.split(/,(?=\s*[^;,]+=)/g).map((item) => item.trim()).filter(Boolean);
}

function rememberCookies(headers) {
  let setCookies = [];
  if (typeof headers.getSetCookie === "function") setCookies = headers.getSetCookie();
  if (!setCookies.length) setCookies = splitSetCookie(headers.get("set-cookie"));
  for (const cookie of setCookies) {
    const first = cookie.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) session.cookies.set(first.slice(0, eq), first.slice(eq + 1));
  }
}

function cookieHeader() {
  return Array.from(session.cookies.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
}

async function remotePost(endpoint, payload = {}, options = {}) {
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": REMOTE_ORIGIN,
    "Referer": `${REMOTE_ORIGIN}/h5/`,
    "User-Agent": "Mozilla/5.0 QLU-LIB-CMD/1.0"
  };

  if (session.token) headers.authorization = `bearer${session.token}`;
  const cookies = cookieHeader();
  if (cookies) headers.Cookie = cookies;

  const body = options.encrypted ? { aesjson: encryptPayload(payload) } : payload;
  const response = await fetch(`${REMOTE_ORIGIN}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {})
  });
  if (options.rememberCookies !== false) rememberCookies(response.headers);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  return parseJson(text);
}

async function getSiteConfig() {
  const result = await remotePost("/v4/index/peizhi", {}, { rememberCookies: false });
  const config = JSON.parse(decryptPayload(result.data));
  return {
    login: config?.config?.login || "",
    casUrl: config?.config?.cas_url || ""
  };
}

async function getRemoteClock() {
  const result = await remotePost("/api/index/time", {}, { rememberCookies: false });
  const raw = Number(result?.data?.time);
  if (!Number.isFinite(raw)) return null;
  const remoteMs = (raw / 29 - 509) * 1000;
  return {
    remoteMs,
    offsetMs: remoteMs - Date.now(),
    remoteIso: new Date(remoteMs).toISOString()
  };
}

async function importToken(token) {
  session.token = token.trim();
  if (!session.token) throw new Error("token 不能为空");
  const ok = await validateCurrentToken({ quiet: true });
  if (!ok) {
    session.token = "";
    throw new Error("token 验证失败，请重新登录 CAS 获取 token");
  }
  console.log("token 验证成功。");
  saveToken();
}

function saveToken() {
  const data = {
    token: session.token,
    savedAt: new Date().toISOString()
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log("token 已保存到本地，下次启动会自动读取。");
}

function loadSavedToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (!data.token) return null;
    session.token = String(data.token).trim();
    return data;
  } catch (error) {
    console.log(`读取本地 token 失败：${error.message}`);
    return null;
  }
}

function clearSavedToken() {
  session.token = "";
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  console.log("本地 token 已清除。");
}

async function validateCurrentToken(options = {}) {
  if (!session.token) return false;

  const expiry = tokenExpiry(session.token);
  if (expiry?.expired) {
    if (!options.quiet) console.log(`本地 token 已过期：${formatShanghaiDateTime(expiry.expMs)}，请重新通过 CAS 获取。`);
    invalidateToken();
    return false;
  }

  const indexResult = await remotePost("/v4/space/index", {}).catch((error) => ({
    code: -1,
    message: error.message
  }));
  const dates = indexResult?.data?.date || [];
  const date = dates[dates.length - 1];
  if (!date) {
    if (!options.quiet) console.log(`token 验证失败：${resultMessage(indexResult, indexResult.code)}`);
    return false;
  }

  const protectedResult = await remotePost("/v4/space/pick", {
    premisesIds: [1],
    categoryIds: [1],
    storeyIds: [],
    boutiqueIds: [],
    date
  }).catch((error) => ({
    code: -1,
    message: error.message
  }));
  if (protectedResult.code === 0) return true;

  if (isAuthError(protectedResult)) {
    if (!options.quiet) console.log("本地 token 已失效，请重新通过 CAS 获取。");
    invalidateToken();
    return false;
  }

  if (!options.quiet) console.log(`token 验证失败：${resultMessage(protectedResult, protectedResult.code)}`);
  return false;
}

function acquireTokenWithBrowser() {
  return new Promise((resolve, reject) => {
    console.log("正在打开学校统一认证页面，请在弹出的浏览器里完成登录...");
    console.log("检测到 token 后会自动导入当前 CMD 程序。");

    const child = spawn("python", ["cas_token_helper.py", "--emit-token"], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let token = "";
    let buffer = "";
    let stderr = "";

    const handleText = (text) => {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("__QLU_TOKEN__=")) {
          token = line.slice("__QLU_TOKEN__=".length).trim();
        } else if (line.trim()) {
          console.log(line);
        }
      }
    };

    child.stdout.on("data", (chunk) => handleText(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (text.trim()) process.stderr.write(text);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (buffer.startsWith("__QLU_TOKEN__=")) {
        token = buffer.slice("__QLU_TOKEN__=".length).trim();
      } else if (buffer.trim()) {
        console.log(buffer.trim());
      }
      if (token) resolve(token);
      else reject(new Error(`未获取到 token，helper 退出码 ${code}${stderr ? `：${stderr.trim()}` : ""}`));
    });
  });
}

async function loadOptions() {
  const result = await remotePost("/v4/space/index", {});
  ensureApiOk(result, "筛选项加载失败");
  if (result.code !== 0) throw new Error(result.message || result.msg || "筛选项加载失败");
  return result.data;
}

async function loadAreas(date, premisesIds, storeyIds, categoryIds) {
  const result = await remotePost("/v4/space/pick", {
    premisesIds,
    categoryIds,
    storeyIds,
    boutiqueIds: [],
    date
  });
  ensureApiOk(result, "区域加载失败");
  if (result.code !== 0) throw new Error(result.message || result.msg || "区域加载失败");
  return result.data || {};
}

async function loadSpaceInfo(areaId) {
  const result = await remotePost("/v4/Space/map", { id: areaId });
  ensureApiOk(result, "区域规则加载失败");
  if (result.code !== 0) throw new Error(result.message || result.msg || "区域规则加载失败");
  return result.data;
}

async function loadSeats(areaId, time) {
  const result = await remotePost("/v4/Space/seat", {
    id: areaId,
    day: time.day,
    label_id: "",
    start_time: time.start,
    end_time: time.end,
    begdate: "",
    enddate: ""
  });
  ensureApiOk(result, "座位加载失败");
  if (result.code !== 0) throw new Error(result.message || result.msg || "座位加载失败");
  return result.data || {};
}

async function book(payload) {
  const result = await remotePost("/v4/space/confirm", payload, { encrypted: true });
  if (isAuthError(result)) invalidateToken();
  return result;
}

function flattenStoreys(storeyGroups = []) {
  const result = [];
  for (const group of storeyGroups) {
    if (group.id) result.push(group);
    for (const child of group.list || []) {
      result.push({ ...child, name: child.name || group.name });
    }
  }
  return result;
}

function printList(title, rows, formatter) {
  console.log(`\n${title}`);
  rows.forEach((row, index) => {
    console.log(`${String(index + 1).padStart(2, " ")}. ${formatter(row)}`);
  });
}

async function choose(title, rows, formatter, options = {}) {
  if (!rows.length) throw new Error(`${title} 为空`);
  printList(title, rows, formatter);
  while (true) {
    const answer = (await ask(`请选择 1-${rows.length}${options.allowAll ? "，回车表示全部" : ""}：`)).trim();
    if (options.allowAll && answer === "") return null;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= rows.length) return rows[index - 1];
    console.log("输入无效，请重新输入。");
  }
}

async function chooseDate(dates) {
  if (!dates?.length) return await ask("请输入日期 YYYY-MM-DD：");
  printList("可预约日期", dates, (date) => date);
  while (true) {
    const answer = (await ask(`请选择日期 1-${dates.length}，回车默认最后一天：`)).trim();
    if (!answer) return dates[dates.length - 1];
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= dates.length) return dates[index - 1];
    console.log("输入无效，请重新输入。");
  }
}

function bookingTimeForDate(spaceInfo, day) {
  const reserveType = String(spaceInfo?.date?.reserveType || "");
  const rule = (spaceInfo?.date?.list || []).find((item) => item.day === day);
  if (!rule) throw new Error(`区域没有 ${day} 的预约规则`);

  if (reserveType === "1") {
    const time = (rule.times || []).find((item) => String(item.status) === "1") || (rule.times || [])[0];
    if (!time) throw new Error("当天暂无可预约时段");
    return { reserveType, day, segment: String(time.id || ""), start: time.start, end: time.end };
  }

  if (reserveType === "2") {
    return {
      reserveType,
      day,
      segment: "",
      start: (rule.def_start_time || "").slice(11, 16),
      end: (rule.def_end_time || "").slice(11, 16)
    };
  }

  if (reserveType === "3") {
    return {
      reserveType,
      day,
      segment: "",
      start: (rule.def_start_time || "").slice(11, 16),
      end: (rule.def_end_time || "").slice(11, 16)
    };
  }

  return {
    reserveType,
    day,
    segment: "",
    start: (rule.def_start_time || "").slice(11, 16),
    end: (rule.def_end_time || "").slice(11, 16)
  };
}

function buildPayload(seat, time) {
  const payload = {
    seat_id: seat.id,
    day: time.day
  };
  if (time.reserveType === "1") {
    payload.segment = time.segment;
  } else if (time.reserveType === "2") {
    payload.segment = "";
    payload.end_time = time.end;
  } else {
    payload.segment = "";
    payload.start_time = time.start;
    payload.end_time = time.end;
  }
  return payload;
}

function availableSeats(seats) {
  return seats.filter((seat) => String(seat.status) === "1" || String(seat.is_subscribe) === "1");
}

async function chooseSeat(seats) {
  let candidates = availableSeats(seats);
  if (!candidates.length) throw new Error("没有空闲座位");

  while (true) {
    console.log(`\n空闲座位 ${candidates.length} 个。`);
    console.log("1. 按座位号搜索");
    console.log("2. 使用第一个空闲座位");
    console.log("3. 显示前 30 个空闲座位并选择");
    const action = (await ask("请选择：")).trim();

    if (action === "1") {
      const keyword = (await ask("输入座位号或名称关键字：")).trim().toLowerCase();
      const matched = candidates.filter((seat) =>
        String(seat.no || "").includes(keyword) || String(seat.name || "").toLowerCase().includes(keyword)
      );
      if (!matched.length) {
        console.log("没有匹配座位。");
        continue;
      }
      const shown = matched.slice(0, 50);
      return await choose("匹配座位", shown, (seat) => `${seat.name || seat.no} / id=${seat.id} / ${seat.status_name || "空闲"}`);
    }

    if (action === "2" || action === "") return candidates[0];

    if (action === "3") {
      return await choose("前 30 个空闲座位", candidates.slice(0, 30), (seat) =>
        `${seat.name || seat.no} / id=${seat.id} / ${seat.status_name || "空闲"}`
      );
    }

    console.log("输入无效，请重新输入。");
  }
}

function parseRunTime(value) {
  const text = value.trim().replace("T", " ");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0"] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function tomorrow0500() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(5, 0, 0, 0);
  return date;
}

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scheduleBook(payload) {
  const defaultRunAt = tomorrow0500();
  const runText = await ask(`执行时间 YYYY-MM-DD HH:mm:ss，回车默认 ${formatLocalDateTime(defaultRunAt)}：`);
  const runAt = runText.trim() ? parseRunTime(runText) : defaultRunAt;
  if (!runAt || Number.isNaN(runAt.getTime())) {
    console.log("时间格式无效。");
    return;
  }
  const attempts = Math.min(Math.max(Number(await ask("重试次数 1-10，默认 5：")) || 5, 1), MAX_ATTEMPTS);
  const intervalSeconds = Math.max(Number(await ask("重试间隔秒，默认 3：")) || 3, MIN_RETRY_INTERVAL_MS / 1000);
  const clock = await getRemoteClock().catch(() => null);
  const now = clock ? clock.remoteMs : Date.now();
  const delay = Math.max(0, runAt.getTime() - now);

  console.log(`定时任务已创建：${runAt.toLocaleString()}，${clock ? "按学校时间" : "按本机时间"}，将在 ${Math.round(delay / 1000)} 秒后执行。`);
  await sleep(delay);

  for (let i = 1; i <= attempts; i += 1) {
    const result = await book(payload).catch((error) => ({ code: -1, message: error.message }));
    console.log(`第 ${i} 次：${result.message || result.msg || result.code}`);
    if (result.code === 0) return;
    if (i < attempts) await sleep(intervalSeconds * 1000);
  }
}

async function reservationFlow() {
  const options = await loadOptions();
  const date = await chooseDate(options.date || []);
  console.log("\n默认校区/馆舍：图书馆 (1)");
  console.log("默认类型：普通座位 (1)");
  const storey = await choose("楼层", flattenStoreys(options.storey || []), (item) => item.name || item.id, { allowAll: true });

  const areasData = await loadAreas(
    date,
    [1],
    storey ? [storey.id] : [],
    [1]
  );
  const areas = areasData.area || [];
  const area = await choose("区域", areas, (item) =>
    `${item.nameMerge || item.name} | 空闲 ${item.free_num}/${item.total_num} | id=${item.id}`
  );

  const spaceInfo = await loadSpaceInfo(area.id);
  const time = bookingTimeForDate(spaceInfo, date);
  console.log(`\n合法预约时段：${time.day} ${time.start}~${time.end}${time.segment ? `，segment=${time.segment}` : ""}`);

  const seatsData = await loadSeats(area.id, time);
  const seats = seatsData.list || [];
  console.log(`座位总数 ${seatsData.total_num || seats.length}，空闲 ${seatsData.free_num || availableSeats(seats).length}`);
  const seat = await chooseSeat(seats);
  const payload = buildPayload(seat, time);

  console.log("\n预约参数：");
  console.log(JSON.stringify(payload, null, 2));
  console.log(`座位：${seat.name || seat.no}，区域：${area.nameMerge || area.name}`);

  console.log("\n1. 立即预约");
  console.log("2. 定时预约");
  console.log("3. 返回主菜单");
  const action = (await ask("请选择：")).trim();
  if (action === "1") {
    const confirm = (await ask("确认立即提交预约？输入 yes 确认：")).trim().toLowerCase();
    if (confirm !== "yes") return;
    const result = await book(payload);
    console.log(`预约返回：${result.message || result.msg || result.code}`);
  } else if (action === "2") {
    await scheduleBook(payload);
  }
}

async function mainMenu() {
  console.clear();
  console.log("齐鲁工业大学图书馆座位预约 CMD");
  console.log("================================");
  const savedToken = loadSavedToken();
  if (savedToken) {
    const ok = await validateCurrentToken();
    if (ok) {
      console.log(`已读取本地 token，保存时间：${savedToken.savedAt || "未知"}`);
    } else {
      console.log("请重新自动获取 token。");
    }
  }
  const config = await getSiteConfig().catch((error) => {
    console.log(`读取站点配置失败：${error.message}`);
    return null;
  });
  if (config?.login === "4" || config?.login === "8") {
    console.log(`学校当前登录模式：CAS/统一认证`);
    console.log(`CAS 地址：${config.casUrl}`);
  }

  while (true) {
    console.log("\n主菜单");
    console.log(`登录状态：${session.token ? "已导入 token" : "未导入 token"}`);
    console.log("1. 自动打开 CAS 获取 token");
    console.log("2. 查询座位并预约");
    console.log("3. 校时");
    console.log("4. 清除本地 token");
    console.log("5. 退出");
    const action = (await ask("请选择：")).trim();

    try {
      if (action === "1") {
        const token = await acquireTokenWithBrowser();
        await importToken(token);
      } else if (action === "2") {
        if (!session.token) {
          console.log("请先导入 token。");
          continue;
        }
        await reservationFlow();
      } else if (action === "3") {
        const clock = await getRemoteClock();
        console.log(`学校时间：${new Date(clock.remoteMs).toLocaleString()}，偏差 ${Math.round(clock.offsetMs / 1000)} 秒`);
      } else if (action === "4") {
        clearSavedToken();
      } else if (action === "5" || action.toLowerCase() === "q") {
        break;
      }
    } catch (error) {
      console.log(`错误：${error.message}`);
    }
  }
}

mainMenu()
  .catch((error) => {
    if (error instanceof UserExit) return;
    console.error(`程序异常：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
