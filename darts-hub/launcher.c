/*
 * WinchesterDarts.exe - starts the darts hub, opens the TV screen, and keeps
 * the hub running: it relaunches the hub after its daily fresh start (exit
 * code 75) and after an unexpected stop, so the oche never stays dark.
 *
 * Reads settings.ini (optional) from its own folder:
 *   PORT=8080
 *   OPEN=tv                ; tv | pad | none  - which page to open on this PC
 *   DAILY_RESTART=09:00    ; any other KEY=value is passed to the hub as-is
 *
 * Build: x86_64-w64-mingw32-gcc -O2 -s -o WinchesterDarts.exe launcher.c -lshell32
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <string.h>

static void trim(char *s) {
    size_t n = strlen(s);
    while (n > 0 && (s[n-1] == '\r' || s[n-1] == '\n' || s[n-1] == ' ' || s[n-1] == '\t')) s[--n] = 0;
    char *p = s;
    while (*p == ' ' || *p == '\t') p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
}

int main(void) {
    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    char *slash = strrchr(exePath, '\\');
    if (slash) *slash = 0;
    SetCurrentDirectoryA(exePath);

    char port[32] = "8080";
    char open[32] = "tv";

    FILE *f = fopen("settings.ini", "r");
    if (f) {
        char line[512];
        while (fgets(line, sizeof line, f)) {
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
    /* Tells the hub someone will bring it back, so it may restart itself */
    SetEnvironmentVariableA("WINCHESTER_SUPERVISED", "1");

    printf("\n  Starting The Winchester darts hub...\n");

    int first = 1;
    DWORD code = 0;
    for (;;) {
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

        /* The browser opens once per launch of the exe - never on a relaunch,
           or every daily restart would stack another TV window. */
        if (first && _stricmp(open, "none") != 0) {
            char url[128];
            snprintf(url, sizeof url, "http://localhost:%s/%s", port, open);
            Sleep(2500);                   /* let the service bind its port first */
            ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWMAXIMIZED);
        }
        first = 0;

        DWORD started = GetTickCount();
        WaitForSingleObject(pi.hProcess, INFINITE);
        code = 0;
        GetExitCodeProcess(pi.hProcess, &code);
        CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
        DWORD ranMs = GetTickCount() - started;

        if (code == 75) {
            printf("\n  Daily fresh start - bringing the hub straight back...\n");
            Sleep(1000);
            continue;
        }
        /* An unexpected stop after a good run: come back by ourselves. One
           that dies within a minute of starting is a setup problem (port,
           files) - stop and show it rather than loop forever. */
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
