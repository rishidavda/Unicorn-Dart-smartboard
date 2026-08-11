/*
 * Console shim that runs scripts\SCRIPT_NAME.ps1 with PowerShell.
 * Compiled three times (Setup/Start/Stop) with -DSCRIPT_NAME=\"...\".
 *
 * Build: x86_64-w64-mingw32-gcc -O2 -s -DSCRIPT_NAME=\"setup\" -o SetupKcapp.exe shim.c
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>

#ifndef SCRIPT_NAME
#define SCRIPT_NAME "setup"
#endif

int main(void) {
    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    char *slash = strrchr(exePath, '\\');
    if (slash) *slash = 0;
    SetCurrentDirectoryA(exePath);

    char cmd[1024];
    snprintf(cmd, sizeof cmd,
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"scripts\\%s.ps1\"",
        SCRIPT_NAME);

    STARTUPINFOA si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof si); si.cb = sizeof si;
    ZeroMemory(&pi, sizeof pi);
    if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        printf("ERROR: could not start PowerShell (code %lu).\n", GetLastError());
        printf("Press Enter to close...");
        getchar();
        return 1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);

    if (code != 0) {
        printf("\nThe step above reported an error (code %lu).\n", code);
    }
    printf("Press Enter to close...");
    getchar();
    return (int)code;
}
