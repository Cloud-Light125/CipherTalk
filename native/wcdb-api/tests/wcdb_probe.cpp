#include "wcdb_api.h"

#include <windows.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

template <typename T>
T load(HMODULE module, const char* name)
{
    return reinterpret_cast<T>(GetProcAddress(module, name));
}

bool is_hex_key(const char* value)
{
    if (value == nullptr || *value == '\0') return false;
    const std::size_t length = std::strlen(value);
    if ((length & 1u) != 0) return false;
    for (std::size_t i = 0; i < length; ++i) {
        const unsigned char c = static_cast<unsigned char>(value[i]);
        const bool digit = c >= '0' && c <= '9';
        const bool lower = c >= 'a' && c <= 'f';
        const bool upper = c >= 'A' && c <= 'F';
        if (!digit && !lower && !upper) return false;
    }
    return true;
}

int run(const char* dll_path, const char* db_path, const char* key)
{
    HMODULE module = LoadLibraryA(dll_path);
    if (module == nullptr) {
        std::cerr << "LoadLibrary failed: " << dll_path << "\n";
        return 2;
    }
    auto init = load<decltype(&wcdb_init)>(module, "wcdb_init");
    auto set_info = load<decltype(&wcdb_set_client_info)>(module, "wcdb_set_client_info");
    auto open = load<decltype(&wcdb_open_account)>(module, "wcdb_open_account");
    auto exec = load<decltype(&wcdb_exec_query)>(module, "wcdb_exec_query");
    auto close = load<decltype(&wcdb_close_account)>(module, "wcdb_close_account");
    auto shutdown = load<decltype(&wcdb_shutdown)>(module, "wcdb_shutdown");
    auto free_string = load<decltype(&wcdb_free_string)>(module, "wcdb_free_string");
    auto get_logs = load<decltype(&wcdb_get_logs)>(module, "wcdb_get_logs");
    if (!init || !set_info || !open || !exec || !close || !shutdown || !free_string) {
        std::cerr << "core export lookup failed\n";
        return 3;
    }

    std::cout << "key_length=" << (key ? std::strlen(key) : 0)
              << " key_format=" << (is_hex_key(key) ? "hex" : "invalid") << "\n";
    const int32_t info_rc = set_info("ciphertalk", "probe", "native-mvp");
    const int32_t init_rc = init();
    std::cout << "wcdb_set_client_info=" << info_rc << "\n";
    std::cout << "wcdb_init=" << init_rc << "\n";
    if (init_rc != 0) {
        if (get_logs && free_string) {
            void* logs = nullptr;
            if (get_logs(&logs) == 0 && logs != nullptr) {
                std::cout << "diagnostic_logs=" << static_cast<const char*>(logs) << "\n";
                free_string(logs);
            }
        }
        shutdown();
        return 4;
    }

    int64_t handle = 0;
    const int32_t open_rc = open(db_path, key, &handle);
    std::cout << "wcdb_open_account=" << open_rc << " handle=" << handle << "\n";
    if (open_rc != 0 || handle <= 0) {
        shutdown();
        return 5;
    }

    const std::vector<const char*> queries = {
        "SELECT count(*) FROM sqlite_master",
        "SELECT name,type FROM sqlite_master LIMIT 20",
        "PRAGMA database_list",
    };
    int result = 0;
    for (const char* sql : queries) {
        void* output = nullptr;
        const int32_t rc = exec(handle, "main", "", sql, &output);
        std::cout << "query=" << sql << " rc=" << rc << "\n";
        if (rc == 0 && output != nullptr) {
            std::cout << static_cast<const char*>(output) << "\n";
            free_string(output);
        } else {
            result = 6;
        }
    }

    const int32_t close_rc = close(handle);
    std::cout << "wcdb_close_account=" << close_rc << "\n";
    shutdown();
    return result;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 4) {
        std::cerr << "usage: wcdb_probe <wcdb_api.dll> <database path> <hex key>\n";
        return 1;
    }
    return run(argv[1], argv[2], argv[3]);
}
