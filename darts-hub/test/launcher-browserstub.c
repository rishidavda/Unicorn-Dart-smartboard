/* Fake browser for launchertest.sh: registered in the Wine prefix as the
 * http: URL handler (HKCR\http\shell\open\command), so the launcher's
 * ShellExecute("open", "http://...") lands here. Appends the URL it was
 * given, and how it was asked to show, to browser.log in the launcher's
 * folder (the cwd it inherits). */
#include <windows.h>
#include <stdio.h>

int main(void) {
    STARTUPINFOA si; GetStartupInfoA(&si);
    char cwd[MAX_PATH]; GetCurrentDirectoryA(MAX_PATH, cwd);
    SYSTEMTIME st; GetLocalTime(&st);
    char p[MAX_PATH + 32];
    snprintf(p, sizeof p, "%s\\browser.log", cwd);
    FILE *f = fopen(p, "a");
    if (!f) return 1;
    fprintf(f, "BROWSER t=%02d:%02d:%02d.%03d cmdline=[%s] showflag=%s wShowWindow=%u\n",
            st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, GetCommandLineA(),
            (si.dwFlags & STARTF_USESHOWWINDOW) ? "yes" : "no", (unsigned)si.wShowWindow);
    fclose(f);
    return 0;
}
