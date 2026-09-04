#include "query_executor.hpp"

#include "json_serializer.hpp"
#include "runtime.hpp"

#include <mutex>
#include <string>

namespace wcdb_native {

int32_t execute_query(int64_t handle,
                      const char* kind,
                      const char* path,
                      const char* sql,
                      void** out_json)
{
    (void)kind;
    (void)path;
    if (out_json == nullptr || sql == nullptr || *sql == '\0') {
        return kStatusInvalidArgument;
    }
    *out_json = nullptr;

    Runtime& rt = runtime();
    if (!rt.is_initialized()) {
        return kStatusNotInitialized;
    }
    std::shared_ptr<Account> account = rt.acquire_account(handle);
    if (account == nullptr) {
        return kStatusInvalidArgument;
    }

    std::lock_guard<std::mutex> operation_lock(account->operation_mutex());
    std::string output;
    const int32_t status = serialize_query(*account->fns(), account->inner_database(), sql, output);
    if (status != 0) {
        rt.log(std::string("query failed: ") + sql);
        return status;
    }
    return allocate_json(std::move(output), out_json);
}

} // namespace wcdb_native

