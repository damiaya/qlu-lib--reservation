# QLU Library Seat Helper

Local single-user CMD helper for QLU library seat reservation.

## Start

```powershell
npm start
```

Or double-click:

```text
QLU-LIB-CMD.bat
```

If the CAS browser reports that Chromium is missing, install the browser runtime:

```powershell
python -m pip install playwright
python -m playwright install chromium
```

## Token

The school currently uses CAS / unified login. The CMD program does not store your password.

In the CMD main menu, choose:

```text
1. Auto open CAS and get token
```

Finish login in the browser window. The CMD program detects `sessionStorage.token` and imports it automatically.

The token is saved in `.qlu-token.json` and loaded automatically next time. Use menu item `4. Clear local token` if you want to remove it.

The program checks the JWT `exp` value first, then verifies the token with `/v4/space/pick`, because `/v4/space/index` is public and can succeed even when the token has already expired.

## Flow

1. Choose `1. Auto open CAS and get token`.
2. Choose date and floor. Library defaults to `1`, category defaults to ordinary seat `1`.
3. Choose an area with free seats.
4. The program reads the legal booking time from the school API, including `segment`.
5. Search a seat number, pick the first free seat, or choose from a list.
6. Confirm the generated payload.
7. Choose immediate booking or scheduled booking.

Scheduled booking default:

- Press Enter at the execution-time prompt to run at tomorrow `05:00:00`.
- The reservation target time is still the legal school slot, usually `08:30~22:00`, with the correct `segment`.

Example normal-seat payload:

```json
{
  "seat_id": "8462",
  "day": "2026-06-12",
  "segment": "1552988"
}
```

## Safety Limits

- Token is saved locally in `.qlu-token.json` for convenience and ignored by git.
- No password is written to disk.
- No CAPTCHA bypass is included.
- Scheduled booking retries are capped at 10 attempts.
- Retry interval is at least 2 seconds.
- School API responses are treated as the source of truth.

## Token Lifetime Probe

After getting a token, run:

```powershell
npm run probe-token
```

Default interval is 300 seconds. Use a shorter interval:

```powershell
node token_lifetime_probe.js --interval 60
```

One-time check:

```powershell
node token_lifetime_probe.js --once
```

Results are appended to `token-lifetime.log`.

The probe uses the same protected `/v4/space/pick` check as the CMD program.

## Main APIs

- Config: `/v4/index/peizhi`
- Options: `/v4/space/index`
- Areas: `/v4/space/pick`
- Area rules: `/v4/Space/map`
- Seats: `/v4/Space/seat`
- Normal booking: `/v4/space/confirm`
