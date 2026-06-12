import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent
PYDEPS_DIR = PROJECT_DIR / ".pydeps"
TOKEN_FILE = PROJECT_DIR / ".qlu-token.json"
PROFILE_DIR = PROJECT_DIR / ".cas-browser-profile"

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7
    import _cffi_backend  # noqa: F401
except ImportError as exc:
    raise SystemExit(
        "Missing Python dependency: {0}\n"
        "Install with: python -m pip install cryptography".format(exc.name)
    ) from exc

if PYDEPS_DIR.exists():
    sys.path.append(str(PYDEPS_DIR))

try:
    from scrapling.fetchers import DynamicSession, FetcherSession
except ImportError as exc:
    raise SystemExit(
        "Missing Python dependency: {0}\n"
        "Install with: python -m pip install --target .\\.pydeps \"scrapling[fetchers]\"".format(exc.name)
    ) from exc


REMOTE_ORIGIN = "https://libyuyue.qlu.edu.cn"
DEFAULT_CAS_URL = "https://libyuyue.qlu.edu.cn/v4/login/cas"
TIME_ZONE = "Asia/Shanghai"
AES_IV = b"ZZWBKJ_ZHIHUAWEI"
MIN_RETRY_INTERVAL_SECONDS = 2
MAX_ATTEMPTS = 10


class UserExit(Exception):
    pass


def ask(prompt):
    try:
        return input(prompt)
    except (EOFError, KeyboardInterrupt) as exc:
        raise UserExit() from exc


def clean_json_text(text):
    return str(text).lstrip("\ufeff").strip()


def parse_json_text(text):
    first = json.loads(clean_json_text(text))
    if isinstance(first, str):
        return json.loads(clean_json_text(first))
    return first


def decode_jwt_payload(token):
    parts = str(token or "").split(".")
    if len(parts) < 2:
        return None
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception:
        return None


def token_expiry(token):
    payload = decode_jwt_payload(token)
    try:
        exp = int(payload.get("exp"))
    except Exception:
        return None
    return exp


def forget_saved_token():
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()


def is_auth_error(result):
    message = str(result.get("message") or result.get("msg") or "")
    return int(result.get("code") or 0) == 10001 or "尚未登录" in message or "未登录" in message


def shanghai_day():
    try:
        from zoneinfo import ZoneInfo

        now = datetime.now(ZoneInfo(TIME_ZONE))
    except Exception:
        now = datetime.now()
    return now.strftime("%Y%m%d")


def crypt_key():
    day = shanghai_day()
    return (day + day[::-1]).encode("utf-8")


def _pkcs7_pad(data):
    padder = PKCS7(128).padder()
    return padder.update(data) + padder.finalize()


def _pkcs7_unpad(data):
    unpadder = PKCS7(128).unpadder()
    return unpadder.update(data) + unpadder.finalize()


def encrypt_payload(payload):
    raw = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    cipher = Cipher(algorithms.AES(crypt_key()), modes.CBC(AES_IV))
    encryptor = cipher.encryptor()
    encrypted = encryptor.update(_pkcs7_pad(raw)) + encryptor.finalize()
    return base64.b64encode(encrypted).decode("ascii")


def decrypt_payload(cipher_text):
    cipher = Cipher(algorithms.AES(crypt_key()), modes.CBC(AES_IV))
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(base64.b64decode(cipher_text)) + decryptor.finalize()
    return _pkcs7_unpad(decrypted).decode("utf-8")


def load_saved_token():
    try:
        if not TOKEN_FILE.exists():
            return None
        data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        token = str(data.get("token") or "").strip()
        if not token:
            return None
        return {"token": token, "savedAt": data.get("savedAt")}
    except Exception as exc:
        print("Failed to read local token: {0}".format(exc))
        return None


def save_token(token):
    data = {"token": token.strip(), "savedAt": datetime.utcnow().isoformat(timespec="seconds") + "Z"}
    TOKEN_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print("Token saved to {0}".format(TOKEN_FILE.name))


def clear_saved_token():
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()
    print("Local token cleared.")


def response_json(response):
    if response.status >= 400:
        body = response.body.decode("utf-8", errors="replace")[:240]
        raise RuntimeError("HTTP {0}: {1}".format(response.status, body))
    try:
        result = response.json()
    except Exception:
        result = parse_json_text(response.body.decode("utf-8", errors="replace"))
    if isinstance(result, str):
        return parse_json_text(result)
    return result


