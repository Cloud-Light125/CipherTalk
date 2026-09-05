#include "runtime.hpp"

#include "json_serializer.hpp"
#include "sqlite_session.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iterator>
#include <limits>
#include <sstream>
#include <cwctype>

namespace wcdb_native {

namespace {

constexpr wchar_t kWcdbDllName[] = L"WCDB.dll";

void module_anchor() {}

template <typename Function>
bool resolve_symbol(HMODULE module, Function& target, const char* name, std::string& missing)
{
    FARPROC symbol = GetProcAddress(module, name);
    if (symbol == nullptr) {
        if (!missing.empty()) missing += ", ";
        missing += name;
        target = nullptr;
        return false;
    }
    target = reinterpret_cast<Function>(symbol);
    return true;
}

std::wstring module_directory()
{
    HMODULE self = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&module_anchor),
            &self)) {
        return {};
    }

    wchar_t buffer[32768]{};
    const DWORD length = GetModuleFileNameW(self, buffer, static_cast<DWORD>(std::size(buffer)));
    if (length == 0 || length >= std::size(buffer)) return {};
    return std::filesystem::path(buffer, buffer + length).parent_path().wstring();
}

bool get_explicit_wcdb_path(std::wstring& output, std::string& error)
{
    wchar_t buffer[32768]{};
    const DWORD length = GetEnvironmentVariableW(
        L"WCDB_DLL_PATH", buffer, static_cast<DWORD>(std::size(buffer)));
    if (length == 0) return false;
    if (length >= std::size(buffer)) {
        error = "WCDB_DLL_PATH is too long";
        return false;
    }

    std::filesystem::path path{std::wstring(buffer, length)};
    if (!path.is_absolute()) {
        error = "WCDB_DLL_PATH must be absolute";
        return false;
    }
    output = path.lexically_normal().wstring();
    return true;
}

std::string utf8_to_string(const std::filesystem::path& path)
{
    return path.u8string();
}

void append_log_json(std::string& output, const Runtime::LogEntry& entry)
{
    output += "{\"stage\":\"";
    output += json_escape_bytes(entry.stage.data(), entry.stage.size());
    output += "\",\"sqlite_rc\":";
    output += std::to_string(entry.sqlite_rc);
    output += ",\"sqlite_extended_rc\":";
    output += std::to_string(entry.sqlite_extended_rc);
    output += ",\"category\":\"";
    output += json_escape_bytes(entry.category.data(), entry.category.size());
    output += "\"}";
}

bool make_configuration_log_category(const CipherConfiguration& configuration, std::string& output)
{
    const bool known_key_mode = configuration.key_mode == "passphrase"
        || configuration.key_mode == "raw";
    const bool known_cipher_version = configuration.cipher_version == 0
        || configuration.cipher_version == 3
        || configuration.cipher_version == 4;
    const bool known_page_size = configuration.page_size == 1024
        || configuration.page_size == 4096;
    if (!known_key_mode || !known_cipher_version || !known_page_size) return false;

    output = configuration.key_mode
        + "_cipher"
        + std::to_string(configuration.cipher_version)
        + "_page"
        + std::to_string(configuration.page_size);
    return true;
}

bool path_is_within(const std::filesystem::path& root,
                    const std::filesystem::path& candidate)
{
    const std::filesystem::path relative = candidate.lexically_relative(root);
    if (relative.empty() || relative == std::filesystem::path(L".")) return false;
    for (const std::filesystem::path& component : relative) {
        if (component == std::filesystem::path(L"..")) return false;
    }
    return true;
}

