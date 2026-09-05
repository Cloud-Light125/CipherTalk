#pragma once

#include "runtime.hpp"

#include <cstddef>
#include <string>

namespace wcdb_native {

std::string json_escape_bytes(const char* data, std::size_t length);

int32_t serialize_query(const std::shared_ptr<WcdbApi>& api,
                        sqlite3* database,
                        const char* sql,
                        std::string& output,
                        SqliteError& error);

} // namespace wcdb_native
