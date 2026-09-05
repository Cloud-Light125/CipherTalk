#pragma once

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace wcdb_native {

constexpr int32_t kStatusInvalidArgument = -1;
constexpr int32_t kStatusOpenFailed = -2;
constexpr int32_t kStatusDatabaseFailed = -3;
constexpr int32_t kStatusInternal = -4;
constexpr int32_t kStatusQueryFailed = -5;
constexpr int32_t kStatusNotInitialized = -6;
constexpr int32_t kStatusUnsupported = -18;

constexpr std::size_t kKeyBytes = 32;
constexpr std::size_t kSaltBytes = 16;

struct sqlite3;
struct sqlite3_stmt;

struct CipherConfiguration {
    std::string key_mode;
    int page_size = 0;
    int cipher_version = 0;
};

struct SqliteError {
    int sqlite_rc = 0;
    int sqlite_extended_rc = 0;
    std::string category;
};

class WcdbApi final {
public:
    using Libversion = const char*(__cdecl*)();
    using OpenV2 = int(__cdecl*)(const char*, sqlite3**, int, const char*);
    using CloseV2 = int(__cdecl*)(sqlite3*);
    using KeyV2 = int(__cdecl*)(sqlite3*, const char*, const void*, int);
    using PrepareV2 = int(__cdecl*)(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
    using Step = int(__cdecl*)(sqlite3_stmt*);
    using Finalize = int(__cdecl*)(sqlite3_stmt*);
    using ColumnCount = int(__cdecl*)(sqlite3_stmt*);
    using ColumnName = const char*(__cdecl*)(sqlite3_stmt*, int);
    using ColumnType = int(__cdecl*)(sqlite3_stmt*, int);
    using ColumnInt64 = std::int64_t(__cdecl*)(sqlite3_stmt*, int);
    using ColumnDouble = double(__cdecl*)(sqlite3_stmt*, int);
    using ColumnText = const unsigned char*(__cdecl*)(sqlite3_stmt*, int);
    using ColumnBlob = const void*(__cdecl*)(sqlite3_stmt*, int);
    using ColumnBytes = int(__cdecl*)(sqlite3_stmt*, int);
    using Errmsg = const char*(__cdecl*)(sqlite3*);
    using Errcode = int(__cdecl*)(sqlite3*);
    using ExtendedErrcode = int(__cdecl*)(sqlite3*);
    using ExtendedResultCodes = int(__cdecl*)(sqlite3*, int);
    using StmtReadonly = int(__cdecl*)(sqlite3_stmt*);
    using BusyTimeout = int(__cdecl*)(sqlite3*, int);

    WcdbApi() = default;
    ~WcdbApi();

    WcdbApi(const WcdbApi&) = delete;
    WcdbApi& operator=(const WcdbApi&) = delete;

    bool load(std::string& error);
    void unload() noexcept;

    Libversion libversion = nullptr;
    OpenV2 open_v2 = nullptr;
    CloseV2 close_v2 = nullptr;
    KeyV2 key_v2 = nullptr;
    PrepareV2 prepare_v2 = nullptr;
    Step step = nullptr;
    Finalize finalize = nullptr;
    ColumnCount column_count = nullptr;
    ColumnName column_name = nullptr;
    ColumnType column_type = nullptr;
    ColumnInt64 column_int64 = nullptr;
    ColumnDouble column_double = nullptr;
    ColumnText column_text = nullptr;
    ColumnBlob column_blob = nullptr;
    ColumnBytes column_bytes = nullptr;
    Errmsg errmsg = nullptr;
    Errcode errcode = nullptr;
    ExtendedErrcode extended_errcode = nullptr;
    ExtendedResultCodes extended_result_codes = nullptr;
    StmtReadonly stmt_readonly = nullptr;
    BusyTimeout busy_timeout = nullptr;

    HMODULE module() const noexcept { return module_; }

private:
    HMODULE module_ = nullptr;
};

struct SecureKey {
    std::array<unsigned char, kKeyBytes> bytes{};

    ~SecureKey() { SecureZeroMemory(bytes.data(), bytes.size()); }

    SecureKey() = default;
    SecureKey(const SecureKey& other) : bytes(other.bytes) {}
    SecureKey& operator=(const SecureKey& other)
    {
        if (this != &other) {
            bytes = other.bytes;
        }
        return *this;
    }
};

class Account final {
public:
    Account(std::shared_ptr<WcdbApi> api,
            std::string session_path,
            std::string database_storage_root,
            const SecureKey& key,
            CipherConfiguration configuration);
    ~Account();

    Account(const Account&) = delete;
    Account& operator=(const Account&) = delete;

    const std::shared_ptr<WcdbApi>& api() const { return api_; }
    const std::string& session_path() const { return session_path_; }
    const SecureKey& key() const { return key_; }
    std::mutex& operation_mutex() { return operation_mutex_; }

    bool resolve_database_path(const char* kind,
                               const char* explicit_path,
                               std::string& output,
                               const char*& error_category) const;

    bool find_configuration(const std::string& path, CipherConfiguration& output) const;
    void remember_configuration(const std::string& path, const CipherConfiguration& configuration);
    void forget_configuration(const std::string& path);

private:
    std::shared_ptr<WcdbApi> api_;
    std::string session_path_;
    std::string database_storage_root_;
    SecureKey key_;
    std::unordered_map<std::string, CipherConfiguration> configurations_;
    std::mutex operation_mutex_;
};

class Runtime final {
public:
    int32_t init();
    void shutdown();

    bool is_initialized() const;

    int32_t set_client_info(const char* application_id,
                            const char* client_type,
                            const char* app_version);
    int32_t set_app_version(const char* version);

    int32_t open_account(const char* db_path, const char* key, int64_t* out_handle);
    int32_t close_account(int64_t handle);
    std::shared_ptr<Account> acquire_account(int64_t handle) const;

    int32_t get_logs(void** out_json) const;
    void log_configuration(const CipherConfiguration& configuration);
    void log(const char* stage, int sqlite_rc, int sqlite_extended_rc, const char* category);
    void log_status(const char* stage, int32_t status, const char* category);

    struct LogEntry {
        std::string stage;
        int sqlite_rc = 0;
        int sqlite_extended_rc = 0;
        std::string category;
    };

private:
    mutable std::mutex mutex_;
    bool initialized_ = false;
    std::shared_ptr<WcdbApi> api_;
    std::unordered_map<int64_t, std::shared_ptr<Account>> accounts_;
    int64_t next_handle_ = 1;
    std::string application_id_;
    std::string client_type_;
    std::string app_version_;
    std::vector<LogEntry> logs_;
};

Runtime& runtime();

bool decode_hex_key(const char* key, SecureKey& decoded);
bool normalize_database_path(const char* input, std::string& output);

int32_t allocate_json(std::string value, void** out_json);

} // namespace wcdb_native