bool derive_database_storage_root(const std::string& normalized_session_path,
                                  std::string& output)
{
    output.clear();
    const std::filesystem::path session_path =
        std::filesystem::u8path(normalized_session_path).lexically_normal();
    if (!session_path.is_absolute()) return false;

    std::error_code filesystem_error;
    if (!std::filesystem::is_regular_file(session_path, filesystem_error) || filesystem_error) {
        return false;
    }

    const auto equals_ascii_case_insensitive = [](const std::wstring& left, const wchar_t* right) {
        if (right == nullptr) return false;
        const std::wstring expected(right);
        if (left.size() != expected.size()) return false;
        for (std::size_t index = 0; index < left.size(); ++index) {
            if (std::towlower(left[index]) != std::towlower(expected[index])) return false;
        }
        return true;
    };

    if (!equals_ascii_case_insensitive(session_path.filename().wstring(), L"session.db")) {
        return false;
    }

    const std::filesystem::path session_directory = session_path.parent_path();
    if (session_directory.empty()
        || !equals_ascii_case_insensitive(session_directory.filename().wstring(), L"session")) {
        return false;
    }

    const std::filesystem::path storage_root = session_directory.parent_path().lexically_normal();
    if (storage_root.empty()
        || !storage_root.is_absolute()
        || !equals_ascii_case_insensitive(storage_root.filename().wstring(), L"db_storage")) {
        return false;
    }

    output = storage_root.u8string();
    return !output.empty();
}

bool resolve_storage_database_path(const std::string& storage_root_utf8,
                                   const wchar_t* child_directory,
                                   const wchar_t* file_name,
                                   std::string& output)
{
    output.clear();
    if (storage_root_utf8.empty() || child_directory == nullptr || file_name == nullptr) {
        return false;
    }

    const std::filesystem::path storage_root =
        std::filesystem::u8path(storage_root_utf8).lexically_normal();
    if (!storage_root.is_absolute()) return false;

    const std::filesystem::path target =
        (storage_root / std::filesystem::path(child_directory)
         / std::filesystem::path(file_name)).lexically_normal();
    if (!path_is_within(storage_root, target)) return false;

    std::error_code filesystem_error;
    if (!std::filesystem::is_regular_file(target, filesystem_error) || filesystem_error) {
        return false;
    }

    output = target.u8string();
    return !output.empty();
}

} // namespace

WcdbApi::~WcdbApi()
{
    unload();
}

