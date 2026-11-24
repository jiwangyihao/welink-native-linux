#define _GNU_SOURCE
#include "ie_internal.h"
#include <archive.h>
#include <archive_entry.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

int ie_component(const char *name)
{
    return name && *name && strcmp(name, ".") && strcmp(name, "..") &&
        !strchr(name, '/') && !strchr(name, '\\') && strlen(name) <= 255;
}
int ie_open_directory(const char *path)
{
    return open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
}
int ie_open_subdir(int parent, const char *name, int create)
{
    if (!ie_component(name)) { errno = EINVAL; return -1; }
    if (create && mkdirat(parent, name, 0700) && errno != EEXIST) return -1;
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
}
char *ie_fd_path(int directory, const char *name)
{
    return g_strdup_printf("/proc/self/fd/%d/%s", directory, name);
}
int ie_read_small(int directory, const char *name, char *output, size_t capacity)
{
    int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return errno;
    struct stat info;
    int error = fstat(fd, &info) ? errno : 0;
    if (!error && (!S_ISREG(info.st_mode) || info.st_size < 0 || (uint64_t)info.st_size >= capacity)) error = EFBIG;
    size_t done = 0;
    while (!error && done < capacity - 1) {
        ssize_t n = read(fd, output + done, capacity - 1 - done);
        if (n < 0) { if (errno == EINTR) continue; error = errno; break; }
        if (!n) break;
        done += (size_t)n;
    }
    if (!error && (uint64_t)info.st_size != done) error = EIO;
    if (!error && memchr(output, 0, done)) error = EBADMSG;
    output[done] = 0;
    close(fd); return error;
}
static int write_all(struct ie_job *job, int fd, const void *data, size_t length)
{
    const unsigned char *cursor = data;
    while (length) {
        if (ie_cancelled(job)) return ECANCELED;
        ssize_t n = write(fd, cursor, MIN(length, IE_CHUNK));
        if (n < 0) { if (errno == EINTR) continue; return errno; }
        if (!n) return EIO;
        cursor += n; length -= (size_t)n;
    }
    return 0;
}
int ie_write_file(struct ie_job *job, int directory, const char *name, const void *data, size_t length)
{
    if (!ie_component(name)) return EINVAL;
    int fd = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return errno;
    int error = fchmod(fd, 0600) ? errno : write_all(job, fd, data, length);
    if (!error && fsync(fd)) error = errno;
    if (close(fd) && !error) error = errno;
    if (error) unlinkat(directory, name, 0);
    return error;
}
static int identical(struct ie_job *job, int a, int b)
{
    unsigned char first[IE_CHUNK], second[IE_CHUNK];
    struct stat sa, sb;
    if (fstat(a, &sa) || fstat(b, &sb) || !S_ISREG(sa.st_mode) || !S_ISREG(sb.st_mode) || sa.st_size != sb.st_size) return 0;
    off_t offset = 0;
    while (offset < sa.st_size) {
        if (ie_cancelled(job)) return 0;
        size_t length = MIN((uint64_t)(sa.st_size - offset), sizeof first);
        ssize_t na = pread(a, first, length, offset), nb = pread(b, second, length, offset);
        if (na < 0 && errno == EINTR) continue;
        if (na <= 0 || nb != na || memcmp(first, second, (size_t)na)) return 0;
        offset += na;
    }
    return 1;
}
int ie_copy_file(struct ie_job *job, int source, const char *name, int target, const char *target_name, int missing_ok, struct stat *created)
{
    if (created) memset(created, 0, sizeof *created);
    if (!ie_component(name) || !ie_component(target_name)) return EINVAL;
    int in = openat(source, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (in < 0) return missing_ok && errno == ENOENT ? 0 : errno;
    struct stat info;
    int error = fstat(in, &info) ? errno : 0;
    if (!error && (!S_ISREG(info.st_mode) || info.st_size < 0 || (uint64_t)info.st_size > IE_MAX_ARCHIVE_BYTES)) error = EINVAL;
    int out = -1;
    if (!error) {
        out = openat(target, target_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (out < 0 && errno == EEXIST) {
            int existing = openat(target, target_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
            int same = existing >= 0 && identical(job, in, existing);
            if (existing >= 0) close(existing);
            close(in); return same ? 0 : EEXIST;
        }
        if (out < 0) error = errno;
        else if (fchmod(out, 0600)) error = errno;
    }
    unsigned char buffer[IE_CHUNK];
    off_t copied = 0;
    while (!error) {
        if (ie_cancelled(job)) { error = ECANCELED; break; }
        ssize_t n = read(in, buffer, sizeof buffer);
        if (n < 0) { if (errno == EINTR) continue; error = errno; break; }
        if (!n) break;
        if ((uint64_t)copied + (size_t)n > IE_MAX_ARCHIVE_BYTES) { error = EFBIG; break; }
        error = write_all(job, out, buffer, (size_t)n); copied += n;
    }
    if (!error && copied != info.st_size) error = EIO;
    if (!error && fsync(out)) error = errno;
    if (!error && created && fstat(out, created)) error = errno;
    if (out >= 0 && close(out) && !error) error = errno;
    close(in);
    if (error && out >= 0) {
        unlinkat(target, target_name, 0);
        if (created) memset(created, 0, sizeof *created);
    }
    return error;
}
int ie_stage(struct ie_job *job, int parent)
{
    unsigned char random[12];
    if (RAND_bytes(random, sizeof random) != 1) return ie_fail(job, 1, "create file failed!");
    char name[64] = ".welink-transfer-";
    for (unsigned i = 0; i < sizeof random; ++i) snprintf(name + 17 + i * 2, 3, "%02x", random[i]);
    /* The prefix is 17 bytes including its trailing dash. */
    if (mkdirat(parent, name, 0700)) return ie_fail(job, 1, "Creat dir failed!");
    job->stage_name = g_strdup(name);
    job->stage_fd = ie_open_subdir(parent, name, 0);
    if (job->stage_fd < 0 || fchmod(job->stage_fd, 0700)) return ie_fail(job, 1, "Creat dir failed!");
    return 0;
}
int ie_remove_tree(int directory)
{
    int duplicate = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    DIR *entries = duplicate < 0 ? NULL : fdopendir(duplicate);
    if (!entries) { int error = errno; if (duplicate >= 0) close(duplicate); return error; }
    int error = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(entries);
        if (!entry) { if (errno && !error) error = errno; break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        struct stat info;
        if (fstatat(directory, entry->d_name, &info, AT_SYMLINK_NOFOLLOW)) {
            if (!error) error = errno;
            continue;
        }
        if (S_ISDIR(info.st_mode)) {
            int child = ie_open_subdir(directory, entry->d_name, 0);
            int nested = child < 0 ? errno : ie_remove_tree(child);
            if (nested && !error) error = nested;
            if (child >= 0) close(child);
            if (unlinkat(directory, entry->d_name, AT_REMOVEDIR) && !error) error = errno;
        } else if (unlinkat(directory, entry->d_name, 0) && !error) error = errno;
    }
    if (closedir(entries) && !error) error = errno;
    return error;
}
int ie_publish(struct ie_job *job, int parent, const char *inside, const char *stem, const char *extension)
{
    if (ie_commit_point(job)) return -1;
    for (unsigned n = 0; n <= 100; ++n) {
        char *name = n ? g_strdup_printf("%s(%u)%s", stem, n, extension) : g_strconcat(stem, extension, NULL);
        int rc = syscall(SYS_renameat2, job->stage_fd, inside, parent, name, 1 /* RENAME_NOREPLACE */);
        int error = errno; g_free(name);
        if (!rc) return fsync(parent) ? ie_fail(job, 1, "output directory sync failed") : 0;
        if (error != EEXIST) return ie_fail(job, error == ENOSPC ? 27 : 1, "output publication failed");
    }
    return ie_fail(job, 1, "output names already exist");
}
static int pack_file(struct ie_job *job, struct archive *zip, int directory, const char *name)
{
    int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat info;
    int error = fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_size < 0;
    struct archive_entry *entry = archive_entry_new();
    char *member = g_strconcat("importMsgTempFile/", name, NULL);
    if (!entry) error = 1;
    if (!error) {
        archive_entry_set_pathname(entry, member);
        archive_entry_set_filetype(entry, AE_IFREG);
        archive_entry_set_perm(entry, 0600);
        archive_entry_set_size(entry, info.st_size);
        if (archive_write_header(zip, entry) != ARCHIVE_OK) error = 1;
    }
    char buffer[IE_CHUNK]; off_t done = 0;
    while (!error) {
        if (ie_cancelled(job)) { error = 1; break; }
        ssize_t n = read(fd, buffer, sizeof buffer);
        if (n < 0) { if (errno == EINTR) continue; error = 1; break; }
        if (!n) break;
        if (archive_write_data(zip, buffer, (size_t)n) != n) { error = 1; break; }
        done += n;
    }
    if (!error && done != info.st_size) error = 1;
    OPENSSL_cleanse(buffer, sizeof buffer);
    if (entry) archive_entry_free(entry);
    g_free(member); close(fd); return error ? -1 : 0;
}
int ie_pack(struct ie_job *job, int directory, const char *name)
{
    int data = ie_open_subdir(job->stage_fd, "importMsgTempFile", 0);
    int fd = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    struct archive *zip = archive_write_new();
    int error = data < 0 || fd < 0 || !zip;
    if (!error && fchmod(fd, 0600)) error = 1;
    if (!error && (archive_write_set_format_zip(zip) != ARCHIVE_OK ||
        archive_write_set_options(zip, "zip:compression=deflate") != ARCHIVE_OK || archive_write_open_fd(zip, fd) != ARCHIVE_OK)) error = 1;
    if (!error) error = pack_file(job, zip, data, "history.db") || pack_file(job, zip, data, "config_private.db");
    if (zip) { if (archive_write_close(zip) != ARCHIVE_OK) error = 1; archive_write_free(zip); }
    if (!error && fsync(fd)) error = 1;
    if (fd >= 0 && close(fd)) error = 1;
    if (data >= 0) close(data);
    if (error) { if (fd >= 0) unlinkat(directory, name, 0); return ie_fail(job, 18, "AddFileToZip  failed"); }
    return 0;
}
int ie_unpack(struct ie_job *job, int input)
{
    struct archive *zip = archive_read_new();
    if (!zip) return ie_fail(job, 19, "open zip file error");
    archive_read_support_format_zip(zip);
    int error = archive_read_open_fd(zip, input, IE_CHUNK) != ARCHIVE_OK;
    int target = ie_open_subdir(job->stage_fd, "importMsgTempFile", 1);
    if (target < 0) error = 1;
    unsigned members = 0, seen = 0; uint64_t total = 0;
    struct archive_entry *entry;
    int status = ARCHIVE_EOF;
    char buffer[IE_CHUNK];
    while (!error && (status = archive_read_next_header(zip, &entry)) == ARCHIVE_OK) {
        if (++members > IE_MAX_MEMBERS || ie_cancelled(job)) { error = 1; break; }
        const char *original = archive_entry_pathname_utf8(entry);
        if (!original) { error = 1; break; }
        char *path = g_strdup(original);
        for (char *p = path; *p; ++p) if (*p == '\\') *p = '/';
        if (!strcmp(path, "importMsgTempFile/") && archive_entry_filetype(entry) == AE_IFDIR) { g_free(path); continue; }
        const char *name = NULL; unsigned bit = 0;
        if (!strcmp(path, "importMsgTempFile/history.db")) { name = "history.db"; bit = 1; }
        else if (!strcmp(path, "importMsgTempFile/config_private.db")) { name = "config_private.db"; bit = 2; }
        if (!name || (seen & bit) || archive_entry_filetype(entry) != AE_IFREG ||
            archive_entry_symlink(entry) || archive_entry_hardlink(entry) || archive_entry_is_encrypted(entry) ||
            archive_entry_size(entry) < 0 || (uint64_t)archive_entry_size(entry) > IE_MAX_ARCHIVE_BYTES - total ||
            (bit == 2 && archive_entry_size(entry) > 66)) error = 1;
        int fd = error ? -1 : openat(target, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (fd < 0) error = 1;
        uint64_t written = 0;
        while (!error) {
            la_ssize_t n = archive_read_data(zip, buffer, sizeof buffer);
            if (n < 0) { error = 1; break; }
            if (!n) break;
            if (ie_cancelled(job) || (uint64_t)n > IE_MAX_ARCHIVE_BYTES - total ||
                written + (uint64_t)n > (uint64_t)archive_entry_size(entry) || write_all(job, fd, buffer, (size_t)n)) { error = 1; break; }
            total += (uint64_t)n; written += (uint64_t)n;
        }
        if (!error && written != (uint64_t)archive_entry_size(entry)) error = 1;
        if (!error && fsync(fd)) error = 1;
        if (fd >= 0 && close(fd)) error = 1;
        seen |= bit; g_free(path);
    }
    OPENSSL_cleanse(buffer, sizeof buffer);
    if (status != ARCHIVE_EOF || seen != 3) error = 1;
    if (archive_read_close(zip) != ARCHIVE_OK) error = 1;
    archive_read_free(zip); if (target >= 0) close(target);
    return error ? ie_fail(job, 20, "decompress zip file process error") : 0;
}