class QLUScraplingClient:
    def __init__(self, token=""):
        self.token = token.strip()
        self._session_manager = FetcherSession(
            impersonate="chrome",
            stealthy_headers=True,
            timeout=15,
            retries=3,
            retry_delay=1,
            follow_redirects=True,
        )
        self._session = None

    def __enter__(self):
        self._session = self._session_manager.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._session_manager.__exit__(exc_type, exc, tb)
        self._session = None

    def headers(self):
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": REMOTE_ORIGIN,
            "Referer": REMOTE_ORIGIN + "/h5/",
            "User-Agent": "Mozilla/5.0 QLU-LIB-Scrapling/1.0",
        }
        if self.token:
            headers["authorization"] = "bearer{0}".format(self.token)
        return headers

    def remote_post(self, endpoint, payload=None, encrypted=False):
        if not self._session:
            raise RuntimeError("Scrapling session is not open")
        body = {"aesjson": encrypt_payload(payload)} if encrypted else (payload or {})
        response = self._session.post(
            REMOTE_ORIGIN + endpoint,
            headers=self.headers(),
            json=body,
        )
        return response_json(response)

    def get_site_config(self):
        result = self.remote_post("/v4/index/peizhi", {})
        config = json.loads(decrypt_payload(result.get("data", "")))
        return {
            "login": str((config.get("config") or {}).get("login") or ""),
            "cas_url": (config.get("config") or {}).get("cas_url") or "",
        }

    def get_remote_clock(self):
        result = self.remote_post("/api/index/time", {})
        raw = float(((result.get("data") or {}).get("time") or 0))
        if not raw:
            return None
        remote_ms = (raw / 29 - 509) * 1000
        return {
            "remote_ms": remote_ms,
            "offset_ms": remote_ms - time.time() * 1000,
            "remote_iso": datetime.utcfromtimestamp(remote_ms / 1000).isoformat() + "Z",
        }

    def validate_token(self, quiet=False):
        if not self.token:
            return False
        expiry = token_expiry(self.token)
        if expiry and expiry <= time.time():
            if not quiet:
                print("Saved token expired at {0}. Please login with CAS again.".format(datetime.fromtimestamp(expiry).strftime("%Y-%m-%d %H:%M:%S")))
            self.token = ""
            forget_saved_token()
            return False
        try:
            index_result = self.remote_post("/v4/space/index", {})
            dates = ((index_result.get("data") or {}).get("date") or [])
            date = dates[-1] if dates else datetime.now().strftime("%Y-%m-%d")
            result = self.remote_post(
                "/v4/space/pick",
                {
                    "premisesIds": [1],
                    "categoryIds": [1],
                    "storeyIds": [],
                    "boutiqueIds": [],
                    "date": date,
                },
            )
        except Exception as exc:
            if not quiet:
                print("Token check failed: {0}".format(exc))
            return False
        if result.get("code") == 0:
            return True
        if is_auth_error(result):
            if not quiet:
                print("Saved token is invalid. Please login with CAS again.")
            self.token = ""
            forget_saved_token()
            return False
        if not quiet:
            print("Saved token may be invalid: {0}".format(result.get("message") or result.get("msg") or result.get("code")))
        return False

    def import_token(self, token):
        self.token = token.strip()
        if not self.token:
            raise RuntimeError("Token cannot be empty.")
        if not self.validate_token(quiet=True):
            self.token = ""
            raise RuntimeError("Token validation failed. Please login with CAS again.")
        print("Token validation succeeded.")
        save_token(self.token)

    def load_options(self):
        result = self.remote_post("/v4/space/index", {})
        if result.get("code") != 0:
            raise RuntimeError(result.get("message") or result.get("msg") or "Failed to load options")
        return result.get("data") or {}

    def load_areas(self, date, premises_ids, storey_ids, category_ids):
        result = self.remote_post(
            "/v4/space/pick",
            {
                "premisesIds": premises_ids,
                "categoryIds": category_ids,
                "storeyIds": storey_ids,
                "boutiqueIds": [],
                "date": date,
            },
        )
        if result.get("code") != 0:
            raise RuntimeError(result.get("message") or result.get("msg") or "Failed to load areas")
        return result.get("data") or {}

    def load_space_info(self, area_id):
        result = self.remote_post("/v4/Space/map", {"id": area_id})
        if result.get("code") != 0:
            raise RuntimeError(result.get("message") or result.get("msg") or "Failed to load area rules")
        return result.get("data") or {}

    def load_seats(self, area_id, booking_time):
        result = self.remote_post(
            "/v4/Space/seat",
            {
                "id": area_id,
                "day": booking_time["day"],
                "label_id": "",
                "start_time": booking_time["start"],
                "end_time": booking_time["end"],
                "begdate": "",
                "enddate": "",
            },
        )
        if result.get("code") != 0:
            raise RuntimeError(result.get("message") or result.get("msg") or "Failed to load seats")
        return result.get("data") or {}

    def book(self, payload):
        return self.remote_post("/v4/space/confirm", payload, encrypted=True)


