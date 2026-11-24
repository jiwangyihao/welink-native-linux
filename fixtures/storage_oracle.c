/* Original synthetic-only database oracle, recovered unchanged from Main H:2582.
 * Runs only in the disposable offline sandbox created by generate_original_storage.py.
 * Never use a production Wine prefix or a real account profile. */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static HANDLE received;
static volatile long long expected_sno = LLONG_MIN;
static long long message_sno(const char *json)
{
    const char *field = json ? strstr(json, "\"sno\"") : NULL;
    const char *colon = field ? strchr(field, ':') : NULL;
    return colon ? strtoll(colon + 1, NULL, 10) : LLONG_MIN;
}
static int __cdecl reply(const char *json)
{
    printf("REPLY %s\n", json ? json : "null");
    fflush(stdout);
    if (message_sno(json) == expected_sno) SetEvent(received);
    return 0;
}
static void quoted(const char *text)
{
    if (!text) { fputs("null", stdout); return; }
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
static int __cdecl sql_row(void *unused, int count, char **values, char **names)
{
    (void)unused;
    fputs("ROW {", stdout);
    for (int i = 0; i < count; ++i) {
        if (i) putchar(',');
        quoted(names[i]); putchar(':'); quoted(values[i]);
    }
    puts("}");
    return 0;
}
static int codec_mode(const char *mode, int argc, char **argv)
{
    HMODULE lib = LoadLibraryExA("Z:\\tmp\\sdk\\wxsqlite.dll", NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!lib) { fprintf(stderr, "codec load error: %lu\n", GetLastError()); return 1; }
    const char *(__cdecl *version)(void) = (void *)GetProcAddress(lib, "sqlite3_libversion");
    const char *(__cdecl *mc_version)(void) = (void *)GetProcAddress(lib, "sqlite3mc_version");
    int (__cdecl *open_db)(const char *, void **) = (void *)GetProcAddress(lib, "sqlite3_open");
    int (__cdecl *close_db)(void *) = (void *)GetProcAddress(lib, "sqlite3_close");
    int (__cdecl *key_db)(void *, const void *, int) = (void *)GetProcAddress(lib, "sqlite3_key");
    int (__cdecl *config)(void *, const char *, int) = (void *)GetProcAddress(lib, "sqlite3mc_config");
    int (__cdecl *cipher_config)(void *, const char *, const char *, int) = (void *)GetProcAddress(lib, "sqlite3mc_config_cipher");
    int (__cdecl *exec)(void *, const char *, int (__cdecl *)(void *,int,char **,char **), void *, char **) = (void *)GetProcAddress(lib, "sqlite3_exec");
    void (__cdecl *free_error)(void *) = (void *)GetProcAddress(lib, "sqlite3_free");
    if (!version || !mc_version || !open_db || !close_db || !key_db || !config || !cipher_config || !exec || !free_error) return 2;
    void *db = NULL;
    int info = strcmp(mode, "codec-info") == 0;
    if (!info && argc < 4) return 2;
    int rc = open_db(info ? ":memory:" : argv[2], &db);
    if (rc) { fprintf(stderr, "sqlite open error: %d\n", rc); return 3; }
    if (info) {
        printf("INFO {\"sqlite\":"); quoted(version());
        fputs(",\"codec\":", stdout); quoted(mc_version());
        printf(",\"cipher\":%d,\"default_cipher\":%d}\n", config(db,"cipher",-1),config(NULL,"cipher",-1));
        const char *ciphers[] = {"aes128cbc","aes256cbc","chacha20","sqlcipher","rc4"};
        const char *parameters[] = {"legacy","legacy_page_size","kdf_iter","fast_kdf_iter","hmac_use","hmac_pgno","hmac_salt_mask","kdf_algorithm","hmac_algorithm","plaintext_header_size"};
        for (unsigned i=0; i<sizeof(ciphers)/sizeof(ciphers[0]); ++i)
            for (unsigned j=0; j<sizeof(parameters)/sizeof(parameters[0]); ++j) {
                int value = cipher_config(db,ciphers[i],parameters[j],-1);
                if (value >= 0) printf("PARAM %s %s %d\n",ciphers[i],parameters[j],value);
            }
        char *error = NULL;
        rc = exec(db,"PRAGMA compile_options",sql_row,NULL,&error);
        if (error) { fprintf(stderr,"compile_options: %s\n",error); free_error(error); }
    } else {
        if (argc > 4 && config(db,"cipher",atoi(argv[4])) < 0) { close_db(db); return 4; }
        if (*argv[3]) rc = key_db(db,argv[3],(int)strlen(argv[3]));
        if (rc) { fprintf(stderr,"sqlite key error: %d\n",rc); close_db(db); return 5; }
        char query[65536];
        while (fgets(query,sizeof(query),stdin)) {
            char *error = NULL;
            rc = exec(db,query,sql_row,NULL,&error);
            printf("SQL_RESULT %d\n",rc);
            if (error) { fputs("SQL_ERROR ",stdout); quoted(error); putchar('\n'); free_error(error); }
            fflush(stdout);
            if (rc) break;
        }
    }
    close_db(db);
    return rc ? 6 : 0;
}
int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetDllDirectoryA("Z:\\tmp\\sdk");
    if (strncmp(argv[1],"codec-",6)==0) return codec_mode(argv[1],argc,argv);
    const int im = strcmp(argv[1],"im")==0;
    const char *module = im ? "tup_sqlite_logic_api.dll" : strcmp(argv[1],"common")==0 ? "common_utils.dll" : "sqlite_plugin.dll";
    const char *prefix = strcmp(argv[1],"common")==0 ? "common_utils" : "tup_sqlite";
    char path[256]; snprintf(path,sizeof(path),"Z:\\tmp\\sdk\\%s",module);
    HMODULE lib = LoadLibraryExA(path,NULL,LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!lib) { fprintf(stderr,"SDK load error: %lu\n",GetLastError()); return 1; }
    received = CreateEventA(NULL,TRUE,FALSE,NULL);
    if (!received) return 2;
    void (__cdecl *send)(const char *) = NULL;
    void (__cdecl *shutdown)(void) = NULL;
    if (im) {
        if (argc < 5) return 2;
        int (__cdecl *init)(const char *,const char *,const char *,void *) = (void *)GetProcAddress(lib,"InitSqliteService");
        send = (void *)GetProcAddress(lib,"SqliteServiceSendMsg");
        shutdown = (void *)GetProcAddress(lib,"SqliteServiceShutdown");
        if (!init || !send || !shutdown) return 3;
        printf("INIT_RESULT %d\n",init(argv[2],argv[3],argv[4],(void *)reply));
    } else {
        char symbol[128];
        snprintf(symbol,sizeof(symbol),"%s_init",prefix);
        void (__cdecl *init)(void *) = (void *)GetProcAddress(lib,symbol);
        snprintf(symbol,sizeof(symbol),"%s_send_msg",prefix);
        send = (void *)GetProcAddress(lib,symbol);
        snprintf(symbol,sizeof(symbol),"%s_shutdown",prefix);
        shutdown = (void *)GetProcAddress(lib,symbol);
        snprintf(symbol,sizeof(symbol),"%s_set_log_path",prefix);
        void (__cdecl *log_path)(const char *,int,int,int) = (void *)GetProcAddress(lib,symbol);
        if (!init || !send || !shutdown || !log_path) return 3;
        log_path("Z:\\tmp\\work\\logs",3,10,1);
        init((void *)reply);
    }
    char request[131072];
    while (fgets(request,sizeof(request),stdin)) {
        request[strcspn(request,"\r\n")] = 0;
        expected_sno = message_sno(request);
        ResetEvent(received);
        send(request);
        if (WaitForSingleObject(received,15000)!=WAIT_OBJECT_0) {
            fprintf(stderr,"reply timeout for sno %lld\n",expected_sno); return 4;
        }
    }
    shutdown();
    CloseHandle(received);
    return 0;
}
