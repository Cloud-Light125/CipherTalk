#pragma once

#include <cstdint>

namespace wcdb_native {

int32_t execute_query(int64_t handle,
                      const char* kind,
                      const char* path,
                      const char* sql,
                      void** out_json);

} // namespace wcdb_native

