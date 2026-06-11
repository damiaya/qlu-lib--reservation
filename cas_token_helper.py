import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright


LOCAL_ORIGIN = "http://127.0.0.1:5500"
DEFAULT_CAS_URL = "https://libyuyue.qlu.edu.cn/v4/login/cas"
PROFILE_DIR = Path(__file__).with_name(".cas-browser-profile")


def api_json(path, payload=None, timeout=10):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{LOCAL_ORIGIN}{path}", data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def local_server_ready():
    try:
        api_json("/api/status")
        return True
    except Exception:
        return False


def get_cas_url():
    try:
        config = api_json("/api/site-config").get("config") or {}
        return config.get("cas_url") or DEFAULT_CAS_URL
    except Exception:
        return DEFAULT_CAS_URL


async def read_token_from_page(page):
    try:
        if "libyuyue.qlu.edu.cn" not in page.url:
            return ""
        token = await page.evaluate("() => sessionStorage.getItem('token') || ''")
        return token.strip() if isinstance(token, str) else ""
    except Exception:
        return ""


async def main():
    emit_token = "--emit-token" in sys.argv
    has_local_server = local_server_ready() and not emit_token
    cas_url = os.environ.get("QLU_CAS_URL") or get_cas_url()

    print(f"Opening CAS login page: {cas_url}")
    print("Finish login in the browser window. This helper will wait for sessionStorage.token.")
    if has_local_server:
        print("Local web server detected. Token will be imported into the web helper.")
    else:
        print("No local web server detected. Token will be printed for the CMD helper.")

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1280, "height": 860},
        )
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(cas_url, wait_until="domcontentloaded")

        started = time.time()
        while time.time() - started < 300:
            for candidate in context.pages:
                token = await read_token_from_page(candidate)
                if token:
                    if emit_token:
                        print(f"__QLU_TOKEN__={token}", flush=True)
                    elif has_local_server:
                        result = api_json("/api/import-token", {"token": token})
                        print("Token imported into the web helper.")
                        if result.get("warning"):
                            print(result["warning"])
                    else:
                        print("")
                        print("Copy the full token line below into the CMD helper:")
                        print(token)
                    await context.close()
                    return 0
            await asyncio.sleep(1)

        print("Timed out: token was not detected within 5 minutes.")
        print("After logging in, keep the browser on libyuyue.qlu.edu.cn and run this helper again.")
        await context.close()
        return 2


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except urllib.error.URLError as exc:
        print(f"Local helper request failed: {exc}")
        raise SystemExit(1)
    except KeyboardInterrupt:
        print("Cancelled.")
        raise SystemExit(130)
