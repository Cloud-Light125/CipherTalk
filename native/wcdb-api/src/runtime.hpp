#pragma once

#include <windows.h>

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

constexpr std::size_t kInnerDatabaseBytes = 0xBE0;
constexpr std::size_t kUnsafeStringViewBytes = 24;
constexpr std::size_t kUnsafeDataBytes = 256;
constexpr std::size_t kRecyclableHandleBytes = 128;
constexpr int kCipherPageSizes[] = {0x1000, 0x400};
constexpr int kDefaultCipherVersion = 0;
constexpr int kHighestConfigPriority = static_cast<int>(0x80000000u);
constexpr char kCipherConfigName[] = "com.Tencent.WCDB.Config.Cipher";

struct WcdbFns {
    HMODULE module = nullptr;

    using UnsafeStringViewCtor = void (*)(void*, const char*);
    using UnsafeStringViewCtorLen = void (*)(void*, const char*, std::size_t);
    using UnsafeStringViewDtor = void (*)(void*);
    using UnsafeStringViewData = const char* (*)(const void*);
    using UnsafeStringViewLength = std::size_t (*)(const void*);

    using InnerDatabaseCtor = void (*)(void*, const void*);
    using InnerDatabaseDtor = void (*)(void*);
    using InnerDatabaseSetReadOnly = void (*)(void*);
    using InnerDatabaseCanOpen = bool (*)(void*);
    using InnerDatabaseGetHandle = void (*)(void*, void*, bool, bool);
    using InnerDatabaseSetConfig = void (*)(void*, const void*, const void*, int);

    using UnsafeDataImmutable = void (*)(void*, const unsigned char*, std::size_t);
    using UnsafeDataDtor = void (*)(void*);
    using UnsafeDataSize = std::size_t (*)(const void*);
    using UnsafeDataBuffer = unsigned char* (*)(void*);

    using MakeCipherConfig = void (*)(void*, const void*, int*, int*);
    using SharedCipherConfigDtor = void (*)(void*);

    using RecyclableHandleGet = void* (*)(const void*);
    using RecyclableHandleDtor = void (*)(void*);

    using InnerHandlePrepare = bool (*)(void*, const void*);
    using InnerHandleStep = bool (*)(void*);
    using InnerHandleDone = bool (*)(void*);
    using InnerHandleNumberOfColumns = int (*)(void*);
    using InnerHandleColumnType = int (*)(void*, int);
    using InnerHandleInteger = int64_t (*)(void*, int);
    using InnerHandleDouble = double (*)(void*, int);
    using InnerHandleText = void (*)(void*, void*, int);
    using InnerHandleBlob = void (*)(void*, void*, int);
    using InnerHandleColumnName = void (*)(void*, void*, int);

    UnsafeStringViewCtor unsafe_string_view_ctor = nullptr;
    UnsafeStringViewCtorLen unsafe_string_view_ctor_len = nullptr;
    UnsafeStringViewDtor unsafe_string_view_dtor = nullptr;
    UnsafeStringViewData unsafe_string_view_data = nullptr;
    UnsafeStringViewLength unsafe_string_view_length = nullptr;

    InnerDatabaseCtor inner_database_ctor = nullptr;
    InnerDatabaseDtor inner_database_dtor = nullptr;
    InnerDatabaseSetReadOnly inner_database_set_read_only = nullptr;
    InnerDatabaseCanOpen inner_database_can_open = nullptr;
    InnerDatabaseGetHandle inner_database_get_handle = nullptr;
    InnerDatabaseSetConfig inner_database_set_config = nullptr;

    UnsafeDataImmutable unsafe_data_immutable = nullptr;
    UnsafeDataDtor unsafe_data_dtor = nullptr;
    UnsafeDataSize unsafe_data_size = nullptr;
    UnsafeDataBuffer unsafe_data_buffer = nullptr;

    MakeCipherConfig make_cipher_config = nullptr;
    SharedCipherConfigDtor shared_cipher_config_dtor = nullptr;

    RecyclableHandleGet recyclable_handle_get = nullptr;
    RecyclableHandleDtor recyclable_handle_dtor = nullptr;

    InnerHandlePrepare inner_handle_prepare = nullptr;
    InnerHandleStep inner_handle_step = nullptr;
    InnerHandleDone inner_handle_done = nullptr;
    InnerHandleNumberOfColumns inner_handle_number_of_columns = nullptr;
    InnerHandleColumnType inner_handle_column_type = nullptr;
    InnerHandleInteger inner_handle_integer = nullptr;
    InnerHandleDouble inner_handle_double = nullptr;
    InnerHandleText inner_handle_text = nullptr;
    InnerHandleBlob inner_handle_blob = nullptr;
    InnerHandleColumnName inner_handle_column_name = nullptr;

    bool load(std::string& error);
};

class Account final {
public:
    Account(WcdbFns* fns, void* inner_database, std::string path);
    ~Account();

    Account(const Account&) = delete;
    Account& operator=(const Account&) = delete;

    WcdbFns* fns() const { return fns_; }
    void* inner_database() const { return inner_database_; }
    std::mutex& operation_mutex() { return operation_mutex_; }

private:
    WcdbFns* fns_;
    void* inner_database_;
    std::string path_;
    std::mutex operation_mutex_;
};

class Runtime final {
public:
    int32_t init();
    void shutdown();

    bool is_initialized() const;
    WcdbFns* fns();

    int32_t set_client_info(const char* application_id,
                            const char* client_type,
                            const char* app_version);
    int32_t set_app_version(const char* version);

    int32_t open_account(const char* db_path, const char* key, int64_t* out_handle);
    int32_t close_account(int64_t handle);
    std::shared_ptr<Account> acquire_account(int64_t handle) const;

    int32_t get_logs(void** out_json) const;
    void log(std::string message);

private:
    mutable std::mutex mutex_;
    bool initialized_ = false;
    WcdbFns fns_;
    std::unordered_map<int64_t, std::shared_ptr<Account>> accounts_;
    int64_t next_handle_ = 1;
    std::string application_id_;
    std::string client_type_;
    std::string app_version_;
    std::vector<std::string> logs_;
};

Runtime& runtime();

bool decode_hex_key(const char* key, std::vector<unsigned char>& decoded);
bool validate_open_and_probe(WcdbFns& fns, void* inner_database);
void destroy_inner_database(WcdbFns& fns, void* inner_database);
void* create_inner_database(WcdbFns& fns,
                            const char* path,
                            const std::vector<unsigned char>& key,
                            int cipher_page_size);

int32_t allocate_json(std::string value, void** out_json);

} // namespace wcdb_native