def acquire_token_with_scrapling(cas_url):
    token_box = {"token": ""}
    cas_url = cas_url or os.environ.get("QLU_CAS_URL") or DEFAULT_CAS_URL

    print("Opening CAS login page with Scrapling DynamicSession:")
    print(cas_url)
    print("Finish login in the browser window. This helper waits for sessionStorage.token.")

    def wait_for_token(page):
        deadline = time.time() + 300
        while time.time() < deadline:
            try:
                if "libyuyue.qlu.edu.cn" in page.url:
                    token = page.evaluate("() => sessionStorage.getItem('token') || ''")
                    if isinstance(token, str) and token.strip():
                        token_box["token"] = token.strip()
                        return
            except Exception:
                pass
            page.wait_for_timeout(1000)

    with DynamicSession(
        headless=False,
        user_data_dir=str(PROFILE_DIR),
        google_search=False,
        timezone_id=TIME_ZONE,
        locale="zh-CN",
        timeout=300000,
        additional_args={"viewport": {"width": 1280, "height": 860}},
    ) as session:
        session.fetch(
            cas_url,
            timeout=300000,
            wait=0,
            load_dom=True,
            network_idle=False,
            page_action=wait_for_token,
        )

    if not token_box["token"]:
        raise RuntimeError("Timed out: token was not detected within 5 minutes.")
    return token_box["token"]


def flatten_storeys(storey_groups):
    rows = []
    for group in storey_groups or []:
        if group.get("id"):
            rows.append(group)
        for child in group.get("list") or []:
            merged = dict(child)
            merged["name"] = child.get("name") or group.get("name")
            rows.append(merged)
    return rows


def print_list(title, rows, formatter):
    print("\n{0}".format(title))
    for index, row in enumerate(rows, 1):
        print("{0:>2}. {1}".format(index, formatter(row)))


def choose(title, rows, formatter, allow_all=False):
    if not rows:
        raise RuntimeError("{0} is empty".format(title))
    print_list(title, rows, formatter)
    while True:
        suffix = ", Enter for all" if allow_all else ""
        answer = ask("Choose 1-{0}{1}: ".format(len(rows), suffix)).strip()
        if allow_all and answer == "":
            return None
        try:
            index = int(answer)
        except ValueError:
            index = -1
        if 1 <= index <= len(rows):
            return rows[index - 1]
        print("Invalid input, please try again.")


def choose_date(dates):
    if not dates:
        return ask("Enter date (YYYY-MM-DD): ").strip()
    print_list("Available dates", dates, lambda item: item)
    while True:
        answer = ask("Choose date 1-{0}, Enter for last date: ".format(len(dates))).strip()
        if not answer:
            return dates[-1]
        try:
            index = int(answer)
        except ValueError:
            index = -1
        if 1 <= index <= len(dates):
            return dates[index - 1]
        print("Invalid input, please try again.")


def booking_time_for_date(space_info, day):
    date_info = space_info.get("date") or {}
    reserve_type = str(date_info.get("reserveType") or "")
    rule = next((item for item in date_info.get("list") or [] if item.get("day") == day), None)
    if not rule:
        raise RuntimeError("Area has no booking rule for {0}".format(day))

    if reserve_type == "1":
        times = rule.get("times") or []
        slot = next((item for item in times if str(item.get("status")) == "1"), None) or (times[0] if times else None)
        if not slot:
            raise RuntimeError("No available booking segment for this date.")
        return {
            "reserveType": reserve_type,
            "day": day,
            "segment": str(slot.get("id") or ""),
            "start": slot.get("start") or "",
            "end": slot.get("end") or "",
        }

    return {
        "reserveType": reserve_type,
        "day": day,
        "segment": "",
        "start": str(rule.get("def_start_time") or "")[11:16],
        "end": str(rule.get("def_end_time") or "")[11:16],
    }


