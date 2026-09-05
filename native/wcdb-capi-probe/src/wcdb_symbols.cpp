#include "wcdb_symbols.hpp"

#include <filesystem>
#include <sstream>

namespace wcdb_probe {
namespace {

template <typename Function>
Function resolve(HMODULE module, const char* name)
{
    return reinterpret_cast<Function>(GetProcAddress(module, name));
}

std::string win32_error(DWORD error_code)
{
    std::ostringstream message;
    message << "Win32 error " << error_code;
    return message.str();
}

} // namespace

WcdbSymbols::~WcdbSymbols()
{
    unload();
}

bool WcdbSymbols::load(const std::wstring& absolute_path, std::string& error)
{
    unload();
    missing_exports_.clear();

    const std::filesystem::path path(absolute_path);
    std::error_code filesystem_error;
    if (!path.is_absolute()) {
        error = "WCDB.dll path is not absolute";
        return false;
    }
    if (!std::filesystem::is_regular_file(path, filesystem_error) || filesystem_error) {
        error = "WCDB.dll path is not a regular file";
        return false;
    }

    // The absolute path plus these flags prevents an accidental load from the
    // current directory or an unrelated DLL search location.
    module_ = LoadLibraryExW(
        path.c_str(),
        nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (module_ == nullptr) {
        error = "LoadLibraryExW failed: " + win32_error(GetLastError());
        return false;
    }

    api_.libversion = resolve<decltype(api_.libversion)>(module_, "sqlite3_libversion");
    api_.open_v2 = resolve<decltype(api_.open_v2)>(module_, "sqlite3_open_v2");
    api_.close_v2 = resolve<decltype(api_.close_v2)>(module_, "sqlite3_close_v2");
    api_.key_v2 = resolve<decltype(api_.key_v2)>(module_, "sqlite3_key_v2");
    api_.exec = resolve<decltype(api_.exec)>(module_, "sqlite3_exec");
    api_.free_ = resolve<decltype(api_.free_)>(module_, "sqlite3_free");
    api_.prepare_v2 = resolve<decltype(api_.prepare_v2)>(module_, "sqlite3_prepare_v2");
    api_.step = resolve<decltype(api_.step)>(module_, "sqlite3_step");
    api_.finalize = resolve<decltype(api_.finalize)>(module_, "sqlite3_finalize");
    api_.reset = resolve<decltype(api_.reset)>(module_, "sqlite3_reset");
    api_.clear_bindings = resolve<decltype(api_.clear_bindings)>(module_, "sqlite3_clear_bindings");
    api_.bind_null = resolve<decltype(api_.bind_null)>(module_, "sqlite3_bind_null");
    api_.bind_int64 = resolve<decltype(api_.bind_int64)>(module_, "sqlite3_bind_int64");
    api_.bind_double = resolve<decltype(api_.bind_double)>(module_, "sqlite3_bind_double");
    api_.bind_text = resolve<decltype(api_.bind_text)>(module_, "sqlite3_bind_text");
    api_.bind_blob = resolve<decltype(api_.bind_blob)>(module_, "sqlite3_bind_blob");
    api_.column_count = resolve<decltype(api_.column_count)>(module_, "sqlite3_column_count");
    api_.column_name = resolve<decltype(api_.column_name)>(module_, "sqlite3_column_name");
    api_.column_type = resolve<decltype(api_.column_type)>(module_, "sqlite3_column_type");
    api_.column_int64 = resolve<decltype(api_.column_int64)>(module_, "sqlite3_column_int64");
    api_.column_double = resolve<decltype(api_.column_double)>(module_, "sqlite3_column_double");
    api_.column_text = resolve<decltype(api_.column_text)>(module_, "sqlite3_column_text");
    api_.column_blob = resolve<decltype(api_.column_blob)>(module_, "sqlite3_column_blob");
    api_.column_bytes = resolve<decltype(api_.column_bytes)>(module_, "sqlite3_column_bytes");
    api_.errmsg = resolve<decltype(api_.errmsg)>(module_, "sqlite3_errmsg");
    api_.extended_errcode = resolve<decltype(api_.extended_errcode)>(module_, "sqlite3_extended_errcode");
    api_.busy_timeout = resolve<decltype(api_.busy_timeout)>(module_, "sqlite3_busy_timeout");

    const auto add_if_missing = [this](const char* name, const auto function) {
        if (function == nullptr) {
            missing_exports_.emplace_back(name);
        }
    };

    add_if_missing("sqlite3_libversion", api_.libversion);
    add_if_missing("sqlite3_open_v2", api_.open_v2);
    add_if_missing("sqlite3_close_v2", api_.close_v2);
    add_if_missing("sqlite3_key_v2", api_.key_v2);
    add_if_missing("sqlite3_exec", api_.exec);
    add_if_missing("sqlite3_free", api_.free_);
    add_if_missing("sqlite3_prepare_v2", api_.prepare_v2);
    add_if_missing("sqlite3_step", api_.step);
    add_if_missing("sqlite3_finalize", api_.finalize);
    add_if_missing("sqlite3_reset", api_.reset);
    add_if_missing("sqlite3_clear_bindings", api_.clear_bindings);
    add_if_missing("sqlite3_bind_null", api_.bind_null);
    add_if_missing("sqlite3_bind_int64", api_.bind_int64);
    add_if_missing("sqlite3_bind_double", api_.bind_double);
    add_if_missing("sqlite3_bind_text", api_.bind_text);
    add_if_missing("sqlite3_bind_blob", api_.bind_blob);
    add_if_missing("sqlite3_column_count", api_.column_count);
    add_if_missing("sqlite3_column_name", api_.column_name);
    add_if_missing("sqlite3_column_type", api_.column_type);
    add_if_missing("sqlite3_column_int64", api_.column_int64);
    add_if_missing("sqlite3_column_double", api_.column_double);
    add_if_missing("sqlite3_column_text", api_.column_text);
    add_if_missing("sqlite3_column_blob", api_.column_blob);
    add_if_missing("sqlite3_column_bytes", api_.column_bytes);
    add_if_missing("sqlite3_errmsg", api_.errmsg);
    add_if_missing("sqlite3_extended_errcode", api_.extended_errcode);
    add_if_missing("sqlite3_busy_timeout", api_.busy_timeout);

    if (!missing_exports_.empty()) {
        error = "one or more required exports are missing";
        unload();
        return false;
    }
    return true;
}

void WcdbSymbols::unload()
{
    if (module_ != nullptr) {
        FreeLibrary(module_);
        module_ = nullptr;
    }
    api_ = {};
}

const std::vector<std::string>& WcdbSymbols::required_export_names()
{
    static const std::vector<std::string> names = {
        "sqlite3_libversion",
        "sqlite3_open_v2",
        "sqlite3_close_v2",
        "sqlite3_key_v2",
        "sqlite3_exec",
        "sqlite3_free",
        "sqlite3_prepare_v2",
        "sqlite3_step",
        "sqlite3_finalize",
        "sqlite3_reset",
        "sqlite3_clear_bindings",
        "sqlite3_bind_null",
        "sqlite3_bind_int64",
        "sqlite3_bind_double",
        "sqlite3_bind_text",
        "sqlite3_bind_blob",
        "sqlite3_column_count",
        "sqlite3_column_name",
        "sqlite3_column_type",
        "sqlite3_column_int64",
        "sqlite3_column_double",
        "sqlite3_column_text",
        "sqlite3_column_blob",
        "sqlite3_column_bytes",
        "sqlite3_errmsg",
        "sqlite3_extended_errcode",
        "sqlite3_busy_timeout",
    };
    return names;
}

} // namespace wcdb_probe