bool WcdbApi::load(std::string& error)
{
    if (module_ != nullptr) return true;

    std::vector<std::wstring> candidates;
    const std::wstring self_directory = module_directory();
    if (!self_directory.empty()) {
        candidates.push_back((std::filesystem::path(self_directory) / kWcdbDllName).wstring());
    }

    std::wstring explicit_path;
    std::string environment_error;
    if (get_explicit_wcdb_path(explicit_path, environment_error)) {
        candidates.push_back(std::move(explicit_path));
    } else if (!environment_error.empty() && self_directory.empty()) {
        error = environment_error;
        return false;
    }

    for (const std::wstring& candidate : candidates) {
        // Every candidate is absolute. The DLL directory is included only for
        // dependencies of that exact DLL; no PATH/CWD/resource search is used.
        HMODULE loaded = LoadLibraryExW(
            candidate.c_str(),
            nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (loaded != nullptr) {
            module_ = loaded;
            break;
        }
    }

    if (module_ == nullptr) {
        error = environment_error.empty()
                    ? "adjacent WCDB.dll and explicit WCDB_DLL_PATH could not be loaded"
                    : environment_error;
        return false;
    }

    std::string missing;
    bool ok = true;
    ok = resolve_symbol(module_, libversion, "sqlite3_libversion", missing) && ok;
    ok = resolve_symbol(module_, open_v2, "sqlite3_open_v2", missing) && ok;
    ok = resolve_symbol(module_, close_v2, "sqlite3_close_v2", missing) && ok;
    ok = resolve_symbol(module_, key_v2, "sqlite3_key_v2", missing) && ok;
    ok = resolve_symbol(module_, prepare_v2, "sqlite3_prepare_v2", missing) && ok;
    ok = resolve_symbol(module_, step, "sqlite3_step", missing) && ok;
    ok = resolve_symbol(module_, finalize, "sqlite3_finalize", missing) && ok;
    ok = resolve_symbol(module_, column_count, "sqlite3_column_count", missing) && ok;
    ok = resolve_symbol(module_, column_name, "sqlite3_column_name", missing) && ok;
    ok = resolve_symbol(module_, column_type, "sqlite3_column_type", missing) && ok;
    ok = resolve_symbol(module_, column_int64, "sqlite3_column_int64", missing) && ok;
    ok = resolve_symbol(module_, column_double, "sqlite3_column_double", missing) && ok;
    ok = resolve_symbol(module_, column_text, "sqlite3_column_text", missing) && ok;
    ok = resolve_symbol(module_, column_blob, "sqlite3_column_blob", missing) && ok;
    ok = resolve_symbol(module_, column_bytes, "sqlite3_column_bytes", missing) && ok;
    ok = resolve_symbol(module_, errmsg, "sqlite3_errmsg", missing) && ok;
    ok = resolve_symbol(module_, errcode, "sqlite3_errcode", missing) && ok;
    ok = resolve_symbol(module_, extended_errcode, "sqlite3_extended_errcode", missing) && ok;
    ok = resolve_symbol(module_, extended_result_codes, "sqlite3_extended_result_codes", missing) && ok;
    ok = resolve_symbol(module_, stmt_readonly, "sqlite3_stmt_readonly", missing) && ok;
    ok = resolve_symbol(module_, busy_timeout, "sqlite3_busy_timeout", missing) && ok;

    if (!ok) {
        error = "WCDB.dll is missing required SQLite C export(s): " + missing;
        unload();
        return false;
    }
    return true;
}

void WcdbApi::unload() noexcept
{
    if (module_ != nullptr) {
        FreeLibrary(module_);
        module_ = nullptr;
    }
    libversion = nullptr;
    open_v2 = nullptr;
    close_v2 = nullptr;
    key_v2 = nullptr;
    prepare_v2 = nullptr;
    step = nullptr;
    finalize = nullptr;
    column_count = nullptr;
    column_name = nullptr;
    column_type = nullptr;
    column_int64 = nullptr;
    column_double = nullptr;
    column_text = nullptr;
    column_blob = nullptr;
    column_bytes = nullptr;
    errmsg = nullptr;
    errcode = nullptr;
    extended_errcode = nullptr;
    extended_result_codes = nullptr;
    stmt_readonly = nullptr;
    busy_timeout = nullptr;
}

Account::Account(std::shared_ptr<WcdbApi> api,
                 std::string session_path,
                 std::string database_storage_root,
                 const SecureKey& key,
                 CipherConfiguration configuration)
    : api_(std::move(api))
    , session_path_(std::move(session_path))
    , database_storage_root_(std::move(database_storage_root))
    , key_(key)
{
    configurations_.emplace(session_path_, std::move(configuration));
}

Account::~Account()
{
    SecureZeroMemory(key_.bytes.data(), key_.bytes.size());
}

bool Account::resolve_database_path(const char* kind,
                                    const char* explicit_path,
                                    std::string& output,
                                    const char*& error_category) const
{
    output.clear();
    error_category = "database_path_resolution_failure";

    if (explicit_path != nullptr && *explicit_path != '\0') {
        if (!normalize_database_path(explicit_path, output)) {
            error_category = "query_path_must_be_a_regular_file";
            return false;
        }
        return true;
    }

    if (kind == nullptr) {
        error_category = "unknown_database_kind";
        return false;
    }
    if (std::strcmp(kind, "session") == 0) {
        output = session_path_;
        return !output.empty();
    }
    if (std::strcmp(kind, "message") == 0) {
        error_category = "message_path_required";
        return false;
    }

    const wchar_t* child_directory = nullptr;
    const wchar_t* file_name = nullptr;
    if (std::strcmp(kind, "contact") == 0) {
        child_directory = L"contact";
        file_name = L"contact.db";
    } else if (std::strcmp(kind, "general") == 0) {
        child_directory = L"general";
        file_name = L"general.db";
    } else if (std::strcmp(kind, "sns") == 0) {
        child_directory = L"sns";
        file_name = L"sns.db";
    } else {
        error_category = "unknown_database_kind";
        return false;
    }

    if (!resolve_storage_database_path(
            database_storage_root_, child_directory, file_name, output)) {
        error_category = "empty_path_database_missing";
        return false;
    }
    return true;
}

bool Account::find_configuration(const std::string& path, CipherConfiguration& output) const
{
    const auto it = configurations_.find(path);
    if (it == configurations_.end()) return false;
    output = it->second;
    return true;
}

void Account::remember_configuration(const std::string& path, const CipherConfiguration& configuration)
{
    configurations_[path] = configuration;
}

void Account::forget_configuration(const std::string& path)
{
    configurations_.erase(path);
}

Runtime& runtime()
{
    static Runtime* instance = new Runtime();
    return *instance;
}

bool decode_hex_key(const char* key, SecureKey& decoded)
{
    SecureZeroMemory(decoded.bytes.data(), decoded.bytes.size());
    if (key == nullptr || std::strlen(key) != kKeyBytes * 2u) return false;

    auto nibble = [](unsigned char value) -> int {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        if (value >= 'A' && value <= 'F') return value - 'A' + 10;
        return -1;
    };

    for (std::size_t index = 0; index < kKeyBytes; ++index) {
        const int high = nibble(static_cast<unsigned char>(key[index * 2u]));
        const int low = nibble(static_cast<unsigned char>(key[index * 2u + 1u]));
        if (high < 0 || low < 0) {
            SecureZeroMemory(decoded.bytes.data(), decoded.bytes.size());
            return false;
        }
        decoded.bytes[index] = static_cast<unsigned char>((high << 4) | low);
    }
    return true;
}

namespace {

bool utf8_to_wide(const char* input, std::wstring& output)
{
    output.clear();
    if (input == nullptr || *input == '\0') return false;
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, nullptr, 0);
    if (length <= 1) return false;
    output.resize(static_cast<std::size_t>(length));
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, output.data(), length) != length) {
        output.clear();
        return false;
    }
    output.resize(static_cast<std::size_t>(length - 1));
    return true;
}

} // namespace

