#include "runtime.hpp"

#include "json_serializer.hpp"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <limits>

namespace wcdb_native {

namespace {

template <typename T>
bool resolve_symbol(HMODULE module, T& target, const char* name, std::string& error)
{
    FARPROC symbol = GetProcAddress(module, name);
    if (symbol == nullptr) {
        if (!error.empty()) {
            error += ", ";
        }
        error += name;
        target = nullptr;
        return false;
    }
    target = reinterpret_cast<T>(symbol);
    return true;
}

std::wstring utf8_to_wide(const char* value)
{
    if (value == nullptr || *value == '\0') {
        return {};
    }
    const int length = MultiByteToWideChar(CP_UTF8, 0, value, -1, nullptr, 0);
    if (length <= 1) {
        return {};
    }
    std::wstring result(static_cast<std::size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value, -1, result.data(), length);
    result.resize(static_cast<std::size_t>(length - 1));
    return result;
}

std::wstring directory_of_module(HMODULE module)
{
    wchar_t buffer[32768]{};
    const DWORD length = GetModuleFileNameW(module, buffer, static_cast<DWORD>(std::size(buffer)));
    if (length == 0 || length >= std::size(buffer)) {
        return {};
    }
    std::filesystem::path path(buffer, buffer + length);
    return path.parent_path().wstring();
}

std::vector<std::wstring> wcdb_candidates()
{
    std::vector<std::wstring> result;
    wchar_t env_buffer[32768]{};
    const DWORD env_length = GetEnvironmentVariableW(
        L"WCDB_DLL_PATH", env_buffer, static_cast<DWORD>(std::size(env_buffer)));
    if (env_length > 0 && env_length < std::size(env_buffer)) {
        result.emplace_back(env_buffer, env_length);
    }

    HMODULE self = nullptr;
    GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&wcdb_candidates),
        &self);
    const std::wstring self_directory = directory_of_module(self);
    if (!self_directory.empty()) {
        result.push_back((std::filesystem::path(self_directory) / L"WCDB.dll").wstring());
        result.push_back((std::filesystem::path(self_directory) / L"resources" / L"WCDB.dll").wstring());
        result.push_back((std::filesystem::path(self_directory).parent_path() / L"resources" / L"WCDB.dll").wstring());
        std::filesystem::path ancestor = self_directory;
        for (int i = 0; i < 5; ++i) {
            ancestor = ancestor.parent_path();
            if (ancestor.empty()) {
                break;
            }
            result.push_back((ancestor / L"resources" / L"WCDB.dll").wstring());
        }
    }

    wchar_t process_buffer[32768]{};
    const DWORD process_length = GetModuleFileNameW(
        nullptr, process_buffer, static_cast<DWORD>(std::size(process_buffer)));
    if (process_length > 0 && process_length < std::size(process_buffer)) {
        std::filesystem::path process_path(process_buffer, process_buffer + process_length);
        result.push_back((process_path.parent_path() / L"WCDB.dll").wstring());
        result.push_back((process_path.parent_path() / L"resources" / L"WCDB.dll").wstring());
    }

    result.push_back((std::filesystem::current_path() / L"WCDB.dll").wstring());
    result.push_back((std::filesystem::current_path() / L"resources" / L"WCDB.dll").wstring());

    result.push_back(L"WCDB.dll");
    return result;
}

void append_missing_error(std::string& error, const char* detail)
{
    error = "WCDB.dll is missing required C++ export(s): ";
    error += detail;
}

} // namespace

