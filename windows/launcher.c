/*
 * DartboardBridge.exe — tiny console launcher for the kcapp smartboard bridge.
 *
 * Reads settings.ini from the folder it lives in, sets the values as
 * environment variables, then runs:  runtime\node.exe app\kcapp-smartboard.js
 *
 * settings.ini format (one KEY=VALUE per line, ';' or '#' start a comment):
 *   KCAPP_API=192.168.1.50
 *   PORT=3000
 *   DEBUG=kcapp*
 *   MODE=board        ; or "mock" to test without the dartboard
 *
 * Build (from Linux): x86_64-w64-mingw32-gcc -O2 -o DartboardBridge.exe launcher.c
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>

/* Overridable at compile time so the same launcher works in layouts where
 * node and the app live elsewhere (e.g. the KcappOneBox package). */
#ifndef NODE_EXE
#define NODE_EXE "runtime\\node.exe"
#endif
#ifndef APP_JS
#define APP_JS "app\\kcapp-smartboard.js"
#endif

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

    printf("=== kcapp smartboard bridge for Windows ===\n");

    int mock = 0;
    FILE *f = fopen("settings.ini", "r");
    if (f) {
        char line[512];
        while (fgets(line, sizeof line, f)) {
            trim(line);
            if (line[0] == 0 || line[0] == ';' || line[0] == '#') continue;
            char *eq = strchr(line, '=');
            if (!eq) continue;
            *eq = 0;
            char *key = line, *val = eq + 1;
            trim(key); trim(val);
            if (_stricmp(key, "MODE") == 0) {
                mock = (_stricmp(val, "mock") == 0);
            } else if (key[0]) {
                SetEnvironmentVariableA(key, val);
                printf("  %s=%s\n", key, val);
            }
        }
        fclose(f);
    } else {
        printf("  (no settings.ini found - using defaults: KCAPP_API=localhost PORT=3000)\n");
        SetEnvironmentVariableA("DEBUG", "kcapp*");
    }

    if (mock) {
        printf("  MODE=mock - running WITHOUT Bluetooth (type darts like 20-3 at the prompt)\n");
        /* mock is selected by NOT setting NODE_ENV=prod */
    } else {
        SetEnvironmentVariableA("NODE_ENV", "prod");
    }
    printf("\n");

    char cmd[] = "\"" NODE_EXE "\" \"" APP_JS "\"";
    STARTUPINFOA si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof si); si.cb = sizeof si;
    ZeroMemory(&pi, sizeof pi);
    if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        printf("ERROR: could not start runtime\\node.exe (code %lu).\n", GetLastError());
        printf("Is the zip fully extracted, with the runtime and app folders next to this exe?\n");
        printf("\nPress Enter to close...");
        getchar();
        return 1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);

    printf("\nBridge exited with code %lu.\n", code);
    printf("Press Enter to close...");
    getchar();
    return (int)code;
}
