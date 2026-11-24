/* Shared JSON framing for the observed native command bus.
 * Reply identity is rsp + sno; result semantics belong to each command.
 * native_respond takes ownership of param and never logs payload contents. */
#ifndef WELINK_NATIVE_RPC_H
#define WELINK_NATIVE_RPC_H

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <json-c/json.h>

typedef int (*native_callback)(const char *json);

struct native_request {
    struct json_object *root;
    struct json_object *param;
    int64_t cmd;
};

static inline struct json_object *native_get(struct json_object *object, const char *key)
{
    struct json_object *value = NULL;
    if (object && json_object_is_type(object, json_type_object))
        json_object_object_get_ex(object, key, &value);
    return value;
}

static inline const char *native_string(struct json_object *object, const char *key,
                                        const char *missing)
{
    struct json_object *value = native_get(object, key);
    return json_object_is_type(value, json_type_string)
        ? json_object_get_string(value) : missing;
}

static inline int64_t native_integer(struct json_object *object, const char *key,
                                     int64_t missing)
{
    struct json_object *value = native_get(object, key);
    return json_object_is_type(value, json_type_int)
        ? json_object_get_int64(value) : missing;
}

static inline int native_parse(struct native_request *request, const char *text)
{
    memset(request, 0, sizeof(*request));
    if (!text) return EINVAL;
    size_t length = strlen(text);
    if (length >= INT_MAX) return EOVERFLOW;
    struct json_tokener *tokener = json_tokener_new();
    if (!tokener) return ENOMEM;
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *root = json_tokener_parse_ex(tokener, text, (int)length + 1);
    enum json_tokener_error error = json_tokener_get_error(tokener);
    json_tokener_free(tokener);
    if (error != json_tokener_success || !json_object_is_type(root, json_type_object) ||
        !json_object_is_type(native_get(root, "cmd"), json_type_int) ||
        !json_object_is_type(native_get(root, "sno"), json_type_int)) {
        json_object_put(root);
        return EINVAL;
    }
    request->root = root;
    request->param = native_get(root, "param");
    request->cmd = json_object_get_int64(native_get(root, "cmd"));
    return 0;
}

static inline void native_release(struct native_request *request)
{
    json_object_put(request->root);
    memset(request, 0, sizeof(*request));
}

static inline int native_respond(native_callback callback,
                                  const struct native_request *request, int64_t result,
                                  struct json_object *param)
{
    if (!callback) {
        json_object_put(param);
        return -ENODEV;
    }
    struct json_object *reply = json_object_new_object();
    struct json_object *result_value = json_object_new_int64(result);
    if (!reply || !result_value) {
        json_object_put(reply);
        json_object_put(result_value);
        json_object_put(param);
        return -ENOMEM;
    }
    const unsigned flags = JSON_C_OBJECT_ADD_KEY_IS_NEW | JSON_C_OBJECT_KEY_IS_CONSTANT;
    json_object_object_add_ex(reply, "rsp",
                             json_object_get(native_get(request->root, "cmd")), flags);
    json_object_object_add_ex(reply, "sno",
                             json_object_get(native_get(request->root, "sno")), flags);
    json_object_object_add_ex(reply, "result", result_value, flags);
    struct json_object *description = native_get(request->root, "description");
    if (json_object_is_type(description, json_type_string))
        json_object_object_add_ex(reply, "description", json_object_get(description), flags);
    if (param) json_object_object_add_ex(reply, "param", param, flags);
    const char *encoded = json_object_to_json_string_ext(reply, JSON_C_TO_STRING_PLAIN);
    int status = encoded ? 0 : -ENOMEM;
    if (encoded) callback(encoded);
    json_object_put(reply);
    return status;
}

#endif