bool WcdbFns::load(std::string& error)
{
    if (module != nullptr) {
        return true;
    }

    for (const std::wstring& candidate : wcdb_candidates()) {
        const DWORD flags = candidate.find_first_of(L"\\/") == std::wstring::npos
                                 ? 0
                                 : LOAD_WITH_ALTERED_SEARCH_PATH;
        HMODULE loaded = LoadLibraryExW(candidate.c_str(), nullptr, flags);
        if (loaded != nullptr) {
            module = loaded;
            break;
        }
    }
    if (module == nullptr) {
        error = "LoadLibraryW(WCDB.dll) failed";
        return false;
    }

    bool ok = true;
    ok = resolve_symbol(module, unsafe_string_view_ctor, "??0UnsafeStringView@WCDB@@QEAA@PEBD@Z", error) && ok;
    ok = resolve_symbol(module, unsafe_string_view_ctor_len, "??0UnsafeStringView@WCDB@@QEAA@PEBD_K@Z", error) && ok;
    ok = resolve_symbol(module, unsafe_string_view_dtor, "??1UnsafeStringView@WCDB@@QEAA@XZ", error) && ok;
    ok = resolve_symbol(module, unsafe_string_view_data, "?data@UnsafeStringView@WCDB@@QEBAPEBDXZ", error) && ok;
    ok = resolve_symbol(module, unsafe_string_view_length, "?length@UnsafeStringView@WCDB@@QEBA_KXZ", error) && ok;

    ok = resolve_symbol(module, inner_database_ctor, "??0InnerDatabase@WCDB@@QEAA@AEBVUnsafeStringView@1@@Z", error) && ok;
    ok = resolve_symbol(module, inner_database_dtor, "??1InnerDatabase@WCDB@@UEAA@XZ", error) && ok;
    ok = resolve_symbol(module, inner_database_set_read_only, "?setReadOnly@InnerDatabase@WCDB@@QEAAXXZ", error) && ok;
    ok = resolve_symbol(module, inner_database_can_open, "?canOpen@InnerDatabase@WCDB@@QEAA_NXZ", error) && ok;
    ok = resolve_symbol(module, inner_database_get_handle, "?getHandle@InnerDatabase@WCDB@@QEAA?AVRecyclableHandle@2@_N0@Z", error) && ok;
    ok = resolve_symbol(module, inner_database_set_config, "?setConfig@InnerDatabase@WCDB@@QEAAXAEBVUnsafeStringView@2@AEBV?$shared_ptr@VConfig@WCDB@@@std@@H@Z", error) && ok;

    ok = resolve_symbol(module, unsafe_data_immutable, "?immutable@UnsafeData@WCDB@@SA?BV12@PEBE_K@Z", error) && ok;
    ok = resolve_symbol(module, unsafe_data_dtor, "??1UnsafeData@WCDB@@UEAA@XZ", error) && ok;
    ok = resolve_symbol(module, unsafe_data_size, "?size@UnsafeData@WCDB@@QEBA_KXZ", error) && ok;
    ok = resolve_symbol(module, unsafe_data_buffer, "?buffer@UnsafeData@WCDB@@QEAAPEAEXZ", error) && ok;

    ok = resolve_symbol(module, make_cipher_config,
                        "??$make_shared@VCipherConfig@WCDB@@AEBVUnsafeData@2@AEAHAEAW4CipherVersion@Database@2@@std@@YA?AV?$shared_ptr@VCipherConfig@WCDB@@@0@AEBVUnsafeData@WCDB@@AEAHAEAW4CipherVersion@Database@3@@Z",
                        error) && ok;
    ok = resolve_symbol(module, shared_cipher_config_dtor, "??1?$shared_ptr@VCipherConfig@WCDB@@@std@@QEAA@XZ", error) && ok;

    ok = resolve_symbol(module, recyclable_handle_get, "?get@RecyclableHandle@WCDB@@QEBAPEAVInnerHandle@2@XZ", error) && ok;
    ok = resolve_symbol(module, recyclable_handle_dtor, "??1RecyclableHandle@WCDB@@UEAA@XZ", error) && ok;

    ok = resolve_symbol(module, inner_handle_prepare, "?prepare@InnerHandle@WCDB@@QEAA_NAEBVUnsafeStringView@2@@Z", error) && ok;
    ok = resolve_symbol(module, inner_handle_step, "?step@InnerHandle@WCDB@@QEAA_NXZ", error) && ok;
    ok = resolve_symbol(module, inner_handle_done, "?done@InnerHandle@WCDB@@QEAA_NXZ", error) && ok;
    ok = resolve_symbol(module, inner_handle_number_of_columns, "?getNumberOfColumns@InnerHandle@WCDB@@QEAAHXZ", error) && ok;
    ok = resolve_symbol(module, inner_handle_column_type, "?getColumnType@InnerHandle@WCDB@@QEAA?AW4ColumnType@Syntax@2@H@Z", error) && ok;
    ok = resolve_symbol(module, inner_handle_integer, "?getInteger@InnerHandle@WCDB@@QEAA_JH@Z", error) && ok;
    ok = resolve_symbol(module, inner_handle_double, "?getDouble@InnerHandle@WCDB@@QEAANH@Z", error) && ok;
    ok = resolve_symbol(module, inner_handle_text, "?getText@InnerHandle@WCDB@@QEAA?AVUnsafeStringView@2@H@Z", error) && ok;
    ok = resolve_symbol(module, inner_handle_blob, "?getBLOB@InnerHandle@WCDB@@QEAA?AVUnsafeData@2@H@Z", error) && ok;
    ok = resolve_symbol(module, inner_handle_column_name, "?getColumnName@InnerHandle@WCDB@@QEAA?BVUnsafeStringView@2@H@Z", error) && ok;

    if (!ok) {
        if (error.empty()) {
            append_missing_error(error, "unknown");
        }
        // Do not unload here. A process may have already loaded the same core DLL under
        // another name and its global state must remain stable for this diagnostic failure.
        return false;
    }
    return true;
}

