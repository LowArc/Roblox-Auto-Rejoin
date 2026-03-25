# Roblox Auto Rejoin — Node.js

Automatically monitors multiple Roblox accounts for disconnection and rejoins each account to its own configured VIP server via the **Roblox Account Manager (RAM)** API.

---

## Requirements

- **[Node.js](https://nodejs.org/) 16+**
- **[Roblox Account Manager](https://github.com/ic3w0lf22/Roblox-Account-Manager)** — must be running with the Web Server enabled

---

## Setup

### 1. Enable RAM Web Server

Open Roblox Account Manager → Click the **gear icon** (Settings) → Check **Enable Web Server**.

Optionally set a **Password** for extra security.

> ⚠️ Also enable **Allow Launch Account** for the rejoin feature to work.

### 2. Add Accounts to RAM

Add all your accounts into RAM normally. The **account name** you use in RAM must match the `name` field in `config.json`.

### 3. Setup Config

1. Create a file named `config.json` in the exact same folder as the `RobloxAutoRejoin.exe`.
2. Edit `config.json` with your details (use `config.example.json` as a reference):

```jsonc
{
  "ram": {
    "host": "localhost",
    "port": 7963,          // Must match RAM's WebServerPort setting
    "password": ""         // Must match RAM's Password setting (leave blank if none)
  },
  "accounts": [
    {
      "name": "Account1",          // MUST match the account name in RAM exactly
      "cookie": "_|WARNING:...",   // .ROBLOSECURITY cookie (for presence detection)
      "placeId": "12345678",       // Roblox Place ID of the game
      "vipServerLink": "https://www.roblox.com/share?code=XXXXXXXXX&type=Server",
      "checkIntervalMs": 30000,    // How often to check (ms). Default: 30000 (30s)
      "rejoinDelayMs": 8000        // Delay after rejoin before next check (ms). Default: 5000
    }
  ]
}
```

---

## How to Get Your VIP Server Link

1. Go to your VIP Server on Roblox.com
2. Click **Share** -> **Copy Link** on the private server
3. The Server Link looks like:
   ```
   https://www.roblox.com/share?code=XXXXXXXXXXXX&type=Server
   ```
4. Paste the full link into `vipServerLink` in config.

---

## How to Get Your Cookie

> ⚠️ **Never share your cookie. It gives full access to your account.**

1. Open any Roblox page in your browser while logged in
2. Open DevTools (F12) → Application → Cookies
3. Copy the value of `.ROBLOSECURITY`
4. Paste it into the `cookie` field in config.json

---

## Running

Double click the **`RobloxAutoRejoin.exe`** file!

You should see output like:

```
00:00:00 [INFO   ] [System ] Starting 2 account monitor(s)...
00:00:01 [INFO   ] [Account1] Monitor started — checking every 30s
00:00:03 [SUCCESS] [Account1] In-game ✓
...
00:01:03 [WARN   ] [Account1] NOT in-game — triggering rejoin...
00:01:03 [INFO   ] [Account1] Sending rejoin request → RAM API
00:01:04 [SUCCESS] [Account1] Rejoin sent!
```

To stop, simply close the black window.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot connect to Roblox Account Manager` | Make sure RAM is open and "Enable Web Server" is checked in RAM settings |
| `HTTP 403` from RAM | RAM password is set — add it to `config.json` → `ram.password` |
| `HTTP 401` from Roblox | Cookie is expired — update the `.ROBLOSECURITY` cookie value |
| Account name not found in RAM | Make sure `name` in config.json exactly matches the account name shown in RAM |
| Not rejoining VIP server | Ensure "Allow Launch Account" is enabled in RAM settings |
