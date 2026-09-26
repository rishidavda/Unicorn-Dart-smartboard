/*
 * WinchesterDarts.exe - starts the darts hub, opens the TV screen, and keeps
 * the hub running: it relaunches the hub after its daily fresh start (exit
 * code 75) and after an unexpected stop, so the oche never stays dark.
 *
 * Reads settings.ini (optional) from its own folder:
 *   PORT=8080
 *   OPEN=tv                ; tv | pad | none  - which page to open on this PC
 *   DAILY_RESTART=09:00    ; any other KEY=value is passed to the hub as-is
 * PORT and OPEN are read once and kept for the life of the exe (the TV
 * window it opened, and every TV and iPad in the pub, are on that port); the
 * hub keys are read again before every relaunch, so an edited DAILY_RESTART
 * takes effect at the next fresh start.
 *
 * Exit codes from the hub:
 *   75  daily fresh start      -> relaunch straight away
 *   64  folder already in use  -> stop (another copy is running here)
 *   78  no free port           -> try again in 30 s (a port can free up)
 *   other, after > 60 s run    -> crash: relaunch in 5 s
 *   other, within 60 s         -> setup problem: stop and show it
 *
 * Build: x86_64-w64-mingw32-gcc -O2 -s -o WinchesterDarts.exe launcher.c -lshell32
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef ENABLE_QUICK_EDIT_MODE
#define ENABLE_QUICK_EDIT_MODE 0x0040
#endif
#ifndef ENABLE_EXTENDED_FLAGS
#define ENABLE_EXTENDED_FLAGS 0x0080
#endif

#define CODE_FRESH_START 75
#define CODE_IN_USE      64
#define CODE_NO_PORT     78

static char port[32] = "8080";
static char open[32] = "tv";
/* Keys the last read handed to the hub (NUL-separated, "KEY=old" when the
   environment already had a value, else "KEY"), so a line deleted since
   then falls back to what the hub would have had instead of lingering */
static char hubKeys[8192];
static size_t hubKeysLen;

static int remembered(const char *key) {
    for (char *k = hubKeys; k < hubKeys + hubKeysLen; k += strlen(k) + 1) {
        size_t kl = strcspn(k, "=");
        if (kl == strlen(key) && _strnicmp(k, key, kl) == 0) return 1;
    }
    return 0;
}

static void trim(char *s) {
    size_t n = strlen(s);
    while (n > 0 && (s[n-1] == '\r' || s[n-1] == '\n' || s[n-1] == ' ' || s[n-1] == '\t')) s[--n] = 0;
    char *p = s;
    while (*p == ' ' || *p == '\t') p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
}

/* settings.ini as one NUL-terminated UTF-8 string (NULL when there is no
   file); *len is its full length, so a NUL inside it shows as strlen < len.
   Notepad's "UTF-8 with BOM" would otherwise glue EF BB BF onto the first
   key, and PowerShell's > / Out-File (UTF-16 by default on 5.1) would read
   as P.O.R.T with no '=' - either way settings silently lost. UTF-16 saved
   without a BOM (some editors' "UCS-2 LE") shows itself by the NUL half of
   an ASCII character in its first two: X 00 is LE, 00 X is BE. */
static char *load_settings(size_t *len) {
    FILE *f = fopen("settings.ini", "rb");
    if (!f) return NULL;
    unsigned char *raw = malloc(65536 + 2);
    size_t n = fread(raw, 1, 65536, f);
    fclose(f);
    raw[n] = raw[n + 1] = 0;
    int le = n >= 2 && raw[0] == 0xFF && raw[1] == 0xFE;
    int be = n >= 2 && raw[0] == 0xFE && raw[1] == 0xFF;
    int bom = le || be;
    if (!bom && n >= 4) { le = raw[1] == 0 && raw[0] != 0; be = raw[0] == 0 && raw[1] != 0; }
    if (le || be) {
        WCHAR *w = (WCHAR *)(raw + (bom ? 2 : 0));
        int wn = (int)((n - (bom ? 2 : 0)) / 2);
        if (be)
            for (int i = 0; i < wn; i++) w[i] = (WCHAR)((w[i] << 8) | (w[i] >> 8));
        int out = WideCharToMultiByte(CP_UTF8, 0, w, wn, NULL, 0, NULL, NULL);
        char *text = malloc(out + 1);
        WideCharToMultiByte(CP_UTF8, 0, w, wn, text, out, NULL, NULL);
        text[out] = 0;
        free(raw);
        *len = (size_t)out;
        return text;
    }
    if (n >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF) { memmove(raw, raw + 3, n - 2); n -= 3; }
    *len = n;
    return (char *)raw;
}

