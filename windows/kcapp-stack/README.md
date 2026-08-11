# Kcapp One-Box — the whole darts system on one Windows PC

Self-installing test rig: the kcapp site, its database and API, **and** the
smartboard bridge, all in one folder on a Windows 10/11 machine. Nothing is
installed system-wide — delete the folder to uninstall.

## Install (once)

1. Unzip `KcappOneBox-win64.zip` somewhere permanent, e.g. `C:\Kcapp`.
2. Double-click **`SetupKcapp.exe`**. It downloads and wires up everything it
   needs (Node.js, the MariaDB database, the kcapp site — ~150 MB total),
   creates the database schema, and seeds a **Test Venue** (smartboard
   enabled) with two players. Takes a few minutes on normal broadband.
3. When it says *Setup complete*, you're done installing.

## Run

| Do this | To get |
|---------|--------|
| **`StartKcapp.exe`** | Database + API + site up; browser opens `http://localhost:3000` |
| **`DartboardBridge.exe`** | The bridge (starts in **mock mode** — see below) |
| **`StopKcapp.exe`** | Everything off |

The site is also reachable from other devices on your network at
`http://<this-pc-ip>:3000` (find the IP with `ipconfig`) — so a TV browser
and an iPad can point at this PC exactly as they would at the Pi. Windows
may ask once to allow Node/the API through the firewall — allow on private
networks.

## First test, no dartboard needed

`settings.ini` ships with `MODE=mock`: run `StartKcapp.exe`, then
`DartboardBridge.exe`, create a match at **Test Venue** on the site (pick
both players, and the venue!), and type darts at the bridge's `Dart:` prompt
— `20-3` is a treble 20, `25-1` a bull, `exit` quits. Scores appear live on
the site.

## Then the real board

1. Edit `settings.ini`: change `MODE=mock` to `MODE=board`.
2. Bluetooth on, board awake (throw a dart), no phones connected to it.
3. Run `DartboardBridge.exe` and start a match — the console lists every
   Bluetooth device it discovers; find the *joofunn / Dartboard* line and
   put its id into the venue's Smartboard UUID (Offices page on the site,
   lowercase, no colons).

Full test checklist and the move-to-the-Pi plan:
[docs/TEST_THEN_DEPLOY.md](../../docs/TEST_THEN_DEPLOY.md) in the repo.

## Layout after setup

```
KcappOneBox/
├── SetupKcapp.exe / StartKcapp.exe / StopKcapp.exe / DartboardBridge.exe
├── settings.ini          (bridge settings: mock vs board)
├── scripts/              (the PowerShell behind the exes + seed.sql)
├── bin/                  (kcapp-api.exe, goose.exe — built from kcapp sources)
├── app/frontend          (the kcapp site, downloaded by setup)
├── app/database          (schema migrations, downloaded by setup)
├── app/bridge            (the smartboard bridge)
├── runtime/node          (portable Node.js, downloaded by setup)
├── runtime/mariadb       (portable MariaDB, downloaded by setup)
├── data/db               (YOUR match data lives here)
└── config/ · run/        (generated configuration, pids)
```

The database listens on port **3307** (not 3306) so it can't clash with any
existing MySQL on the machine.

## Troubleshooting

- **Setup fails on a download** — re-run `SetupKcapp.exe`; completed steps
  are skipped, it resumes where it stopped.
- **Site won't open** — the very first start compiles the site's pages and
  can take 1–2 minutes; give it time. Otherwise `StopKcapp.exe`, then
  `StartKcapp.exe` again — on failure it prints the failing piece's log.
- **`CheckKcapp.exe`** prints a full health report (what's installed, what's
  running, recent logs) — run it and paste the output when asking for help.
- **Start over completely** — `StopKcapp.exe`, delete the folder, unzip
  fresh. (Deleting only `data\db` + re-running setup resets just the data.)
- **SmartScreen warning on first run** — the exes are unsigned; choose
  "More info → Run anyway".

## Rebuilding the package

From Linux/macOS with bash, curl, zip, npm, go and mingw installed:

```bash
./build-onebox.sh        # produces dist/KcappOneBox-win64.zip
```
