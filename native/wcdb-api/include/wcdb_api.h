#pragma once

#include <stdint.h>

#if defined(_WIN32)
#  if defined(WCDB_API_BUILD)
#    define WCDB_API_EXPORT __declspec(dllexport)
#  else
#    define WCDB_API_EXPORT __declspec(dllimport)
#  endif
#else
#  define WCDB_API_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

WCDB_API_EXPORT int32_t wcdb_check_license(void);
WCDB_API_EXPORT int32_t wcdb_close_account(int64_t handle);
WCDB_API_EXPORT int32_t wcdb_close_message_cursor(int64_t handle, int64_t cursor);
WCDB_API_EXPORT int32_t wcdb_exec_query(
    int64_t handle,
    const char* kind,
    const char* path,
    const char* sql,
    void** out_json);
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
    void** out_json);
WCDB_API_EXPORT int32_t wcdb_fetch_message_batch(
    int64_t handle,
    int64_t cursor,
    void** out_json,
    int32_t* out_has_more);
WCDB_API_EXPORT void wcdb_free_string(void* value);
WCDB_API_EXPORT int32_t wcdb_get_logs(void** out_json);
WCDB_API_EXPORT int32_t wcdb_get_sns_timeline(
    int64_t handle,
    int32_t limit,
    int32_t offset,
    const char* usernames_json,
    const char* keyword,
    int32_t start_time,
    int32_t end_time,
    void** out_json);
WCDB_API_EXPORT int32_t wcdb_init(void);
WCDB_API_EXPORT int32_t wcdb_open_account(
    const char* db_path,
    const char* key,
    int64_t* out_handle);
WCDB_API_EXPORT int32_t wcdb_open_message_cursor(
    int64_t handle,
    const char* session_id,
    int32_t batch_size,
    int32_t ascending,
    int32_t begin_timestamp,
    int32_t end_timestamp,
    int64_t* out_cursor);
WCDB_API_EXPORT int32_t wcdb_open_message_cursor_lite(
    int64_t handle,
    const char* session_id,
    int32_t batch_size,
    int32_t ascending,
    int32_t begin_timestamp,
    int32_t end_timestamp,
    int64_t* out_cursor);
WCDB_API_EXPORT int32_t wcdb_set_app_version(const char* version);
WCDB_API_EXPORT int32_t wcdb_set_client_info(
    const char* application_id,
    const char* client_type,
    const char* app_version);
WCDB_API_EXPORT int32_t wcdb_set_my_wxid(int64_t handle, const char* wxid);
WCDB_API_EXPORT int32_t wcdb_set_trusted_time(int64_t unix_time);
WCDB_API_EXPORT void wcdb_shutdown(void);

#ifdef __cplusplus
}
#endif