Account::Account(WcdbFns* fns, void* inner_database, std::string path)
    : fns_(fns), inner_database_(inner_database), path_(std::move(path))
{
}

Account::~Account()
{
    std::lock_guard<std::mutex> lock(operation_mutex_);
    if (inner_database_ != nullptr) {
        destroy_inner_database(*fns_, inner_database_);
        inner_database_ = nullptr;
    }
}

Runtime& runtime()
{
    static Runtime* instance = new Runtime();
    return *instance;
}

bool decode_hex_key(const char* key, std::vector<unsigned char>& decoded)
{
    decoded.clear();
    if (key == nullptr || *key == '\0') {
        return false;
    }
    const std::size_t length = std::strlen(key);
    if ((length & 1u) != 0) {
        return false;
    }
    decoded.reserve(length / 2);
    auto nibble = [](unsigned char value) -> int {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        if (value >= 'A' && value <= 'F') return value - 'A' + 10;
        return -1;
    };
    for (std::size_t i = 0; i < length; i += 2) {
        const int high = nibble(static_cast<unsigned char>(key[i]));
        const int low = nibble(static_cast<unsigned char>(key[i + 1]));
        if (high < 0 || low < 0) {
            decoded.clear();
            return false;
        }
        decoded.push_back(static_cast<unsigned char>((high << 4) | low));
    }
    return !decoded.empty();
}

void destroy_inner_database(WcdbFns& fns, void* inner_database)
{
    fns.inner_database_dtor(inner_database);
    std::free(inner_database);
}

void* create_inner_database(WcdbFns& fns,
                            const char* path,
                            const std::vector<unsigned char>& key,
                            int cipher_page_size)
{
    void* database = std::malloc(kInnerDatabaseBytes);
    if (database == nullptr) {
        return nullptr;
    }

    alignas(16) unsigned char path_view[kUnsafeStringViewBytes]{};
    fns.unsafe_string_view_ctor(path_view, path);
    fns.inner_database_ctor(database, path_view);
    fns.unsafe_string_view_dtor(path_view);
    fns.inner_database_set_read_only(database);

    alignas(16) unsigned char unsafe_data[kUnsafeDataBytes]{};
    fns.unsafe_data_immutable(unsafe_data, key.data(), key.size());
    alignas(16) unsigned char shared_cipher[16]{};
    int page_size = cipher_page_size;
    int cipher_version = kDefaultCipherVersion;
    fns.make_cipher_config(shared_cipher, unsafe_data, &page_size, &cipher_version);

    alignas(16) unsigned char name_view[kUnsafeStringViewBytes]{};
    fns.unsafe_string_view_ctor(name_view, kCipherConfigName);
    fns.inner_database_set_config(database, name_view, shared_cipher, kHighestConfigPriority);
    fns.unsafe_string_view_dtor(name_view);
    fns.shared_cipher_config_dtor(shared_cipher);
    fns.unsafe_data_dtor(unsafe_data);
    return database;
}

bool validate_open_and_probe(WcdbFns& fns, void* inner_database)
{
    if (inner_database == nullptr || !fns.inner_database_can_open(inner_database)) {
        return false;
    }

    alignas(16) unsigned char recyclable_handle[kRecyclableHandleBytes]{};
    fns.inner_database_get_handle(inner_database, recyclable_handle, false, false);
    void* inner_handle = fns.recyclable_handle_get(recyclable_handle);
    if (inner_handle == nullptr) {
        fns.recyclable_handle_dtor(recyclable_handle);
        return false;
    }

    constexpr char kProbeSql[] = "SELECT count(*) FROM sqlite_master";
    alignas(16) unsigned char sql_view[kUnsafeStringViewBytes]{};
    fns.unsafe_string_view_ctor_len(sql_view, kProbeSql, sizeof(kProbeSql) - 1);
    const bool prepared = fns.inner_handle_prepare(inner_handle, sql_view);
    fns.unsafe_string_view_dtor(sql_view);
    const bool stepped = prepared && fns.inner_handle_step(inner_handle);
    fns.inner_handle_done(inner_handle);
    fns.recyclable_handle_dtor(recyclable_handle);
    return prepared && stepped;
}

