#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define ABI_VERSION 1
#define SCHEMA_VERSION 6

typedef struct {
    void* ptr;
    size_t len;
} cliproxy_buffer_t;

typedef int32_t (*cliproxy_host_call_fn)(
    void* host_ctx,
    const char* method,
    const uint8_t* request,
    size_t request_len,
    cliproxy_buffer_t* response
);

typedef void (*cliproxy_host_free_fn)(void* ptr, size_t len);

typedef struct {
    uint32_t abi_version;
    void* host_ctx;
    cliproxy_host_call_fn call;
    cliproxy_host_free_fn free_buffer;
} cliproxy_host_api_t;

typedef int32_t (*cliproxy_plugin_call_fn)(
    const char* method,
    const uint8_t* request,
    size_t request_len,
    cliproxy_buffer_t* response
);

typedef void (*cliproxy_plugin_free_fn)(void* ptr, size_t len);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
    uint32_t abi_version;
    cliproxy_plugin_call_fn call;
    cliproxy_plugin_free_fn free_buffer;
    cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api_t;

static const cliproxy_host_api_t* g_host = NULL;
static void log_record(const char* label) {
    const char* path = getenv("MAHOQUOT_PLUGIN_FIXTURE_LOG");
    if (!path) return;
    FILE* f = fopen(path, "a");
    if (f) {
        fprintf(f, "%s\n", label);
        fclose(f);
    }
}

static struct {
    void* ptr;
    unsigned long id;
} g_buffers[256];
static unsigned long g_next_buffer_id = 1;

static void log_buffer_record(const char* operation, void* ptr) {
    char label[96];
    unsigned long id = 0;
    size_t slot = sizeof(g_buffers) / sizeof(g_buffers[0]);
    if (strcmp(operation, "alloc") == 0) {
        for (size_t i = 0; i < sizeof(g_buffers) / sizeof(g_buffers[0]); i++) {
            if (!g_buffers[i].ptr) { slot = i; break; }
        }
        if (slot < sizeof(g_buffers) / sizeof(g_buffers[0])) {
            id = g_next_buffer_id++;
            g_buffers[slot].ptr = ptr;
            g_buffers[slot].id = id;
        }
    } else {
        for (size_t i = 0; i < sizeof(g_buffers) / sizeof(g_buffers[0]); i++) {
            if (g_buffers[i].ptr == ptr) {
                slot = i;
                id = g_buffers[i].id;
                g_buffers[i].ptr = NULL;
                g_buffers[i].id = 0;
                break;
            }
        }
    }
    snprintf(label, sizeof(label), "%s:%lu", operation, id);
    log_record(label);
}

static void respond_with_json(cliproxy_buffer_t* response, const char* value) {
    size_t len = strlen(value);
    void* mem = malloc(len);
    log_buffer_record("alloc", mem);
    memcpy(mem, value, len);
    response->ptr = mem;
    response->len = len;
}

static void free_plugin_buffer(void* ptr, size_t len) {
    (void)len;
    log_buffer_record("free", ptr);
    if (ptr) {
        free(ptr);
    }
}

static void shutdown_plugin(void) {
    log_record("shutdown_called");
}

static int32_t plugin_call(
    const char* method,
    const uint8_t* request,
    size_t request_len,
    cliproxy_buffer_t* response
) {
    (void)request;
    (void)request_len;
    if (!method || !response) return 1;

    char msg[256];
    snprintf(msg, sizeof(msg), "call:%s", method);
    log_record(msg);

    if (strcmp(method, "plugin.register") == 0) {
        if (g_host && g_host->call) {
            cliproxy_buffer_t host_resp = {0, 0};
            const char* host_req = "{\"message\":\"hello from plugin\"}";
            int32_t host_rc = g_host->call(
                g_host->host_ctx,
                "host.log",
                (const uint8_t*)host_req,
                strlen(host_req),
                &host_resp
            );
            if (host_rc == 0) {
                log_record("host_callback_succeeded");
            }
            if (host_resp.ptr && g_host->free_buffer) {
                char label[96];
                snprintf(label, sizeof(label), "host_free:%p", host_resp.ptr);
                log_record(label);
                g_host->free_buffer(host_resp.ptr, host_resp.len);
                log_record("host_free_buffer_called");
            }
        }

#ifdef FIXTURE_DUPLICATE_REGISTRATION
        const char* reg_json = "{\"ok\":true,\"result\":{\"schema_version\":6,\"metadata\":{\"name\":\"test-plugin-duplicate\"}}}";
        respond_with_json(response, reg_json);
#else
        const char* reg_json = "{\"ok\":true,\"result\":{\"schema_version\":6,\"metadata\":{\"name\":\"test-fixture-plugin\"},\"capabilities\":{\"request_translator\":true,\"request_normalizer\":true,\"quota_provider\":true}}}";
        respond_with_json(response, reg_json);
#endif
        return 0;
    }

    if (strcmp(method, "plugin.quiesce") == 0) {
        const char* q_json = "{\"ok\":true,\"result\":{\"status\":\"quiesced\"}}";
        respond_with_json(response, q_json);
        return 0;
    }

    if (strcmp(method, "quota.fetch") == 0) {
        log_record("quota.fetch");
        respond_with_json(response, "{\"ok\":true,\"result\":{\"quota\":\"fixture-quota\",\"remaining\":7}}");
        return 0;
    }

    if (strcmp(method, "quota.reset") == 0) {
        log_record("quota.reset");
        respond_with_json(response, "{\"ok\":true,\"result\":{\"status\":\"fixture-reset\"}}");
        return 0;
    }

    if (strcmp(method, "request.normalize") == 0 || strcmp(method, "request.translate") == 0) {
        log_record("hook_normalize_or_translate_invoked");
        const char* tr_json = "{\"ok\":true,\"result\":{\"Body\":\"dHJhbnNmb3JtZWQtcGF5bG9hZA==\"}}";
        respond_with_json(response, tr_json);
        return 0;
    }

    const char* ok_json = "{\"ok\":true,\"result\":{}}";
    respond_with_json(response, ok_json);
    return 0;
}

#ifdef __cplusplus
extern "C" {
#endif

int32_t cliproxy_plugin_init(const cliproxy_host_api_t* host, cliproxy_plugin_api_t* plugin) {
    log_record("init_called");
    g_host = host;

    if (!plugin) return 1;

#ifdef FIXTURE_WRONG_ABI_VERSION
    plugin->abi_version = 999;
#else
    plugin->abi_version = ABI_VERSION;
#endif

    plugin->call = plugin_call;
    plugin->free_buffer = free_plugin_buffer;
    plugin->shutdown = shutdown_plugin;

    return 0;
}

#ifdef __cplusplus
}
#endif
