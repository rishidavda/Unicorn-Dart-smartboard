/* Fake runtime\node.exe for launchertest.sh (built with mingw, run under Wine).
 * Appends one line per run to <appdir>\stub.log - the environment the launcher
 * gave it - then follows line N of <appdir>\scenario.txt for its Nth run:
 *   "exit C"  |  "sleep S exit C"  |  either followed by " iniK"
 * " iniK" copies <appdir>\settingsK.ini over settings.ini at the start of the
 * run, i.e. "staff edited the file while the hub was running". Past the end
 * of the scenario it logs BEYOND-SCENARIO and exits 0. */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void envfield(FILE *lf, const char *name) {
    char buf[1024];
    DWORD n = GetEnvironmentVariableA(name, buf, sizeof buf);
    if (n == 0 && GetLastError() == ERROR_ENVVAR_NOT_FOUND) fprintf(lf, " %s=<unset>", name);
    else fprintf(lf, " %s=[%s]", name, buf);
}

static void stamp(FILE *lf) {
    SYSTEMTIME st; GetLocalTime(&st);
    fprintf(lf, "t=%02d:%02d:%02d.%03d", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
}

int main(int argc, char **argv) {
    char app[MAX_PATH];
    GetModuleFileNameA(NULL, app, MAX_PATH);
    char *s = strrchr(app, '\\'); if (s) *s = 0;      /* ...\runtime */
    s = strrchr(app, '\\'); if (s) *s = 0;            /* ...\app */

    char p[MAX_PATH + 32];
    int run = 1;
    snprintf(p, sizeof p, "%s\\stub.count", app);
    FILE *c = fopen(p, "r");
    if (c) { if (fscanf(c, "%d", &run) == 1) run++; else run = 1; fclose(c); }
    c = fopen(p, "w"); fprintf(c, "%d\n", run); fclose(c);

    char action[128] = "";
    snprintf(p, sizeof p, "%s\\scenario.txt", app);
    FILE *sc = fopen(p, "r");
    if (sc) {
        char line[128]; int i = 0;
        while (fgets(line, sizeof line, sc)) {
            if (++i == run) { line[strcspn(line, "\r\n")] = 0; strcpy(action, line); break; }
        }
        fclose(sc);
    }

    snprintf(p, sizeof p, "%s\\stub.log", app);
    FILE *lf = fopen(p, "a");
    fprintf(lf, "run=%d ", run); stamp(lf);
    envfield(lf, "PORT");
    envfield(lf, "OPEN");
    envfield(lf, "DAILY_RESTART");
    envfield(lf, "DARTS_DATA");
    envfield(lf, "CUSTOM");
    envfield(lf, "WINCHESTER_SUPERVISED");
    envfield(lf, "WINCHESTER_LAUNCHER_PID");
    {
        DWORD cm = 0; HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
        if (GetConsoleMode(in, &cm)) fprintf(lf, " quickEdit=%s", (cm & 0x0040) ? "ON" : "off");
        else fprintf(lf, " quickEdit=n/a(no console)");
    }
    fprintf(lf, " argc=%d", argc);
    for (int i = 0; i < argc; i++) fprintf(lf, " argv[%d]=[%s]", i, argv[i]);
    fprintf(lf, " action=[%s]\n", action[0] ? action : "BEYOND-SCENARIO exit 0");
    fclose(lf);

    char *ini = strstr(action, " ini");
    if (ini) {
        char a[MAX_PATH + 32], b[MAX_PATH + 32];
        snprintf(a, sizeof a, "%s\\settings%d.ini", app, atoi(ini + 4));
        snprintf(b, sizeof b, "%s\\settings.ini", app);
        CopyFileA(a, b, FALSE);
    }
    int secs = 0, code = 0;
    if (sscanf(action, "sleep %d exit %d", &secs, &code) == 2) { Sleep((DWORD)secs * 1000); }
    else if (sscanf(action, "exit %d", &code) == 1) { }
    else code = 0;

    lf = fopen(p, "a");
    fprintf(lf, "  run=%d exiting code=%d ", run, code); stamp(lf); fprintf(lf, "\n");
    fclose(lf);
    return code;
}