int32_t allocate_json(std::string value, void** out_json)
{
    if (out_json == nullptr) {
        return kStatusInvalidArgument;
    }
    *out_json = nullptr;
    void* memory = std::malloc(value.size() + 1);
    if (memory == nullptr) {
        return kStatusQueryFailed;
    }
    std::memcpy(memory, value.data(), value.size());
    static_cast<char*>(memory)[value.size()] = '\0';
    *out_json = memory;
    return 0;
}

int32_t Runtime::init()
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (initialized_) {
        return 0;
    }
    std::string error;
    if (!fns_.load(error)) {
        logs_.push_back(std::string("WCDB core load failed: ") + error);
        return kStatusInternal;
    }
    initialized_ = true;
    logs_.push_back("wcdb_api initialized");
    return 0;
}

void Runtime::shutdown()
{
    std::unordered_map<int64_t, std::shared_ptr<Account>> old_accounts;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        initialized_ = false;
        old_accounts.swap(accounts_);
        logs_.push_back("wcdb_api shutdown");
    }
    old_accounts.clear();
}

bool Runtime::is_initialized() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    return initialized_;
}

WcdbFns* Runtime::fns()
{
    return &fns_;
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
    if (version == nullptr) {
        return kStatusInvalidArgument;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    application_id_ = "ciphertalk";
    client_type_ = "desktop";
    app_version_ = version;
    return 0;
}

int32_t Runtime::open_account(const char* db_path, const char* key, int64_t* out_handle)
{
    if (out_handle == nullptr || db_path == nullptr || *db_path == '\0') {
        return kStatusInvalidArgument;
    }
    *out_handle = 0;

    std::vector<unsigned char> decoded_key;
    if (!decode_hex_key(key, decoded_key)) {
        return kStatusOpenFailed;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialized_) {
            return kStatusNotInitialized;
        }
    }

    void* database = nullptr;
    for (int page_size : kCipherPageSizes) {
        database = create_inner_database(*fns(), db_path, decoded_key, page_size);
        if (database != nullptr && validate_open_and_probe(*fns(), database)) {
            break;
        }
        if (database != nullptr) {
            destroy_inner_database(*fns(), database);
            database = nullptr;
        }
    }
    std::fill(decoded_key.begin(), decoded_key.end(), 0);
    if (database == nullptr) {
        log(std::string("open account failed: ") + db_path);
        return kStatusOpenFailed;
    }

    std::shared_ptr<Account> account = std::make_shared<Account>(fns(), database, db_path);
    int64_t handle = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialized_ || next_handle_ <= 0 || next_handle_ == std::numeric_limits<int64_t>::max()) {
            // The database is still owned by account and will be released as this local
            // shared_ptr leaves scope.
            return kStatusInternal;
        }
        handle = next_handle_++;
        accounts_.emplace(handle, account);
    }
    *out_handle = handle;
    log(std::string("opened account: ") + db_path);
    return 0;
}

int32_t Runtime::close_account(int64_t handle)
{
    std::shared_ptr<Account> account;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = accounts_.find(handle);
        if (it == accounts_.end()) {
            return kStatusInvalidArgument;
        }
        account = std::move(it->second);
        accounts_.erase(it);
    }
    account.reset();
    log("closed account");
    return 0;
}

std::shared_ptr<Account> Runtime::acquire_account(int64_t handle) const
{
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = accounts_.find(handle);
    return it == accounts_.end() ? nullptr : it->second;
}

void Runtime::log(std::string message)
{
    std::lock_guard<std::mutex> lock(mutex_);
    logs_.push_back(std::move(message));
}

int32_t Runtime::get_logs(void** out_json) const
{
    if (out_json == nullptr) {
        return kStatusInvalidArgument;
    }
    std::vector<std::string> logs;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        logs = logs_;
    }
    std::string output = "[";
    for (std::size_t i = 0; i < logs.size(); ++i) {
        if (i != 0) {
            output.push_back(',');
        }
        output += "{\"level\":\"info\",\"message\":\"";
        output += json_escape_bytes(logs[i].data(), logs[i].size());
        output += "\"}";
    }
    output.push_back(']');
    return allocate_json(std::move(output), out_json);
}

} // namespace wcdb_native