static void read_settings(int first) {
    for (char *k = hubKeys; k < hubKeys + hubKeysLen; k += strlen(k) + 1) {
        char *eq = strchr(k, '=');
        if (eq) *eq++ = 0;
        SetEnvironmentVariableA(k, eq);
    }
    hubKeysLen = 0;

    size_t len = 0;
    char *text = load_settings(&len);
    if (text) {
        int seen = 0, odd = strlen(text) < len;   /* a NUL inside: not text we can read */
        for (char *line = text, *next; line; line = next) {
            next = strchr(line, '\n');
            if (next) *next++ = 0;
            trim(line);
            if (!line[0] || line[0] == ';' || line[0] == '#') continue;
            char *eq = strchr(line, '=');
            if (!eq) { odd++; continue; }
            *eq = 0;
            char *key = line, *val = eq + 1;
            trim(key); trim(val);
            if (!key[0]) { odd++; continue; }
            seen++;
            if (_stricmp(key, "PORT") == 0) { if (first && val[0]) strncpy(port, val, sizeof port - 1); }
            else if (_stricmp(key, "OPEN") == 0) { if (first && val[0]) strncpy(open, val, sizeof open - 1); }
            else {
                if (!remembered(key)) {
                    char stackbuf[1024];
                    char *old = stackbuf, *heapbuf = NULL;
                    DWORD on = GetEnvironmentVariableA(key, old, sizeof stackbuf);
                    int had = on > 0;
                    if (on >= sizeof stackbuf) {
                        /* Too long for the probe buffer - Windows just told us the
                           exact size it needs, so ask again with one that size
                           instead of treating "too long" as "was never set": that
                           used to wipe a long shell-inherited value to NULL the
                           moment its settings.ini override was removed. */
                        heapbuf = (char *)malloc(on);
                        had = 0;
                        if (heapbuf) {
                            DWORD on2 = GetEnvironmentVariableA(key, heapbuf, on);
                            if (on2 > 0 && on2 < on) { old = heapbuf; on = on2; had = 1; }
                        }
                    }
                    size_t kn = strlen(key) + 1, en = kn + (had ? on + 1 : 0);
                    if (hubKeysLen + en <= sizeof hubKeys) {
                        memcpy(hubKeys + hubKeysLen, key, kn);
                        if (had) { hubKeys[hubKeysLen + kn - 1] = '='; memcpy(hubKeys + hubKeysLen + kn, old, on + 1); }
                        hubKeysLen += en;
                    }
                    free(heapbuf);
                }
                SetEnvironmentVariableA(key, val);
            }
        }
        if (!seen && odd) {
            printf("\n  WARNING: settings.ini has no KEY=value lines - is it saved as plain text\n"
                   "  (ANSI, UTF-8 or Unicode)? Using the defaults: port 8080, TV screen, fresh start 09:00.\n");
        }
        free(text);
    }
    if (first) SetEnvironmentVariableA("PORT", port);
}

/* Clicking in a console window with QuickEdit on freezes every program
   writing to it until a key is pressed - the hub would stall mid-game, or
   at its 09:00 restart, because someone selected some text. */
static void quick_edit_off(void) {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode = 0;
    if (in != INVALID_HANDLE_VALUE && GetConsoleMode(in, &mode)) {
        mode &= ~ENABLE_QUICK_EDIT_MODE;
        mode |= ENABLE_EXTENDED_FLAGS;
        SetConsoleMode(in, mode);
    }
}

int main(void) {
    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    char *slash = strrchr(exePath, '\\');
    if (slash) *slash = 0;
    SetCurrentDirectoryA(exePath);
    quick_edit_off();

    /* Tells the hub someone will bring it back, so it may restart itself -
       and which process that is, so it can tell if this window has gone */
    char pid[32];
    snprintf(pid, sizeof pid, "%lu", (unsigned long)GetCurrentProcessId());
    SetEnvironmentVariableA("WINCHESTER_SUPERVISED", "1");
    SetEnvironmentVariableA("WINCHESTER_LAUNCHER_PID", pid);

    printf("\n  Starting The Winchester darts hub...\n");

    int first = 1, browserOpened = 0;
    DWORD code = 0;
    for (;;) {
        read_settings(first);
        char cmd[] = "\"runtime\\node.exe\" \"server\\server.js\"";
        STARTUPINFOA si; PROCESS_INFORMATION pi;
        ZeroMemory(&si, sizeof si); si.cb = sizeof si;
        ZeroMemory(&pi, sizeof pi);
        if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
            printf("\n  ERROR: could not start runtime\\node.exe (code %lu).\n", GetLastError());
            printf("  Is the zip fully extracted, with the runtime and server folders beside this exe?\n");
            printf("\n  Press Enter to close...");
            getchar();
            return 1;
        }
        DWORD started = GetTickCount();

        /* The browser opens once per launch of the exe - the first time a hub
           is still up after its port-binding grace, so a hub that has already
           said "already running" gets no TV window on top of it, and a first
           try that found no free port still gets one when the retry comes up
           - and never again, or every daily restart would stack another. */
        if (!browserOpened && _stricmp(open, "none") != 0
            && WaitForSingleObject(pi.hProcess, 2500) == WAIT_TIMEOUT) {
            char url[128];
            snprintf(url, sizeof url, "http://localhost:%s/%s", port, open);
            ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWMAXIMIZED);
            browserOpened = 1;
        }
        first = 0;

        WaitForSingleObject(pi.hProcess, INFINITE);
        code = 0;
        GetExitCodeProcess(pi.hProcess, &code);
        CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
        DWORD ranMs = GetTickCount() - started;

        if (code == CODE_FRESH_START) {
            printf("\n  Daily fresh start - bringing the hub straight back...\n");
            Sleep(1000);
            continue;
        }
        if (code == CODE_IN_USE) break;       /* the hub has said why */
        if (code == CODE_NO_PORT) {
            printf("\n  No free port for the hub right now - trying again in 30 seconds...\n");
            Sleep(30000);
            continue;
        }
        /* An unexpected stop after a good run: come back by ourselves. One
           that dies within a minute of starting is a setup problem (files,
           permissions) - stop and show it rather than loop forever. */
        if (code != 0 && ranMs > 60000) {
            printf("\n  Darts hub stopped unexpectedly (code %lu) - restarting in 5 seconds...\n", code);
            Sleep(5000);
            continue;
        }
        break;
    }

    printf("\n  Darts hub stopped (code %lu).\n", code);
    printf("  Press Enter to close...");
    getchar();
    return (int)code;
}
