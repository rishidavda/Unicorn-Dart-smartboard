/*
 * WinchesterDarts.exe - starts the darts hub, opens the TV screen, and keeps
 * the hub running: it relaunches the hub after its daily fresh start (exit
 * code 75) and after an unexpected stop, so the oche never stays dark.
 *
 * Reads settings.ini (optional) from its own folder - again before every
 * relaunch, so an edited DAILY_RESTART takes effect at the next fresh start:
 *   PORT=8080
 *   OPEN=tv                ; tv | pad | none  - which page to open on this PC
 *   DAILY_RESTART=09:00    ; any other KEY=value is passed to the hub as-is
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

static char port[32];
static char open[32];

static void trim(char *s) {
    size_t n = strlen(s);
    while (n > 0 && (s[n-1] == '\r' || s[n-1] == '\n' || s[n-1] == ' ' || s[n-1] == '\t')) s[--n] = 0;
    char *p = s;
    while (*p == ' ' || *p == '\t') p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
}

static void read_settings(void) {
    strcpy(port, "8080");
    strcpy(open, "tv");
    /* A line deleted since last time must fall back to the default */
    SetEnvironmentVariableA("DAILY_RESTART", NULL);

    FILE *f = fopen("settings.ini", "r");
    if (f) {
        char buf[512];
        int firstLine = 1;
        while (fgets(buf, sizeof buf, f)) {
            char *line = buf;
            /* Notepad's "UTF-8 with BOM" would otherwise glue EF BB BF onto
               the first key and silently lose that setting */
            if (firstLine && (unsigned char)line[0] == 0xEF
                && (unsigned char)line[1] == 0xBB && (unsigned char)line[2] == 0xBF) line += 3;
            firstLine = 0;
            trim(line);
            if (!line[0] || line[0] == ';' || line[0] == '#') continue;
            char *eq = strchr(line, '=');
            if (!eq) continue;
            *eq = 0;
            char *key = line, *val = eq + 1;
            trim(key); trim(val);
            if (_stricmp(key, "PORT") == 0 && val[0]) { strncpy(port, val, sizeof port - 1); }
            else if (_stricmp(key, "OPEN") == 0 && val[0]) { strncpy(open, val, sizeof open - 1); }
            else if (key[0]) SetEnvironmentVariableA(key, val);
        }
        fclose(f);
    }
    SetEnvironmentVariableA("PORT", port);
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

    int first = 1;
    DWORD code = 0;
    for (;;) {
        read_settings();
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

        /* The browser opens once per launch of the exe - never on a relaunch,
           or every daily restart would stack another TV window. */
        if (first && _stricmp(open, "none") != 0) {
            char url[128];
            snprintf(url, sizeof url, "http://localhost:%s/%s", port, open);
            Sleep(2500);                   /* let the service bind its port first */
            ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWMAXIMIZED);
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
