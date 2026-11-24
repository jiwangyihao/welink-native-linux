/* The real WeLink workplace-ticket exchange, recovered from the matched
 * HwmSdk 100.10.5 binaries, not an unrelated Meeting API:
 * hwm_login.dll 0x100d0df0 builds auth type 2 and copies its ticket unchanged
 * into X-Auth-Token; tup_login.dll 0x100260de builds the workplace JSON body.
 * Its routing initializer 0x10002630 selects /v1/usg/acs/login/proxy, and the
 * list at 0x100022f0 adds X-Token-Type: LongTicket to this URL even when the
 * body's authType is ShortTicket. No credentials or device identities live here.
 */
#include "meeting_native_token.h"

#include <curl/curl.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MEETING_AUTH_RESPONSE_MAX (1024U * 1024U)

static pthread_once_t curl_once = PTHREAD_ONCE_INIT;
static CURLcode curl_init_result = CURLE_FAILED_INIT;

static void init_curl(void)
{
    curl_init_result = curl_global_init(CURL_GLOBAL_DEFAULT);
}

int meeting_native_token_transport_init(void)
{
    int error = pthread_once(&curl_once, init_curl);
    if (error) return -error;
    return curl_init_result == CURLE_OK ? 0 : -EIO;
}

struct json_sink {
    struct json_tokener *parser;
    struct json_object *root;
    size_t received;
    int complete;
    int error;
};

static int json_space(unsigned char ch)
{
    return ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n';
}

static size_t receive_json(char *data, size_t size, size_t count, void *opaque)
{
    struct json_sink *sink = opaque;
    if (size && count > SIZE_MAX / size) {
        sink->error = -EOVERFLOW;
        return 0;
    }
    size_t length = size * count;
    if (length > MEETING_AUTH_RESPONSE_MAX - sink->received || length > INT_MAX) {
        sink->error = -EFBIG;
        return 0;
    }
    sink->received += length;
    size_t parsed = 0;
    if (!sink->complete && length) {
        struct json_object *value = json_tokener_parse_ex(sink->parser, data, (int)length);
        enum json_tokener_error error = json_tokener_get_error(sink->parser);
        if (error == json_tokener_continue) return length;
        if (error != json_tokener_success || !json_object_is_type(value, json_type_object)) {
            json_object_put(value);
            sink->error = -EPROTO;
            return 0;
        }
        sink->root = value;
        sink->complete = 1;
        parsed = json_tokener_get_parse_end(sink->parser);
    }
    for (size_t i = parsed; i < length; ++i) {
        if (!json_space((unsigned char)data[i])) {
            sink->error = -EPROTO;
            return 0;
        }
    }
    return length;
}

static int append_header(struct curl_slist **headers, const char *name, const char *value)
{
    if (!value || !*value) return 0;
    if (strpbrk(value, "\r\n")) return -EINVAL;
    char line[4096];
    int length = snprintf(line, sizeof(line), "%s: %s", name, value);
    int overflow = length <= 0 || (size_t)length >= sizeof(line);
    struct curl_slist *next = overflow ? NULL : curl_slist_append(*headers, line);
    /* In particular, do not leave the ticket in this temporary stack buffer. */
    volatile unsigned char *clear = (volatile unsigned char *)line;
    size_t clear_length = overflow ? sizeof(line) : (size_t)length;
    for (size_t i = 0; i < clear_length; ++i) clear[i] = 0;
    if (overflow) return -EOVERFLOW;
    if (!next) return -ENOMEM;
    *headers = next;
    return 0;
}

static void clear_headers(struct curl_slist *headers)
{
    for (struct curl_slist *item = headers; item; item = item->next) {
        size_t length = strlen(item->data);
        volatile unsigned char *data = (volatile unsigned char *)item->data;
        for (size_t i = 0; i < length; ++i) data[i] = 0;
    }
    curl_slist_free_all(headers);
}

static int add_string(struct json_object *object, const char *name, const char *value)
{
    struct json_object *member = json_object_new_string(value);
    if (!member) return -ENOMEM;
    if (json_object_object_add(object, name, member) != 0) {
        json_object_put(member);
        return -ENOMEM;
    }
    return 0;
}

void meeting_native_token_reply_clear(struct meeting_native_token_reply *reply)
{
    if (!reply) return;
    json_object_put(reply->payload);
    memset(reply, 0, sizeof(*reply));
}

enum token_request_kind { TOKEN_EXCHANGE, TOKEN_REFRESH, TOKEN_LOGOUT };

static int request_token(const struct meeting_native_token_config *config,
                         enum token_request_kind kind, const char *credential,
                         struct json_object *body,
                         struct meeting_native_token_reply *reply)
{
    if (!reply) return -EINVAL;
    memset(reply, 0, sizeof(*reply));
    if (!config || !config->server || !*config->server || !config->port ||
        config->port > 65535 || !credential || !*credential) return -EINVAL;
    int status = meeting_native_token_transport_init();
    if (status) return status;