bool normalize_database_path(const char* input, std::string& output)
{
    output.clear();
    std::wstring wide_path;
    if (!utf8_to_wide(input, wide_path)) return false;

    std::error_code filesystem_error;
    const std::filesystem::path absolute =
        std::filesystem::absolute(std::filesystem::path(wide_path), filesystem_error).lexically_normal();
    if (filesystem_error || !absolute.is_absolute()) return false;
    filesystem_error.clear();
    if (!std::filesystem::is_regular_file(absolute, filesystem_error) || filesystem_error) return false;

    output = utf8_to_string(absolute);
    return !output.empty();
}

int32_t allocate_json(std::string value, void** out_json)
{
    if (out_json == nullptr) return kStatusInvalidArgument;
    *out_json = nullptr;
    if (value.size() == std::numeric_limits<std::size_t>::max()) return kStatusQueryFailed;
    void* memory = std::malloc(value.size() + 1u);
    if (memory == nullptr) return kStatusQueryFailed;
    std::memcpy(memory, value.data(), value.size());
    static_cast<char*>(memory)[value.size()] = '\0';
    *out_json = memory;
    return 0;
}

int32_t Runtime::init()
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (initialized_ && api_ != nullptr && api_->module() != nullptr) return 0;

    std::shared_ptr<WcdbApi> candidate = std::make_shared<WcdbApi>();
    std::string error;
    if (!candidate->load(error)) {
        logs_.push_back({"init", kStatusInternal, 0, "required_sqlite_export_or_loader_failure"});
        return kStatusInternal;
    }

    api_ = std::move(candidate);
    initialized_ = true;
    logs_.push_back({"init", 0, 0, "initialized"});
    return 0;
}

void Runtime::shutdown()
{
    std::unordered_map<int64_t, std::shared_ptr<Account>> old_accounts;
    std::shared_ptr<WcdbApi> old_api;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        initialized_ = false;
        old_accounts.swap(accounts_);
        old_api = std::move(api_);
        logs_.push_back({"shutdown", 0, 0, "shutdown_requested"});
    }

    // Query-local shared_ptr<Account> values keep both the account key and the
    // WCDB module alive until the last in-flight operation has completed.
    old_accounts.clear();
    old_api.reset();
}

bool Runtime::is_initialized() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    return initialized_ && api_ != nullptr && api_->module() != nullptr;
}

