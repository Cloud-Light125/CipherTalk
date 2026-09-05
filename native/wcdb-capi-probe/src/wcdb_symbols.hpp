#pragma once

#if !defined(_WIN32)
#error "wcdb_capi_probe requires Windows"
#endif

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace wcdb_probe {

struct sqlite3;
struct sqlite3_stmt;

using sqlite3_int64 = std::int64_t;
using sqlite3_destructor_type = void(__cdecl*)(void*);
using sqlite3_exec_callback = int(__cdecl*)(void*, int, char**, char**);

struct WcdbApi {
    const char*(__cdecl* libversion)() = nullptr;
    int(__cdecl* open_v2)(const char*, sqlite3**, int, const char*) = nullptr;
    int(__cdecl* close_v2)(sqlite3*) = nullptr;
    int(__cdecl* key_v2)(sqlite3*, const char*, const void*, int) = nullptr;
    int(__cdecl* exec)(sqlite3*, const char*, sqlite3_exec_callback, void*, char**) = nullptr;
    void(__cdecl* free_)(void*) = nullptr;
    int(__cdecl* prepare_v2)(sqlite3*, const char*, int, sqlite3_stmt**, const char**) = nullptr;
    int(__cdecl* step)(sqlite3_stmt*) = nullptr;
    int(__cdecl* finalize)(sqlite3_stmt*) = nullptr;
    int(__cdecl* reset)(sqlite3_stmt*) = nullptr;
    int(__cdecl* clear_bindings)(sqlite3_stmt*) = nullptr;
    int(__cdecl* bind_null)(sqlite3_stmt*, int) = nullptr;
    int(__cdecl* bind_int64)(sqlite3_stmt*, int, sqlite3_int64) = nullptr;
    int(__cdecl* bind_double)(sqlite3_stmt*, int, double) = nullptr;
    int(__cdecl* bind_text)(sqlite3_stmt*, int, const char*, int, sqlite3_destructor_type) = nullptr;
    int(__cdecl* bind_blob)(sqlite3_stmt*, int, const void*, int, sqlite3_destructor_type) = nullptr;
    int(__cdecl* column_count)(sqlite3_stmt*) = nullptr;
    const char*(__cdecl* column_name)(sqlite3_stmt*, int) = nullptr;
    int(__cdecl* column_type)(sqlite3_stmt*, int) = nullptr;
    sqlite3_int64(__cdecl* column_int64)(sqlite3_stmt*, int) = nullptr;
    double(__cdecl* column_double)(sqlite3_stmt*, int) = nullptr;
    const unsigned char*(__cdecl* column_text)(sqlite3_stmt*, int) = nullptr;
    const void*(__cdecl* column_blob)(sqlite3_stmt*, int) = nullptr;
    int(__cdecl* column_bytes)(sqlite3_stmt*, int) = nullptr;
    const char*(__cdecl* errmsg)(sqlite3*) = nullptr;
    int(__cdecl* extended_errcode)(sqlite3*) = nullptr;
    int(__cdecl* busy_timeout)(sqlite3*, int) = nullptr;
};

class WcdbSymbols final {
public:
    WcdbSymbols() = default;
    ~WcdbSymbols();

    WcdbSymbols(const WcdbSymbols&) = delete;
    WcdbSymbols& operator=(const WcdbSymbols&) = delete;

    bool load(const std::wstring& absolute_path, std::string& error);
    void unload();

    bool loaded() const noexcept { return module_ != nullptr; }
    HMODULE module() const noexcept { return module_; }
    const WcdbApi& api() const noexcept { return api_; }
    const std::vector<std::string>& missing_exports() const noexcept { return missing_exports_; }

    static const std::vector<std::string>& required_export_names();

private:
    HMODULE module_ = nullptr;
    WcdbApi api_{};
    std::vector<std::string> missing_exports_;
};

} // namespace wcdb_probe