    CURL *curl = curl_easy_init();
    CURLU *endpoint = curl_url();
    struct curl_slist *headers = NULL;
    struct json_sink sink = {.parser = json_tokener_new()};
    char *url = NULL;
    if (!curl || !endpoint || !sink.parser) {
        status = -ENOMEM;
        goto done;
    }
    json_tokener_set_flags(sink.parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    const char *route = kind == TOKEN_EXCHANGE ? "/v1/usg/acs/login/proxy" :
                        kind == TOKEN_REFRESH ? "/v2/usg/acs/token" : "/v1/usg/acs/token";
    const char *method = kind == TOKEN_EXCHANGE ? "POST" :
                         kind == TOKEN_REFRESH ? "PUT" : "DELETE";
    char port[6];
    snprintf(port, sizeof(port), "%u", config->port);
    if (curl_url_set(endpoint, CURLUPART_SCHEME, "https", 0) != CURLUE_OK ||
        curl_url_set(endpoint, CURLUPART_HOST, config->server, 0) != CURLUE_OK ||
        curl_url_set(endpoint, CURLUPART_PORT, port, 0) != CURLUE_OK ||
        curl_url_set(endpoint, CURLUPART_PATH, route, 0) != CURLUE_OK ||
        curl_url_get(endpoint, CURLUPART_URL, &url, 0) != CURLUE_OK) {
        status = -EINVAL;
        goto done;
    }

#define HEADER(name, value) do { status = append_header(&headers, name, value); if (status) goto done; } while (0)
    HEADER("Content-Type", "application/json;charset=UTF-8");
    HEADER("X-Auth-Token", credential);
    HEADER("X-Token-Type", "LongTicket");
    HEADER("User-Agent", config->user_agent);
    HEADER("x-device-id", config->device_id);
    HEADER("x-request-terminal-version", config->terminal_version);
    HEADER("x-request-terminal-appid", config->terminal_appid);
    HEADER("x-request-terminal-platform", config->terminal_platform);
    HEADER("x-request-terminal-devicemodel", config->terminal_device_model);
#undef HEADER

    const char *encoded = body ? json_object_to_json_string_ext(body, JSON_C_TO_STRING_PLAIN) : NULL;
    if (body && !encoded) {
        status = -ENOMEM;
        goto done;
    }
#define OPTION(name, value) do { CURLcode option_error = curl_easy_setopt(curl, name, value); if (option_error != CURLE_OK) { reply->curl_status = option_error; status = -EINVAL; goto done; } } while (0)
    OPTION(CURLOPT_URL, url);
    OPTION(CURLOPT_HTTPHEADER, headers);
    OPTION(CURLOPT_CUSTOMREQUEST, method);
    if (encoded) {
        OPTION(CURLOPT_POSTFIELDS, encoded);
        OPTION(CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)strlen(encoded));
    }
    OPTION(CURLOPT_WRITEFUNCTION, receive_json);
    OPTION(CURLOPT_WRITEDATA, &sink);
    OPTION(CURLOPT_NOSIGNAL, 1L);
    OPTION(CURLOPT_CONNECTTIMEOUT, 15L);
    OPTION(CURLOPT_TIMEOUT, 45L);
    OPTION(CURLOPT_FOLLOWLOCATION, 0L);
    OPTION(CURLOPT_SSL_VERIFYPEER, 1L);
    OPTION(CURLOPT_SSL_VERIFYHOST, 2L);
    /* An absent app proxy means direct access, not inherited proxy credentials. */
    OPTION(CURLOPT_PROXY, config->proxy_url ? config->proxy_url : "");
    if (config->proxy_username && *config->proxy_username)
        OPTION(CURLOPT_PROXYUSERNAME, config->proxy_username);
    if (config->proxy_password && *config->proxy_password)
        OPTION(CURLOPT_PROXYPASSWORD, config->proxy_password);
    if (config->ca_bundle && *config->ca_bundle)
        OPTION(CURLOPT_CAINFO, config->ca_bundle);
#undef OPTION

    reply->curl_status = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &reply->http_status);
    reply->payload = sink.root;
    sink.root = NULL;
    if (sink.error) status = sink.error;
    else if (reply->curl_status != CURLE_OK) status = -EIO;
    else if (reply->http_status != 200) status = -EREMOTEIO;
    else if (kind == TOKEN_LOGOUT && !sink.received) status = 0;
    else if (!sink.complete) status = -EPROTO;
    else if (kind == TOKEN_LOGOUT) status = 0;
    else {
        struct json_object *token = NULL;
        json_object_object_get_ex(reply->payload, "accessToken", &token);
        status = json_object_is_type(token, json_type_string) &&
                 json_object_get_string_len(token) > 0 ? 0 : -EPROTO;
    }
done:
    if (curl) curl_easy_cleanup(curl);
    clear_headers(headers);
    if (endpoint) curl_url_cleanup(endpoint);
    curl_free(url);
    json_object_put(sink.root);
    if (sink.parser) json_tokener_free(sink.parser);
    return status;
}

int meeting_native_exchange_ticket(const struct meeting_native_token_config *config,
                                  const char *account, const char *ticket,
                                  int long_ticket,
                                  struct meeting_native_token_reply *reply)
{
    if (!reply) return -EINVAL;
    memset(reply, 0, sizeof(*reply));
    if (!account || !*account || (long_ticket != 0 && long_ticket != 1)) return -EINVAL;
    struct json_object *body = json_object_new_object();
    if (!body) return -ENOMEM;
    int status = add_string(body, "account", account);
    if (!status) status = add_string(body, "authServerType", "workplace");
    if (!status) status = add_string(body, "authType", long_ticket ? "LongTicket" : "ShortTicket");
    if (!status) status = request_token(config, TOKEN_EXCHANGE, ticket, body, reply);
    json_object_put(body);
    return status;
}

/* This is the actual execRefreshToken call in the vendor WebRTC client, also
 * present as auth type 15 in the matched native SDK's routing table. */
int meeting_native_refresh_token(const struct meeting_native_token_config *config,
                                 const char *refresh_token,
                                 struct meeting_native_token_reply *reply)
{
    return request_token(config, TOKEN_REFRESH, refresh_token, NULL, reply);
}

/* HTTP 200 (including its documented empty response) confirms real revocation.
 * The access token is never substituted with a different session's credential. */
int meeting_native_logout_token(const struct meeting_native_token_config *config,
                                const char *access_token,
                                struct meeting_native_token_reply *reply)
{
    return request_token(config, TOKEN_LOGOUT, access_token, NULL, reply);
}
