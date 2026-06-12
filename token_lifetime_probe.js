const fs = require("fs");
const path = require("path");

const REMOTE_ORIGIN = "https://libyuyue.qlu.edu.cn";
const TOKEN_FILE = path.join(__dirname, ".qlu-token.json");
const LOG_FILE = path.join(__dirname, "token-lifetime.log");
const DEFAULT_INTERVAL_SECONDS = 300;

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error(".qlu-token.json not found. Run npm start and get a token first.");
  }
  const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  if (!data.token) throw new Error("Token file does not contain token.");
  return data;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    once: false
  };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--interval" || args[i] === "-i") {
      parsed.intervalSeconds = Math.max(Number(args[i + 1] || DEFAULT_INTERVAL_SECONDS), 10);
      i += 1;
    } else if (args[i] === "--once") {
      parsed.once = true;
    }
  }
  return parsed;
}

function appendLog(line) {
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function fmtDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
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

function formatDate(ms) {
  return new Date(ms).toISOString();
}

async function postJson(endpoint, payload, token) {
  const response = await fetch(`${REMOTE_ORIGIN}${endpoint}`, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": REMOTE_ORIGIN,
      "Referer": `${REMOTE_ORIGIN}/h5/`,
      "User-Agent": "Mozilla/5.0 QLU-LIB-Token-Probe/1.0",
      "authorization": `bearer${token}`
    },
    body: JSON.stringify(payload || {})
  });
  const text = await response.text();
  try {
    const json = JSON.parse(text.replace(/^\uFEFF/, "").trim());
    return { response, json };
  } catch {
    return {
      response,
      json: {
        code: "NON_JSON",
        message: text.slice(0, 180)
      }
    };
  }
}

async function checkToken(token) {
  const expiry = tokenExpiry(token);
  if (expiry?.expired) {
    return {
      ok: false,
      status: "LOCAL",
      code: "JWT_EXPIRED",
      message: `expired at ${formatDate(expiry.expMs)}`
    };
  }

  const index = await postJson("/v4/space/index", {}, token);
  const dates = index.json?.data?.date || [];
  const date = dates[dates.length - 1];
  if (!date) {
    return {
      ok: false,
      status: index.response.status,
      code: index.json?.code,
      message: index.json?.message || index.json?.msg || "no available date returned"
    };
  }

  const pick = await postJson("/v4/space/pick", {
    premisesIds: [1],
    categoryIds: [1],
    storeyIds: [],
    boutiqueIds: [],
    date
  }, token);
  return {
    ok: pick.response.ok && pick.json?.code === 0,
    status: pick.response.status,
    code: pick.json?.code,
    message: pick.json?.message || pick.json?.msg || ""
  };
}

async function main() {
  const args = parseArgs();
  const tokenData = loadToken();
  const savedAt = tokenData.savedAt ? new Date(tokenData.savedAt) : new Date();
  const startedAt = new Date();
  const expiry = tokenExpiry(tokenData.token);

  console.log("QLU token lifetime probe");
  console.log(`Saved at: ${tokenData.savedAt || "unknown"}`);
  console.log(`JWT exp: ${expiry ? formatDate(expiry.expMs) : "unknown"}`);
  console.log(`Interval: ${args.intervalSeconds}s`);
  console.log(`Log file: ${LOG_FILE}`);
  appendLog(`\n=== probe started ${startedAt.toISOString()} savedAt=${tokenData.savedAt || "unknown"} interval=${args.intervalSeconds}s ===`);

  let checks = 0;
  while (true) {
    checks += 1;
    const now = new Date();
    const result = await checkToken(tokenData.token).catch((error) => ({
      ok: false,
      status: "ERR",
      code: "EXCEPTION",
      message: error.message
    }));
    const ageMs = now - savedAt;
    const line = `${now.toISOString()} check=${checks} ok=${result.ok} status=${result.status} code=${result.code} age=${fmtDuration(ageMs)} message=${result.message}`;
    console.log(line);
    appendLog(line);

    if (!result.ok) {
      appendLog(`=== token first failed ${now.toISOString()} age=${fmtDuration(ageMs)} ===`);
      console.log(`Token appears invalid. Lifetime from savedAt: ${fmtDuration(ageMs)}`);
      process.exitCode = 2;
      return;
    }

    if (args.once) return;
    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