int32_t Runtime::set_client_info(const char* application_id,
                                 const char* client_type,
                                 const char* app_version)
{
    if (application_id == nullptr || client_type == nullptr || app_version == nullptr) {
        return kStatusInvalidArgument;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    application_id_ = application_id;
    client_type_ = client_type;
    app_version_ = app_version;
    return 0;
}

int32_t Runtime::set_app_version(const char* version)
{
    if (version == nullptr) return kStatusInvalidArgument;
    std::lock_guard<std::mutex> lock(mutex_);
    application_id_ = "ciphertalk";
    client_type_ = "desktop";
    app_version_ = version;
    return 0;
}

int32_t Runtime::open_account(const char* db_path, const char* key, int64_t* out_handle)
{
    if (out_handle == nullptr) return kStatusInvalidArgument;
    *out_handle = 0;

    std::shared_ptr<WcdbApi> api;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialized_ || api_ == nullptr) return kStatusNotInitialized;
        api = api_;
    }

    std::string normalized_path;
    if (!normalize_database_path(db_path, normalized_path)) {
        log_status("open", kStatusInvalidArgument, "database_path_must_be_a_regular_file");
        return kStatusInvalidArgument;
    }

    std::string database_storage_root;
    if (!derive_database_storage_root(normalized_path, database_storage_root)) {
        log_status("open", kStatusInvalidArgument, "database_storage_root_invalid");
        return kStatusInvalidArgument;
    }

    SecureKey decoded_key;
    if (!decode_hex_key(key, decoded_key)) {
        log_status("open", kStatusOpenFailed, "invalid_key_format");
        return kStatusOpenFailed;
    }

    SqliteConnection validation_connection;
    CipherConfiguration configuration;
    SqliteError error;
    if (!discover_database(
            api, normalized_path, decoded_key, validation_connection, configuration, error)) {
        log("open", error.sqlite_rc, error.sqlite_extended_rc,
            error.category.empty() ? "key_or_database_open_failure" : error.category.c_str());
        return kStatusOpenFailed;
    }

    const int close_rc = validation_connection.close();
    if (close_rc != 0) {
        log("close", close_rc, 0, "validation_connection_close_failure");
        return kStatusDatabaseFailed;
    }

    log_configuration(configuration);

    std::shared_ptr<Account> account = std::make_shared<Account>(
        api,
        normalized_path,
        database_storage_root,
        decoded_key,
        std::move(configuration));
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialized_ || api_ != api) return kStatusNotInitialized;
        if (next_handle_ <= 0 || next_handle_ == std::numeric_limits<int64_t>::max()) {
            return kStatusInternal;
        }
        const int64_t handle = next_handle_++;
        accounts_.emplace(handle, std::move(account));
        *out_handle = handle;
    }
    return 0;
}

int32_t Runtime::close_account(int64_t handle)
{
    std::shared_ptr<Account> account;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto it = accounts_.find(handle);
        if (it == accounts_.end()) return kStatusInvalidArgument;
        account = std::move(it->second);
        accounts_.erase(it);
    }
    account.reset();
    return 0;
}

std::shared_ptr<Account> Runtime::acquire_account(int64_t handle) const
{
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = accounts_.find(handle);
    return it == accounts_.end() ? nullptr : it->second;
}

void Runtime::log(const char* stage, int sqlite_rc, int sqlite_extended_rc, const char* category)
{
    std::lock_guard<std::mutex> lock(mutex_);
    logs_.push_back({
        stage == nullptr ? "unknown" : stage,
        sqlite_rc,
        sqlite_extended_rc,
        category == nullptr ? "unspecified" : category});
}

void Runtime::log_status(const char* stage, int32_t status, const char* category)
{
    log(stage, status, 0, category);
}

int32_t Runtime::get_logs(void** out_json) const
{
    if (out_json == nullptr) return kStatusInvalidArgument;
    *out_json = nullptr;

    std::vector<LogEntry> logs;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        logs = logs_;
    }

    std::string output = "[";
    for (std::size_t index = 0; index < logs.size(); ++index) {
        if (index != 0) output.push_back(',');
        append_log_json(output, logs[index]);
    }
    output.push_back(']');
    return allocate_json(std::move(output), out_json);
}

void Runtime::log_configuration(const CipherConfiguration& configuration)
{
    std::string category;
    if (!make_configuration_log_category(configuration, category)) {
        category = "unknown_configuration";
    }
    log("open_configuration", 0, 0, category.c_str());
}

} // namespace wcdb_native
