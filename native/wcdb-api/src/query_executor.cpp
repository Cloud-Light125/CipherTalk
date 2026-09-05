#include "query_executor.hpp"

#include "json_serializer.hpp"
#include "runtime.hpp"
#include "sqlite_session.hpp"

#include <cstddef>
#include <exception>
#include <mutex>
#include <utility>

namespace wcdb_native {

namespace {

bool valid_kind(const char* kind)
{
    if (kind == nullptr || *kind == '\0') return false;
    std::size_t length = 0;
    for (const unsigned char* cursor = reinterpret_cast<const unsigned char*>(kind);
         *cursor != '\0';
         ++cursor) {
        ++length;
        if (length > 64u) return false;
        const bool alpha_numeric =
            (*cursor >= 'a' && *cursor <= 'z')
            || (*cursor >= 'A' && *cursor <= 'Z')
            || (*cursor >= '0' && *cursor <= '9');
        if (!alpha_numeric && *cursor != '_' && *cursor != '-' && *cursor != '.') return false;
    }
    return true;
}

} // namespace

int32_t execute_query(int64_t handle,
                      const char* kind,
                      const char* path,
                      const char* sql,
                      void** out_json)
{
    if (out_json == nullptr) return kStatusInvalidArgument;
    *out_json = nullptr;
    if (!valid_kind(kind) || sql == nullptr || *sql == '\0') return kStatusInvalidArgument;

    Runtime& rt = runtime();
    if (!rt.is_initialized()) return kStatusNotInitialized;
    std::shared_ptr<Account> account = rt.acquire_account(handle);
    if (account == nullptr) {
        return rt.is_initialized() ? kStatusInvalidArgument : kStatusNotInitialized;
    }

    try {
        std::lock_guard<std::mutex> operation_lock(account->operation_mutex());

        std::string target_path;
        const char* path_error_category = nullptr;
        if (!account->resolve_database_path(kind, path, target_path, path_error_category)) {
            rt.log_status(
                "query",
                kStatusInvalidArgument,
                path_error_category == nullptr
                    ? "database_path_resolution_failure"
                    : path_error_category);
            return kStatusInvalidArgument;
        }

        CipherConfiguration configuration;
        SqliteConnection connection;
        SqliteError open_error;
        if (account->find_configuration(target_path, configuration)) {
            if (!open_configured_database(
                    account->api(),
                    target_path,
                    account->key(),
                    configuration,
                    connection,
                    open_error)) {
                rt.log(
                    "query",
                    open_error.sqlite_rc,
                    open_error.sqlite_extended_rc,
                    open_error.category.empty() ? "cached_database_open_failure" : open_error.category.c_str());

                // A cached cipher configuration is only a hint. Invalidate it
                // after one failed open and perform exactly one fresh probe;
                // do not recursively retry the same cached value.
                account->forget_configuration(target_path);
                if (!discover_database(
                        account->api(),
                        target_path,
                        account->key(),
                        connection,
                        configuration,
                        open_error)) {
                    rt.log(
                        "query",
                        open_error.sqlite_rc,
                        open_error.sqlite_extended_rc,
                        "cached_configuration_reprobe_failed");
                    return kStatusDatabaseFailed;
                }
                account->remember_configuration(target_path, configuration);
            }
        } else {
            if (!discover_database(
                    account->api(),
                    target_path,
                    account->key(),
                    connection,
                    configuration,
                    open_error)) {
                rt.log(
                    "query",
                    open_error.sqlite_rc,
                    open_error.sqlite_extended_rc,
                    open_error.category.empty() ? "database_configuration_failure" : open_error.category.c_str());
                return kStatusDatabaseFailed;
            }
            account->remember_configuration(target_path, configuration);
        }

        std::string output;
        SqliteError query_error;
        const int32_t query_status =
            serialize_query(account->api(), connection.get(), sql, output, query_error);
        const int close_rc = connection.close();
        if (close_rc != 0) {
            rt.log("close", close_rc, 0, "query_connection_close_failure");
            return kStatusDatabaseFailed;
        }
        if (query_status != 0) {
            rt.log(
                "query",
                query_error.sqlite_rc,
                query_error.sqlite_extended_rc,
                query_error.category.empty() ? "query_failure" : query_error.category.c_str());
            return query_status;
        }

        const int32_t allocation_status = allocate_json(std::move(output), out_json);
        if (allocation_status != 0) {
            rt.log_status("serialize", allocation_status, "json_allocation_failure");
        }
        return allocation_status;
    } catch (const std::bad_alloc&) {
        rt.log_status("serialize", kStatusQueryFailed, "native_allocation_failure");
        return kStatusQueryFailed;
    } catch (const std::exception&) {
        rt.log_status("query", kStatusQueryFailed, "native_query_exception");
        return kStatusQueryFailed;
    }
}

} // namespace wcdb_native
