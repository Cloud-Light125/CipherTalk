#pragma once

#include "runtime.hpp"

#include <string>

namespace wcdb_native {

std::string json_escape_bytes(const char* data, std::size_t length);
std::string serialize_cell(WcdbFns& fns, void* inner_handle, int column);
int32_t serialize_query(WcdbFns& fns, void* inner_database, const char* sql, std::string& output);

} // namespace wcdb_native

