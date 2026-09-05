#define WCDB_API_BUILD
#include "wcdb_api.h"

#include "query_executor.hpp"
#include "runtime.hpp"

#include <cstdlib>
#include <exception>

extern "C" {

WCDB_API_EXPORT int32_t wcdb_check_license(void)
{
    // The independent implementation intentionally has no cloud-license subsystem.
    // Returning the documented unsupported/legacy status avoids pretending that a
    // commercial lease was validated.
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT int32_t wcdb_close_account(int64_t handle)
{
    try {
        return wcdb_native::runtime().close_account(handle);
    } catch (const std::exception&) {
        return wcdb_native::kStatusInternal;
    }
}

WCDB_API_EXPORT int32_t wcdb_close_message_cursor(int64_t handle, int64_t cursor)
{
    (void)handle;
    (void)cursor;
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT int32_t wcdb_exec_query(
    int64_t handle,
    const char* kind,
    const char* path,
    const char* sql,
    void** out_json)
{
    if (out_json != nullptr) {
        *out_json = nullptr;
    }
    try {
        return wcdb_native::execute_query(handle, kind, path, sql, out_json);
    } catch (const std::exception&) {
        return wcdb_native::kStatusQueryFailed;
    }
}

WCDB_API_EXPORT int32_t wcdb_export_message_chunk(
    int64_t handle,
    const char* kind,
    const char* path,
    const char* table_name,
    int64_t after_rid,
    int32_t max_rows,
    int32_t start_time,
    int32_t end_time,
    const char* extra_cols_json,
    void** out_json)
{
    (void)handle;
    (void)kind;
    (void)path;
    (void)table_name;
    (void)after_rid;
    (void)max_rows;
    (void)start_time;
    (void)end_time;
    (void)extra_cols_json;
    if (out_json != nullptr) {
        *out_json = nullptr;
    }
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT int32_t wcdb_fetch_message_batch(
    int64_t handle,
    int64_t cursor,
    void** out_json,
    int32_t* out_has_more)
{
    (void)handle;
    (void)cursor;
    if (out_json != nullptr) {
        *out_json = nullptr;
    }
    if (out_has_more != nullptr) {
        *out_has_more = 0;
    }
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT void wcdb_free_string(void* value)
{
    std::free(value);
}

WCDB_API_EXPORT int32_t wcdb_get_logs(void** out_json)
{
    if (out_json != nullptr) {
        *out_json = nullptr;
    }
    try {
        return wcdb_native::runtime().get_logs(out_json);
    } catch (const std::exception&) {
        return wcdb_native::kStatusInternal;
    }
}

WCDB_API_EXPORT int32_t wcdb_get_sns_timeline(
    int64_t handle,
    int32_t limit,
    int32_t offset,
    const char* usernames_json,
    const char* keyword,
    int32_t start_time,
    int32_t end_time,
    void** out_json)
{
    (void)handle;
    (void)limit;
    (void)offset;
    (void)usernames_json;
    (void)keyword;
    (void)start_time;
    (void)end_time;
    if (out_json != nullptr) {
        *out_json = nullptr;
    }
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT int32_t wcdb_init(void)
{
    try {
        return wcdb_native::runtime().init();
    } catch (const std::exception&) {
        return wcdb_native::kStatusInternal;
    }
}

WCDB_API_EXPORT int32_t wcdb_open_account(
    const char* db_path,
    const char* key,
    int64_t* out_handle)
{
    if (out_handle != nullptr) {
        *out_handle = 0;
    }
    try {
        return wcdb_native::runtime().open_account(db_path, key, out_handle);
    } catch (const std::exception&) {
        return wcdb_native::kStatusInternal;
    }
}

WCDB_API_EXPORT int32_t wcdb_open_message_cursor(
    int64_t handle,
    const char* session_id,
    int32_t batch_size,
    int32_t ascending,
    int32_t begin_timestamp,
    int32_t end_timestamp,
    int64_t* out_cursor)
{
    (void)handle;
    (void)session_id;
    (void)batch_size;
    (void)ascending;
    (void)begin_timestamp;
    (void)end_timestamp;
    if (out_cursor != nullptr) {
        *out_cursor = 0;
    }
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT int32_t wcdb_open_message_cursor_lite(
    int64_t handle,
    const char* session_id,
    int32_t batch_size,
    int32_t ascending,
    int32_t begin_timestamp,
    int32_t end_timestamp,
    int64_t* out_cursor)
{
    return wcdb_open_message_cursor(handle, session_id, batch_size, ascending,
                                     begin_timestamp, end_timestamp, out_cursor);
}

WCDB_API_EXPORT int32_t wcdb_set_app_version(const char* version)
{
    try {
        return wcdb_native::runtime().set_app_version(version);
    } catch (const std::exception&) {
        return wcdb_native::kStatusInternal;
    }
}

WCDB_API_EXPORT int32_t wcdb_set_client_info(
    const char* application_id,
    const char* client_type,
    const char* app_version)
{
    try {
        return wcdb_native::runtime().set_client_info(application_id, client_type, app_version);
    } catch (const std::exception&) {
        return wcdb_native::kStatusInternal;
    }
}

WCDB_API_EXPORT int32_t wcdb_set_my_wxid(int64_t handle, const char* wxid)
{
    (void)handle;
    (void)wxid;
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT int32_t wcdb_set_trusted_time(int64_t unix_time)
{
    (void)unix_time;
    return wcdb_native::kStatusUnsupported;
}

WCDB_API_EXPORT void wcdb_shutdown(void)
{
    try {
        wcdb_native::runtime().shutdown();
    } catch (const std::exception&) {
        // Shutdown is deliberately idempotent and must not throw across the C ABI.
    }
}

} // extern "C"