def build_payload(seat, booking_time):
    payload = {
        "seat_id": seat.get("id"),
        "day": booking_time["day"],
    }
    if booking_time["reserveType"] == "1":
        payload["segment"] = booking_time["segment"]
    elif booking_time["reserveType"] == "2":
        payload["segment"] = ""
        payload["end_time"] = booking_time["end"]
    else:
        payload["segment"] = ""
        payload["start_time"] = booking_time["start"]
        payload["end_time"] = booking_time["end"]
    return payload


def available_seats(seats):
    return [seat for seat in seats if str(seat.get("status")) == "1" or str(seat.get("is_subscribe")) == "1"]


def choose_seat(seats):
    candidates = available_seats(seats)
    if not candidates:
        raise RuntimeError("No free seats.")

    while True:
        print("\nFree seats: {0}".format(len(candidates)))
        print("1. Search by seat number/name")
        print("2. Use first free seat")
        print("3. Show first 30 free seats")
        action = ask("Choose: ").strip()

        if action == "1":
            keyword = ask("Seat number/name keyword: ").strip().lower()
            matched = [
                seat
                for seat in candidates
                if keyword in str(seat.get("no") or "").lower()
                or keyword in str(seat.get("name") or "").lower()
            ]
            if not matched:
                print("No matching seat.")
                continue
            return choose(
                "Matching seats",
                matched[:50],
                lambda seat: "{0} / id={1} / {2}".format(
                    seat.get("name") or seat.get("no"),
                    seat.get("id"),
                    seat.get("status_name") or "free",
                ),
            )

        if action in ("", "2"):
            return candidates[0]

        if action == "3":
            return choose(
                "First 30 free seats",
                candidates[:30],
                lambda seat: "{0} / id={1} / {2}".format(
                    seat.get("name") or seat.get("no"),
                    seat.get("id"),
                    seat.get("status_name") or "free",
                ),
            )

        print("Invalid input, please try again.")


def parse_run_time(value):
    text = value.strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    return None


def tomorrow_0500():
    date = datetime.now() + timedelta(days=1)
    return date.replace(hour=5, minute=0, second=0, microsecond=0)


def format_local_datetime(date):
    return date.strftime("%Y-%m-%d %H:%M:%S")


def schedule_book(client, payload):
    default_run_at = tomorrow_0500()
    run_text = ask("Run time YYYY-MM-DD HH:mm:ss, Enter for {0}: ".format(format_local_datetime(default_run_at)))
    run_at = parse_run_time(run_text) if run_text.strip() else default_run_at
    if not run_at:
        print("Invalid time format.")
        return

    try:
        attempts = int(ask("Retry attempts 1-10, default 5: ").strip() or "5")
    except ValueError:
        attempts = 5
    attempts = min(max(attempts, 1), MAX_ATTEMPTS)

    try:
        interval = float(ask("Retry interval seconds, default 3: ").strip() or "3")
    except ValueError:
        interval = 3
    interval = max(interval, MIN_RETRY_INTERVAL_SECONDS)

    clock = None
    try:
        clock = client.get_remote_clock()
    except Exception:
        pass

    now_ms = clock["remote_ms"] if clock else time.time() * 1000
    delay = max(0, run_at.timestamp() * 1000 - now_ms)
    print(
        "Scheduled at {0} using {1}; starts in {2}s.".format(
            format_local_datetime(run_at),
            "school clock" if clock else "local clock",
            round(delay / 1000),
        )
    )
    time.sleep(delay / 1000)

    for index in range(1, attempts + 1):
        try:
            result = client.book(payload)
        except Exception as exc:
            result = {"code": -1, "message": str(exc)}
        print("Attempt {0}: {1}".format(index, result.get("message") or result.get("msg") or result.get("code")))
        if result.get("code") == 0:
            return
        if index < attempts:
            time.sleep(interval)


def reservation_flow(client):
    options = client.load_options()
    date = choose_date(options.get("date") or [])

    print("\nDefault premises: library (1)")
    print("Default category: normal seat (1)")
    storey = choose("Storeys", flatten_storeys(options.get("storey") or []), lambda item: item.get("name") or item.get("id"), True)

    areas_data = client.load_areas(date, [1], [storey.get("id")] if storey else [], [1])
    area = choose(
        "Areas",
        areas_data.get("area") or [],
        lambda item: "{0} | free {1}/{2} | id={3}".format(
            item.get("nameMerge") or item.get("name"),
            item.get("free_num"),
            item.get("total_num"),
            item.get("id"),
        ),
    )

    space_info = client.load_space_info(area.get("id"))
    booking_time = booking_time_for_date(space_info, date)
    print(
        "\nLegal booking time: {0} {1}~{2}{3}".format(
            booking_time["day"],
            booking_time["start"],
            booking_time["end"],
            ", segment={0}".format(booking_time["segment"]) if booking_time["segment"] else "",
        )
    )

    seats_data = client.load_seats(area.get("id"), booking_time)
    seats = seats_data.get("list") or []
    print("Seat total {0}, free {1}".format(seats_data.get("total_num") or len(seats), seats_data.get("free_num") or len(available_seats(seats))))
    seat = choose_seat(seats)
    payload = build_payload(seat, booking_time)

    print("\nBooking payload:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    print("Seat: {0}, area: {1}".format(seat.get("name") or seat.get("no"), area.get("nameMerge") or area.get("name")))

    print("\n1. Book now")
    print("2. Scheduled booking")
    print("3. Back to main menu")
    action = ask("Choose: ").strip()
    if action == "1":
        confirm = ask("Type yes to submit now: ").strip().lower()
        if confirm != "yes":
            return
        result = client.book(payload)
        print("Booking result: {0}".format(result.get("message") or result.get("msg") or result.get("code")))
    elif action == "2":
        schedule_book(client, payload)


def main_menu(token_only=False):
    saved = load_saved_token()
    token = saved["token"] if saved else ""

    with QLUScraplingClient(token=token) as client:
        if saved:
            if client.validate_token():
                print("Loaded saved token. savedAt={0}".format(saved.get("savedAt") or "unknown"))
            else:
                print("Please login with CAS again.")

        config = {}
        try:
            config = client.get_site_config()
            if config.get("login") in ("4", "8"):
                print("Current login mode: CAS")
                print("CAS URL: {0}".format(config.get("cas_url") or DEFAULT_CAS_URL))
        except Exception as exc:
            print("Failed to load site config: {0}".format(exc))

        if token_only:
            token = acquire_token_with_scrapling(config.get("cas_url") or DEFAULT_CAS_URL)
            client.import_token(token)
            return

        while True:
            print("\nQLU Library Seat Helper (Scrapling)")
            print("===================================")
            print("Login: {0}".format("token loaded" if client.token else "no token"))
            print("1. Open CAS and get token")
            print("2. Query seats and book")
            print("3. School clock")
            print("4. Clear local token")
            print("5. Exit")
            action = ask("Choose: ").strip()

            try:
                if action == "1":
                    token = acquire_token_with_scrapling(config.get("cas_url") or DEFAULT_CAS_URL)
                    client.import_token(token)
                elif action == "2":
                    if not client.token:
                        print("Please import token first.")
                        continue
                    reservation_flow(client)
                elif action == "3":
                    clock = client.get_remote_clock()
                    if not clock:
                        print("School clock unavailable.")
                    else:
                        remote = datetime.fromtimestamp(clock["remote_ms"] / 1000)
                        print("School time: {0}, offset {1}s".format(remote.strftime("%Y-%m-%d %H:%M:%S"), round(clock["offset_ms"] / 1000)))
                elif action == "4":
                    clear_saved_token()
                    client.token = ""
                elif action == "5" or action.lower() == "q":
                    return
                else:
                    print("Invalid input, please try again.")
            except UserExit:
                raise
            except Exception as exc:
                print("Error: {0}".format(exc))


def parse_args():
    parser = argparse.ArgumentParser(description="QLU library seat helper implemented with Scrapling.")
    parser.add_argument("--token-only", action="store_true", help="Only open CAS, capture token, validate it, and save it.")
    return parser.parse_args()


def main():
    args = parse_args()
    main_menu(token_only=args.token_only)


if __name__ == "__main__":
    try:
        main()
    except UserExit:
        print("\nCancelled.")
