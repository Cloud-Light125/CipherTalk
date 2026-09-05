#include <windows.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

    constexpr int32_t kStatusInvalidArgument = -1;
    constexpr int32_t kStatusOpenFailed = -2;
    constexpr int32_t kStatusQueryFailed = -5;
    constexpr int32_t kStatusUnsupported = -18;
constexpr std::size_t kKeyHexLength = 64;

using CheckLicenseFn = int32_t(__cdecl*)();
using CloseAccountFn = int32_t(__cdecl*)(int64_t);
using CloseCursorFn = int32_t(__cdecl*)(int64_t, int64_t);
using ExecQueryFn = int32_t(__cdecl*)(int64_t, const char*, const char*, const char*, void**);
using ExportChunkFn = int32_t(__cdecl*)(
    int64_t, const char*, const char*, const char*, int64_t, int32_t, int32_t, int32_t, const char*, void**);
using FetchBatchFn = int32_t(__cdecl*)(int64_t, int64_t, void**, int32_t*);
using FreeStringFn = void(__cdecl*)(void*);
using GetLogsFn = int32_t(__cdecl*)(void**);
using GetSnsFn = int32_t(__cdecl*)(int64_t, int32_t, int32_t, const char*, const char*, int32_t, int32_t, void**);
using InitFn = int32_t(__cdecl*)();
using OpenAccountFn = int32_t(__cdecl*)(const char*, const char*, int64_t*);
using OpenCursorFn = int32_t(__cdecl*)(int64_t, const char*, int32_t, int32_t, int32_t, int32_t, int64_t*);
using SetVersionFn = int32_t(__cdecl*)(const char*);
using SetClientInfoFn = int32_t(__cdecl*)(const char*, const char*, const char*);
using SetWxidFn = int32_t(__cdecl*)(int64_t, const char*);
using SetTrustedTimeFn = int32_t(__cdecl*)(int64_t);
using ShutdownFn = void(__cdecl*)();

struct Api final {
    HMODULE module = nullptr;
    CheckLicenseFn check_license = nullptr;
    CloseAccountFn close_account = nullptr;
    CloseCursorFn close_message_cursor = nullptr;
    ExecQueryFn exec_query = nullptr;
    ExportChunkFn export_message_chunk = nullptr;
    FetchBatchFn fetch_message_batch = nullptr;
    FreeStringFn free_string = nullptr;
    GetLogsFn get_logs = nullptr;
    GetSnsFn get_sns_timeline = nullptr;
    InitFn init = nullptr;
    OpenAccountFn open_account = nullptr;
    OpenCursorFn open_message_cursor = nullptr;
    OpenCursorFn open_message_cursor_lite = nullptr;
    SetVersionFn set_app_version = nullptr;
    SetClientInfoFn set_client_info = nullptr;
    SetWxidFn set_my_wxid = nullptr;
    SetTrustedTimeFn set_trusted_time = nullptr;
    ShutdownFn shutdown = nullptr;

    Api() = default;

    ~Api()
    {
        if (module != nullptr) FreeLibrary(module);
    }

    Api(const Api&) = delete;
    Api& operator=(const Api&) = delete;
};

template <typename Function>
Function load_symbol(HMODULE module, const char* name)
{
    return reinterpret_cast<Function>(GetProcAddress(module, name));
}

bool load_api(const std::wstring& path, Api& api)
{
    const std::filesystem::path candidate(path);
    if (!candidate.is_absolute()) return false;
    std::error_code filesystem_error;
    if (!std::filesystem::is_regular_file(candidate, filesystem_error) || filesystem_error) return false;

    api.module = LoadLibraryExW(
        candidate.c_str(),
        nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (api.module == nullptr) return false;

    api.check_license = load_symbol<CheckLicenseFn>(api.module, "wcdb_check_license");
    api.close_account = load_symbol<CloseAccountFn>(api.module, "wcdb_close_account");
    api.close_message_cursor = load_symbol<CloseCursorFn>(api.module, "wcdb_close_message_cursor");
    api.exec_query = load_symbol<ExecQueryFn>(api.module, "wcdb_exec_query");
    api.export_message_chunk = load_symbol<ExportChunkFn>(api.module, "wcdb_export_message_chunk");
    api.fetch_message_batch = load_symbol<FetchBatchFn>(api.module, "wcdb_fetch_message_batch");
    api.free_string = load_symbol<FreeStringFn>(api.module, "wcdb_free_string");
    api.get_logs = load_symbol<GetLogsFn>(api.module, "wcdb_get_logs");
    api.get_sns_timeline = load_symbol<GetSnsFn>(api.module, "wcdb_get_sns_timeline");
    api.init = load_symbol<InitFn>(api.module, "wcdb_init");
    api.open_account = load_symbol<OpenAccountFn>(api.module, "wcdb_open_account");
    api.open_message_cursor = load_symbol<OpenCursorFn>(api.module, "wcdb_open_message_cursor");
    api.open_message_cursor_lite = load_symbol<OpenCursorFn>(api.module, "wcdb_open_message_cursor_lite");
    api.set_app_version = load_symbol<SetVersionFn>(api.module, "wcdb_set_app_version");
    api.set_client_info = load_symbol<SetClientInfoFn>(api.module, "wcdb_set_client_info");
    api.set_my_wxid = load_symbol<SetWxidFn>(api.module, "wcdb_set_my_wxid");
    api.set_trusted_time = load_symbol<SetTrustedTimeFn>(api.module, "wcdb_set_trusted_time");
    api.shutdown = load_symbol<ShutdownFn>(api.module, "wcdb_shutdown");

    return api.check_license != nullptr
        && api.close_account != nullptr
        && api.close_message_cursor != nullptr
        && api.exec_query != nullptr
        && api.export_message_chunk != nullptr
        && api.fetch_message_batch != nullptr
        && api.free_string != nullptr
        && api.get_logs != nullptr
        && api.get_sns_timeline != nullptr
        && api.init != nullptr
        && api.open_account != nullptr
        && api.open_message_cursor != nullptr
        && api.open_message_cursor_lite != nullptr
        && api.set_app_version != nullptr
        && api.set_client_info != nullptr
        && api.set_my_wxid != nullptr
        && api.set_trusted_time != nullptr
        && api.shutdown != nullptr;
}

bool wide_to_utf8(const std::wstring& value, std::string& output)
{
    output.clear();
    if (value.empty()) return false;
    if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) return false;
    const int input_length = static_cast<int>(value.size());
    const int required = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        input_length,
        nullptr,
        0,
        nullptr,
        nullptr);
    if (required <= 0) return false;
    output.assign(static_cast<std::size_t>(required), '\0');
    return WideCharToMultiByte(
               CP_UTF8,
               WC_ERR_INVALID_CHARS,
               value.data(),
               input_length,
               output.data(),
               required,
               nullptr,
               nullptr)
        == required;
}

bool is_hex_key(const std::wstring& value)
{
    if (value.size() != kKeyHexLength) return false;
    for (const wchar_t character : value) {
        const bool digit = character >= L'0' && character <= L'9';
        const bool lower = character >= L'a' && character <= L'f';
        const bool upper = character >= L'A' && character <= L'F';
        if (!digit && !lower && !upper) return false;
    }
    return true;
}

bool absolute_existing_file(const std::wstring& input, std::wstring& output)
{
    if (input.empty()) return false;
    std::error_code filesystem_error;
    const std::filesystem::path path =
        std::filesystem::absolute(std::filesystem::path(input), filesystem_error).lexically_normal();
    if (filesystem_error || !path.is_absolute()) return false;
    filesystem_error.clear();
    if (!std::filesystem::is_regular_file(path, filesystem_error) || filesystem_error) return false;
    output = path.wstring();
    return true;
}

struct ProbeCipherConfiguration final {
    std::string key_mode;
    int page_size = 0;
    int cipher_version = 0;
};

class JsonSyntax final {
public:
    explicit JsonSyntax(std::string_view value) : value_(value) {}

    bool valid()
    {
        skip_space();
        if (!parse_value()) return false;
        skip_space();
        return index_ == value_.size();
    }

private:
    void skip_space()
    {
        while (index_ < value_.size()
               && (value_[index_] == ' ' || value_[index_] == '\t'
                   || value_[index_] == '\r' || value_[index_] == '\n')) {
            ++index_;
        }
    }

    bool consume(std::string_view token)
    {
        if (value_.substr(index_, token.size()) != token) return false;
        index_ += token.size();
        return true;
    }

    bool parse_string()
    {
        if (index_ >= value_.size() || value_[index_] != '"') return false;
        ++index_;
        while (index_ < value_.size()) {
            const unsigned char character = static_cast<unsigned char>(value_[index_++]);
            if (character == '"') return true;
            if (character < 0x20u) return false;
            if (character != '\\') continue;
            if (index_ >= value_.size()) return false;
            const char escaped = value_[index_++];
            if (escaped == '"' || escaped == '\\' || escaped == '/' || escaped == 'b'
                || escaped == 'f' || escaped == 'n' || escaped == 'r' || escaped == 't') {
                continue;
            }
            if (escaped != 'u' || index_ + 4u > value_.size()) return false;
            for (std::size_t count = 0; count < 4u; ++count) {
                const char digit = value_[index_++];
                const bool valid = (digit >= '0' && digit <= '9')
                    || (digit >= 'a' && digit <= 'f')
                    || (digit >= 'A' && digit <= 'F');
                if (!valid) return false;
            }
        }
        return false;
    }

    bool parse_number()
    {
        const std::size_t start = index_;
        if (index_ < value_.size() && value_[index_] == '-') ++index_;
        if (index_ >= value_.size()) return false;
        if (value_[index_] == '0') {
            ++index_;
        } else {
            if (value_[index_] < '1' || value_[index_] > '9') return false;
            while (index_ < value_.size() && value_[index_] >= '0' && value_[index_] <= '9') ++index_;
        }
        if (index_ < value_.size() && value_[index_] == '.') {
            ++index_;
            const std::size_t fraction_start = index_;
            while (index_ < value_.size() && value_[index_] >= '0' && value_[index_] <= '9') ++index_;
            if (fraction_start == index_) return false;
        }
        if (index_ < value_.size() && (value_[index_] == 'e' || value_[index_] == 'E')) {
            ++index_;
            if (index_ < value_.size() && (value_[index_] == '+' || value_[index_] == '-')) ++index_;
            const std::size_t exponent_start = index_;
            while (index_ < value_.size() && value_[index_] >= '0' && value_[index_] <= '9') ++index_;
            if (exponent_start == index_) return false;
        }
        return index_ > start;
    }

    bool parse_array()
    {
        if (index_ >= value_.size() || value_[index_] != '[') return false;
        ++index_;
        skip_space();
        if (index_ < value_.size() && value_[index_] == ']') {
            ++index_;
            return true;
        }
        while (true) {
            if (!parse_value()) return false;
            skip_space();
            if (index_ < value_.size() && value_[index_] == ']') {
                ++index_;
                return true;
            }
            if (index_ >= value_.size() || value_[index_++] != ',') return false;
            skip_space();
        }
    }

    bool parse_object()
    {
        if (index_ >= value_.size() || value_[index_] != '{') return false;
        ++index_;
        skip_space();
        if (index_ < value_.size() && value_[index_] == '}') {
            ++index_;
            return true;
        }
        while (true) {
            if (!parse_string()) return false;
            skip_space();
            if (index_ >= value_.size() || value_[index_++] != ':') return false;
            skip_space();
            if (!parse_value()) return false;
            skip_space();
            if (index_ < value_.size() && value_[index_] == '}') {
                ++index_;
                return true;
            }
            if (index_ >= value_.size() || value_[index_++] != ',') return false;
            skip_space();
        }
    }

    bool parse_value()
    {
        skip_space();
        if (index_ >= value_.size()) return false;
        switch (value_[index_]) {
        case 'n': return consume("null");
        case 't': return consume("true");
        case 'f': return consume("false");
        case '"': return parse_string();
        case '[': return parse_array();
        case '{': return parse_object();
        default: return parse_number();
        }
    }

    std::string_view value_;
    std::size_t index_ = 0;
};

bool decode_configuration_category(
    std::string_view category,
    ProbeCipherConfiguration& output)
{
    constexpr std::array<std::string_view, 2> key_modes = {"passphrase", "raw"};
    constexpr std::array<int, 3> cipher_versions = {0, 4, 3};
    constexpr std::array<int, 2> page_sizes = {4096, 1024};
    for (const std::string_view key_mode : key_modes) {
        for (const int cipher_version : cipher_versions) {
            for (const int page_size : page_sizes) {
                const std::string expected = std::string(key_mode)
                    + "_cipher"
                    + std::to_string(cipher_version)
                    + "_page"
                    + std::to_string(page_size);
                if (category == std::string_view(expected)) {
                    output.key_mode = std::string(key_mode);
                    output.page_size = page_size;
                    output.cipher_version = cipher_version;
                    return true;
                }
            }
        }
    }
    return false;
}

class OpenConfigurationLogReader final {
public:
    explicit OpenConfigurationLogReader(std::string_view value) : value_(value) {}

    bool read(ProbeCipherConfiguration& output)
    {
        output = {};
        skip_space();
        if (!take('[')) return false;
        skip_space();

        std::size_t match_count = 0;
        if (!take(']')) {
            while (true) {
                std::string stage;
                std::string category;
                bool has_stage = false;
                bool has_category = false;
                if (!parse_object(stage, has_stage, category, has_category)) return false;
                if (has_stage && stage == "open_configuration") {
                    ProbeCipherConfiguration candidate;
                    if (!has_category || !decode_configuration_category(category, candidate)) {
                        return false;
                    }
                    output = std::move(candidate);
                    ++match_count;
                }

                skip_space();
                if (take(']')) break;
                if (!take(',')) return false;
                skip_space();
            }
        }

        skip_space();
        return index_ == value_.size() && match_count == 1;
    }

private:
    static int hex_value(char value)
    {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        if (value >= 'A' && value <= 'F') return value - 'A' + 10;
        return -1;
    }

    void skip_space()
    {
        while (index_ < value_.size()
               && (value_[index_] == ' ' || value_[index_] == '\t'
                   || value_[index_] == '\r' || value_[index_] == '\n')) {
            ++index_;
        }
    }

    bool take(char expected)
    {
        if (index_ >= value_.size() || value_[index_] != expected) return false;
        ++index_;
        return true;
    }

    bool consume(std::string_view token)
    {
        if (value_.substr(index_, token.size()) != token) return false;
        index_ += token.size();
        return true;
    }

    bool parse_string(std::string& output)
    {
        output.clear();
        if (!take('"')) return false;
        while (index_ < value_.size()) {
            const unsigned char character = static_cast<unsigned char>(value_[index_++]);
            if (character == '"') return true;
            if (character < 0x20u) return false;
            if (character != '\\') {
                output.push_back(static_cast<char>(character));
                continue;
            }
            if (index_ >= value_.size()) return false;
            const char escaped = value_[index_++];
            switch (escaped) {
            case '"': output.push_back('"'); break;
            case '\\': output.push_back('\\'); break;
            case '/': output.push_back('/'); break;
            case 'b': output.push_back('\b'); break;
            case 'f': output.push_back('\f'); break;
            case 'n': output.push_back('\n'); break;
            case 'r': output.push_back('\r'); break;
            case 't': output.push_back('\t'); break;
            case 'u': {
                if (index_ + 4u > value_.size()) return false;
                int codepoint = 0;
                for (std::size_t count = 0; count < 4u; ++count) {
                    const int digit = hex_value(value_[index_++]);
                    if (digit < 0) return false;
                    codepoint = (codepoint << 4) | digit;
                }
                if (codepoint <= 0x7f) {
                    output.push_back(static_cast<char>(codepoint));
                } else {
                    // Configuration and stage values are ASCII. Preserve the
                    // fact that a non-ASCII escaped value is not a known enum.
                    output.push_back('?');
                }
                break;
            }
            default: return false;
            }
        }
        return false;
    }

    bool parse_number()
    {
        const std::size_t start = index_;
        if (index_ < value_.size() && value_[index_] == '-') ++index_;
        if (index_ >= value_.size()) return false;
        if (value_[index_] == '0') {
            ++index_;
        } else {
            if (value_[index_] < '1' || value_[index_] > '9') return false;
            while (index_ < value_.size() && value_[index_] >= '0' && value_[index_] <= '9') ++index_;
        }
        if (index_ < value_.size() && value_[index_] == '.') {
            ++index_;
            const std::size_t fraction_start = index_;
            while (index_ < value_.size() && value_[index_] >= '0' && value_[index_] <= '9') ++index_;
            if (fraction_start == index_) return false;
        }
        if (index_ < value_.size() && (value_[index_] == 'e' || value_[index_] == 'E')) {
            ++index_;
            if (index_ < value_.size() && (value_[index_] == '+' || value_[index_] == '-')) ++index_;
            const std::size_t exponent_start = index_;
            while (index_ < value_.size() && value_[index_] >= '0' && value_[index_] <= '9') ++index_;
            if (exponent_start == index_) return false;
        }
        return index_ > start;
    }

    bool skip_array()
    {
        if (!take('[')) return false;
        skip_space();
        if (take(']')) return true;
        while (true) {
            if (!skip_value()) return false;
            skip_space();
            if (take(']')) return true;
            if (!take(',')) return false;
            skip_space();
        }
    }

    bool skip_object()
    {
        if (!take('{')) return false;
        skip_space();
        if (take('}')) return true;
        while (true) {
            std::string ignored;
            if (!parse_string(ignored)) return false;
            skip_space();
            if (!take(':')) return false;
            skip_space();
            if (!skip_value()) return false;
            skip_space();
            if (take('}')) return true;
            if (!take(',')) return false;
            skip_space();
        }
    }

    bool skip_value()
    {
        skip_space();
        if (index_ >= value_.size()) return false;
        switch (value_[index_]) {
        case 'n': return consume("null");
        case 't': return consume("true");
        case 'f': return consume("false");
        case '"': {
            std::string ignored;
            return parse_string(ignored);
        }
        case '[': return skip_array();
        case '{': return skip_object();
        default: return parse_number();
        }
    }

    bool parse_object(
        std::string& stage,
        bool& has_stage,
        std::string& category,
        bool& has_category)
    {
        stage.clear();
        category.clear();
        has_stage = false;
        has_category = false;
        if (!take('{')) return false;
        skip_space();
        if (take('}')) return true;
        while (true) {
            std::string name;
            if (!parse_string(name)) return false;
            skip_space();
            if (!take(':')) return false;
            skip_space();
            if (name == "stage") {
                if (has_stage || !parse_string(stage)) return false;
                has_stage = true;
            } else if (name == "category") {
                if (has_category || !parse_string(category)) return false;
                has_category = true;
            } else if (!skip_value()) {
                return false;
            }
            skip_space();
            if (take('}')) return true;
            if (!take(',')) return false;
            skip_space();
        }
    }

    std::string_view value_;
    std::size_t index_ = 0;
};

struct Options {
    std::wstring api_path;
    std::wstring session_path;
    std::wstring contact_path;
    std::wstring message_path;
    std::wstring general_path;
    std::wstring sns_path;
    std::wstring contact_fts_path;
    std::wstring key;
};

struct UnsupportedAbiResults final {
    bool check_license = false;
    bool open_message_cursor = false;
    bool open_message_cursor_lite = false;
    bool fetch_message_batch = false;
    bool close_message_cursor = false;
    bool export_message_chunk = false;
    bool get_sns_timeline = false;
    bool set_my_wxid = false;
    bool set_trusted_time = false;
};

struct RoutingResults final {
    bool explicit_path_routing = false;
    bool empty_path_session_routing = false;
    bool empty_path_contact_routing = false;
    bool empty_path_general_routing = false;
    bool empty_path_sns_routing = false;
    bool explicit_path_precedence = false;
    bool empty_message_path_rejected = false;
    bool unknown_empty_kind_rejected = false;
    bool session_layout_validation = false;
};

bool next_argument(int& index, int argc, wchar_t** argv, std::wstring& value)
{
    if (index + 1 >= argc) return false;
    value = argv[++index];
    return !value.empty();
}

bool parse_arguments(int argc, wchar_t** argv, Options& options)
{
    for (int index = 1; index < argc; ++index) {
        const std::wstring_view option(argv[index]);
        std::wstring value;
        if (option == L"--api" && next_argument(index, argc, argv, value)) options.api_path = value;
        else if (option == L"--session" && next_argument(index, argc, argv, value)) options.session_path = value;
        else if (option == L"--contact" && next_argument(index, argc, argv, value)) options.contact_path = value;
        else if (option == L"--message" && next_argument(index, argc, argv, value)) options.message_path = value;
        else if (option == L"--general" && next_argument(index, argc, argv, value)) options.general_path = value;
        else if (option == L"--sns" && next_argument(index, argc, argv, value)) options.sns_path = value;
        else if (option == L"--contact-fts" && next_argument(index, argc, argv, value)) options.contact_fts_path = value;
        else if (option == L"--key" && next_argument(index, argc, argv, value)) options.key = value;
        else return false;
    }
    return !options.api_path.empty()
        && !options.session_path.empty()
        && !options.contact_path.empty()
        && !options.message_path.empty()
        && !options.general_path.empty()
        && !options.sns_path.empty()
        && is_hex_key(options.key);
}

void emit_failure(const char* stage)
{
    std::cout << "{\"ok\":false,\"stage\":\"" << stage << "\"}\n";
}

bool check_unsupported_abi_contract(Api& api, int64_t handle, UnsupportedAbiResults& result)
{
    result.check_license = api.check_license() == kStatusUnsupported;

    int64_t cursor = std::numeric_limits<int64_t>::max();
    result.open_message_cursor = api.open_message_cursor(
                                     handle,
                                     "probe_session",
                                     32,
                                     1,
                                     0,
                                     0,
                                     &cursor)
            == kStatusUnsupported
        && cursor == 0;

    cursor = std::numeric_limits<int64_t>::max();
    result.open_message_cursor_lite = api.open_message_cursor_lite(
                                           handle,
                                           "probe_session",
                                           32,
                                           1,
                                           0,
                                           0,
                                           &cursor)
            == kStatusUnsupported
        && cursor == 0;

    void* output = reinterpret_cast<void*>(static_cast<std::uintptr_t>(1));
    int32_t has_more = 7;
    result.fetch_message_batch = api.fetch_message_batch(handle, 1234, &output, &has_more)
            == kStatusUnsupported
        && output == nullptr
        && has_more == 0;

    result.close_message_cursor = api.close_message_cursor(handle, 1234) == kStatusUnsupported;

    output = reinterpret_cast<void*>(static_cast<std::uintptr_t>(1));
    result.export_message_chunk = api.export_message_chunk(
                                      handle,
                                      "message",
                                      "",
                                      "message",
                                      0,
                                      32,
                                      0,
                                      0,
                                      "{}",
                                      &output)
            == kStatusUnsupported
        && output == nullptr;

    output = reinterpret_cast<void*>(static_cast<std::uintptr_t>(1));
    result.get_sns_timeline = api.get_sns_timeline(
                                  handle,
                                  32,
                                  0,
                                  "[]",
                                  "probe",
                                  0,
                                  0,
                                  &output)
            == kStatusUnsupported
        && output == nullptr;

    result.set_my_wxid = api.set_my_wxid(handle, "probe_wxid") == kStatusUnsupported;
    result.set_trusted_time = api.set_trusted_time(123) == kStatusUnsupported;

    return result.check_license
        && result.open_message_cursor
        && result.open_message_cursor_lite
        && result.fetch_message_batch
        && result.close_message_cursor
        && result.export_message_chunk
        && result.get_sns_timeline
        && result.set_my_wxid
        && result.set_trusted_time;
}

void emit_success(const ProbeCipherConfiguration& configuration,
                  const UnsupportedAbiResults& unsupported,
                  const RoutingResults& routing,
                  bool wal_present,
                  bool wal_shm_present,
                  bool mmfts_tokenizer,
                  const char* mmfts_error)
{
    std::cout << "{\"ok\":true,\"stage\":\"candidate_probe\""
              << ",\"abi\":true"
              << ",\"init_repeat\":true"
              << ",\"client_info\":true"
              << ",\"schema_json\":true"
              << ",\"types_json\":true"
              << ",\"free_string_repeat\":true"
              << ",\"invalid_handle\":true"
              << ",\"close_lifecycle\":true"
              << ",\"repeat_lifecycle\":true"
              << ",\"wrong_key\":true"
              << ",\"invalid_key_inputs\":true"
              << ",\"write_rejection\":true"
              << ",\"multi_statement_rejection\":true"
              << ",\"routing\":" << (routing.explicit_path_routing ? "true" : "false")
              << ",\"empty_path_session_routing\":"
              << (routing.empty_path_session_routing ? "true" : "false")
              << ",\"empty_path_contact_routing\":"
              << (routing.empty_path_contact_routing ? "true" : "false")
              << ",\"empty_path_general_routing\":"
              << (routing.empty_path_general_routing ? "true" : "false")
              << ",\"empty_path_sns_routing\":"
              << (routing.empty_path_sns_routing ? "true" : "false")
              << ",\"explicit_path_precedence\":"
              << (routing.explicit_path_precedence ? "true" : "false")
              << ",\"empty_message_path_rejected\":"
              << (routing.empty_message_path_rejected ? "true" : "false")
              << ",\"unknown_empty_kind_rejected\":"
              << (routing.unknown_empty_kind_rejected ? "true" : "false")
              << ",\"session_layout_validation\":"
              << (routing.session_layout_validation ? "true" : "false")
              << ",\"shutdown_idempotent\":true"
              << ",\"unsupported_check_license\":" << (unsupported.check_license ? "true" : "false")
              << ",\"unsupported_open_message_cursor\":"
              << (unsupported.open_message_cursor ? "true" : "false")
              << ",\"unsupported_open_message_cursor_lite\":"
              << (unsupported.open_message_cursor_lite ? "true" : "false")
              << ",\"unsupported_fetch_message_batch\":"
              << (unsupported.fetch_message_batch ? "true" : "false")
              << ",\"unsupported_close_message_cursor\":"
              << (unsupported.close_message_cursor ? "true" : "false")
              << ",\"unsupported_export_message_chunk\":"
              << (unsupported.export_message_chunk ? "true" : "false")
              << ",\"unsupported_get_sns_timeline\":"
              << (unsupported.get_sns_timeline ? "true" : "false")
              << ",\"unsupported_set_my_wxid\":"
              << (unsupported.set_my_wxid ? "true" : "false")
              << ",\"unsupported_set_trusted_time\":"
              << (unsupported.set_trusted_time ? "true" : "false")
              << ",\"key_mode\":\"" << configuration.key_mode << "\""
              << ",\"page_size\":" << configuration.page_size
              << ",\"cipher_version\":" << configuration.cipher_version
              << ",\"wal_present\":" << (wal_present ? "true" : "false")
              << ",\"wal_shm_present\":" << (wal_shm_present ? "true" : "false")
              << ",\"mmfts_tokenizer\":" << (mmfts_tokenizer ? "true" : "false")
              << ",\"mmfts_error\":\"" << mmfts_error << "\"}\n";
}

bool query(Api& api,
           int64_t handle,
           const char* kind,
           const char* path,
           const char* sql,
           std::string& output,
           int32_t& status)
{
    output.clear();
    void* pointer = nullptr;
    status = api.exec_query(handle, kind, path, sql, &pointer);
    if (status != 0 || pointer == nullptr) {
        if (pointer != nullptr) api.free_string(pointer);
        return false;
    }
    output.assign(static_cast<const char*>(pointer));
    api.free_string(pointer);
    return JsonSyntax(output).valid();
}

bool query_success(Api& api,
                   int64_t handle,
                   const char* kind,
                   const char* path,
                   const char* sql,
                   std::string& output)
{
    int32_t status = 0;
    return query(api, handle, kind, path, sql, output, status) && status == 0;
}

bool query_expected_failure(Api& api,
                            int64_t handle,
                            const char* kind,
                            const char* path,
                            const char* sql,
                            int32_t expected_status)
{
    void* pointer = reinterpret_cast<void*>(static_cast<std::uintptr_t>(1));
    const int32_t status = api.exec_query(handle, kind, path, sql, &pointer);
    const bool output_cleared = pointer == nullptr;
    if (pointer != nullptr) api.free_string(pointer);
    return status == expected_status && output_cleared;
}

bool object_array(const std::string& json)
{
    return !json.empty() && json.front() == '[' && json.back() == ']' && json.find("{\"") != std::string::npos;
}

std::string json_escape_for_match(std::string_view value)
{
    std::string escaped;
    escaped.reserve(value.size());
    constexpr char kHex[] = "0123456789abcdef";
    for (const char raw_character : value) {
        const unsigned char character = static_cast<unsigned char>(raw_character);
        switch (character) {
        case '"': escaped += "\\\""; break;
        case '\\': escaped += "\\\\"; break;
        case '\b': escaped += "\\b"; break;
        case '\f': escaped += "\\f"; break;
        case '\n': escaped += "\\n"; break;
        case '\r': escaped += "\\r"; break;
        case '\t': escaped += "\\t"; break;
        default:
            if (character < 0x20u) {
                escaped += "\\u00";
                escaped.push_back(kHex[character >> 4u]);
                escaped.push_back(kHex[character & 0x0Fu]);
            } else {
                escaped.push_back(static_cast<char>(character));
            }
            break;
        }
    }
    return escaped;
}

bool database_list_points_to(const std::string& json, const std::string& expected_path)
{
    const auto make_needle = [](const std::string& path) {
        return std::string("\"name\":\"main\",\"file\":\"")
            + json_escape_for_match(path)
            + "\"";
    };
    const std::string needle = make_needle(expected_path);
    std::string slash_normalized_path = expected_path;
    std::replace(slash_normalized_path.begin(), slash_normalized_path.end(), '\\', '/');
    const std::string slash_normalized_needle = make_needle(slash_normalized_path);
    return json.find(needle) != std::string::npos
        || json.find(slash_normalized_needle) != std::string::npos;
}

bool get_logs(Api& api, std::string& output)
{
    output.clear();
    void* pointer = nullptr;
    const int32_t status = api.get_logs(&pointer);
    if (status != 0 || pointer == nullptr) {
        if (pointer != nullptr) api.free_string(pointer);
        return false;
    }
    output.assign(static_cast<const char*>(pointer));
    api.free_string(pointer);
    return JsonSyntax(output).valid();
}

bool run(const Options& options)
{
    std::wstring api_path;
    std::wstring session_path;
    std::wstring contact_path;
    std::wstring message_path;
    std::wstring general_path;
    std::wstring sns_path;
    std::wstring contact_fts_path = options.contact_fts_path;
    if (!absolute_existing_file(options.api_path, api_path)
        || !absolute_existing_file(options.session_path, session_path)
        || !absolute_existing_file(options.contact_path, contact_path)
        || !absolute_existing_file(options.message_path, message_path)
        || !absolute_existing_file(options.general_path, general_path)
        || !absolute_existing_file(options.sns_path, sns_path)) {
        emit_failure("arguments");
        return false;
    }
    if (contact_fts_path.empty()) {
        contact_fts_path = (std::filesystem::path(contact_path).parent_path() / L"contact_fts.db").wstring();
    }

    std::string session_utf8;
    std::string contact_utf8;
    std::string message_utf8;
    std::string general_utf8;
    std::string sns_utf8;
    if (!wide_to_utf8(session_path, session_utf8)
        || !wide_to_utf8(contact_path, contact_utf8)
        || !wide_to_utf8(message_path, message_utf8)
        || !wide_to_utf8(general_path, general_utf8)
        || !wide_to_utf8(sns_path, sns_utf8)) {
        emit_failure("path_conversion");
        return false;
    }

    Api api;
    if (!load_api(api_path, api)) {
        emit_failure("candidate_load_or_exports");
        return false;
    }

    std::string key;
    key.reserve(options.key.size());
    for (const wchar_t character : options.key) {
        key.push_back(static_cast<char>(character));
    }
    const int32_t info_status = api.set_client_info("ciphertalk", "probe", "wcdb-api-capi");
    const int32_t version_status = api.set_app_version("wcdb-api-capi");
    const int32_t init_first = api.init();
    const int32_t init_second = api.init();
    if (info_status != 0 || version_status != 0 || init_first != 0 || init_second != 0) {
        emit_failure("init_or_client_info");
        api.shutdown();
        return false;
    }

    void* invalid_output = nullptr;
    const int32_t invalid_handle_status =
        api.exec_query(0, "session", "", "SELECT 1", &invalid_output);
    if (invalid_handle_status != kStatusInvalidArgument || invalid_output != nullptr) {
        emit_failure("invalid_handle");
        api.shutdown();
        return false;
    }

    int64_t handle = 0;
    if (api.open_account(session_utf8.c_str(), key.c_str(), &handle) != 0 || handle <= 0) {
        emit_failure("open_session");
        api.shutdown();
        return false;
    }

    auto cleanup = [&]() {
        if (handle > 0) {
            api.close_account(handle);
            handle = 0;
        }
        api.shutdown();
    };

    std::string open_configuration_logs;
    ProbeCipherConfiguration configuration;
    if (!get_logs(api, open_configuration_logs)
        || !OpenConfigurationLogReader(open_configuration_logs).read(configuration)) {
        cleanup();
        emit_failure("open_configuration_log");
        return false;
    }

    UnsupportedAbiResults unsupported;
    if (!check_unsupported_abi_contract(api, handle, unsupported)) {
        cleanup();
        emit_failure("unsupported_abi_contract");
        return false;
    }

    std::string schema_json;
    if (!query_success(
            api,
            handle,
            "session",
            "",
            "SELECT count(*) AS table_count FROM sqlite_master",
            schema_json)
        || !object_array(schema_json)) {
        cleanup();
        emit_failure("schema_json");
        return false;
    }

    constexpr char kTypeSql[] =
        "SELECT NULL AS null_value, "
        "9223372036854775807 AS int_value, "
        "1.5 AS float_value, "
        "'中文 \"quote\" \\ slash' AS text_value, "
        "X'0001FEFF' AS blob_value";
    const std::string expected_types =
        "[{\"null_value\":null,\"int_value\":9223372036854775807,\"float_value\":1.5,"
        "\"text_value\":\"中文 \\\"quote\\\" \\\\ slash\",\"blob_value\":\"0001feff\"}]";
    std::string types_json;
    if (!query_success(api, handle, "session", "", kTypeSql, types_json)
        || types_json != expected_types) {
        cleanup();
        emit_failure("types_json");
        return false;
    }

    std::string pragma_json;
    if (!query_success(
            api,
            handle,
            "session",
            "",
            "PRAGMA table_info(\"sqlite_master\")",
            pragma_json)
        || !object_array(pragma_json)) {
        cleanup();
        emit_failure("readonly_pragma");
        return false;
    }

    struct Route final {
        const char* kind;
        const std::string* path;
    };
    const std::array<Route, 4> routed = {{
        {"contact", &contact_utf8},
        {"message", &message_utf8},
        {"general", &general_utf8},
        {"sns", &sns_utf8},
    }};
    RoutingResults routing;
    routing.explicit_path_routing = true;
    for (const auto& item : routed) {
        std::string database_list_json;
        if (!query_success(
                api,
                handle,
                item.kind,
                item.path->c_str(),
                "PRAGMA database_list",
                database_list_json)
            || !database_list_points_to(database_list_json, *item.path)) {
            routing.explicit_path_routing = false;
        }
    }

    std::string empty_session_database_list_json;
    const bool empty_session_query = query_success(
        api,
        handle,
        "session",
        "",
        "PRAGMA database_list",
        empty_session_database_list_json);
    routing.empty_path_session_routing = empty_session_query
        && database_list_points_to(empty_session_database_list_json, session_utf8);

    std::string empty_contact_database_list_json;
    const bool empty_contact_database_query = query_success(
        api,
        handle,
        "contact",
        "",
        "PRAGMA database_list",
        empty_contact_database_list_json);
    std::string empty_contact_schema_json;
    const bool empty_contact_schema_query = query_success(
        api,
        handle,
        "contact",
        "",
        "PRAGMA table_info(contact)",
        empty_contact_schema_json);
    routing.empty_path_contact_routing = empty_contact_database_query
        && database_list_points_to(empty_contact_database_list_json, contact_utf8)
        && empty_contact_schema_query;

    std::string empty_general_database_list_json;
    const bool empty_general_query = query_success(
        api,
        handle,
        "general",
        "",
        "PRAGMA database_list",
        empty_general_database_list_json);
    routing.empty_path_general_routing = empty_general_query
        && database_list_points_to(empty_general_database_list_json, general_utf8);

    std::string empty_sns_database_list_json;
    const bool empty_sns_query = query_success(
        api,
        handle,
        "sns",
        "",
        "PRAGMA database_list",
        empty_sns_database_list_json);
    routing.empty_path_sns_routing = empty_sns_query
        && database_list_points_to(empty_sns_database_list_json, sns_utf8);

    std::string explicit_precedence_database_list_json;
    const bool explicit_precedence_query = query_success(
        api,
        handle,
        "classification",
        message_utf8.c_str(),
        "PRAGMA database_list",
        explicit_precedence_database_list_json);
    routing.explicit_path_precedence = explicit_precedence_query
        && database_list_points_to(explicit_precedence_database_list_json, message_utf8);

    routing.empty_message_path_rejected = query_expected_failure(
        api,
        handle,
        "message",
        "",
        "PRAGMA database_list",
        kStatusInvalidArgument);
    std::string route_logs;
    const bool message_route_log_recorded = get_logs(api, route_logs)
        && route_logs.find("\"category\":\"message_path_required\"") != std::string::npos;
    routing.empty_message_path_rejected =
        routing.empty_message_path_rejected && message_route_log_recorded;

    routing.unknown_empty_kind_rejected = query_expected_failure(
        api,
        handle,
        "unknown_kind",
        "",
        "PRAGMA database_list",
        kStatusInvalidArgument);

    // The account opener accepts only the canonical db_storage\\session\\session.db
    // layout. Passing contact.db must be rejected before key/cipher discovery and
    // must never produce a non-zero handle.
    int64_t invalid_layout_handle = 777;
    const int32_t invalid_layout_status =
        api.open_account(contact_utf8.c_str(), key.c_str(), &invalid_layout_handle);
    routing.session_layout_validation =
        invalid_layout_status == kStatusInvalidArgument && invalid_layout_handle == 0;

    if (!routing.explicit_path_routing
        || !routing.empty_path_session_routing
        || !routing.empty_path_contact_routing
        || !routing.empty_path_general_routing
        || !routing.empty_path_sns_routing
        || !routing.explicit_path_precedence
        || !routing.empty_message_path_rejected
        || !routing.unknown_empty_kind_rejected
        || !routing.session_layout_validation) {
        cleanup();
        emit_failure("database_routing");
        return false;
    }

    if (!query_expected_failure(
            api,
            handle,
            "session",
            "",
            "CREATE TABLE ciphertalk_write_probe(value INTEGER)",
            kStatusQueryFailed)
        || !query_expected_failure(
            api,
            handle,
            "session",
            "",
            "PRAGMA user_version = 7",
            kStatusQueryFailed)
        || !query_expected_failure(
            api,
            handle,
            "session",
            "",
            "SELECT count(*) FROM sqlite_master; SELECT 1",
            kStatusQueryFailed)) {
        cleanup();
        emit_failure("write_or_multi_statement_rejection");
        return false;
    }

    int64_t wrong_handle = 123;
    std::string wrong_key = key;
    wrong_key[0] = wrong_key[0] == '0' ? '1' : '0';
    if (api.open_account(session_utf8.c_str(), wrong_key.c_str(), &wrong_handle) != kStatusOpenFailed
        || wrong_handle != 0) {
        cleanup();
        emit_failure("wrong_key");
        return false;
    }

    const std::array<std::string, 4> invalid_keys = {
        "",
        std::string(63, '0'),
        std::string(65, '0'),
        std::string(64, 'g'),
    };
    for (const std::string& invalid_key : invalid_keys) {
        int64_t invalid_key_handle = 999;
        if (api.open_account(session_utf8.c_str(), invalid_key.c_str(), &invalid_key_handle) == 0
            || invalid_key_handle != 0) {
            cleanup();
            emit_failure("invalid_key_inputs");
            return false;
        }
    }

    if (api.close_account(handle) != 0) {
        api.shutdown();
        emit_failure("close_account");
        return false;
    }
    if (api.close_account(handle) != kStatusInvalidArgument) {
        api.shutdown();
        emit_failure("double_close");
        return false;
    }
    void* closed_output = nullptr;
    if (api.exec_query(handle, "session", "", "SELECT 1", &closed_output) != kStatusInvalidArgument
        || closed_output != nullptr) {
        api.shutdown();
        emit_failure("closed_handle");
        return false;
    }
    handle = 0;

    for (int repeat = 0; repeat < 10; ++repeat) {
        int64_t repeated_handle = 0;
        if (api.open_account(session_utf8.c_str(), key.c_str(), &repeated_handle) != 0
            || repeated_handle <= 0) {
            api.shutdown();
            emit_failure("repeat_lifecycle_open");
            return false;
        }
        std::string repeated_json;
        const bool repeated_ok = query_success(
            api,
            repeated_handle,
            "session",
            "",
            "SELECT count(*) AS table_count FROM sqlite_master",
            repeated_json);
        const int32_t repeated_close = api.close_account(repeated_handle);
        if (!repeated_ok || repeated_close != 0) {
            api.shutdown();
            emit_failure("repeat_lifecycle");
            return false;
        }
    }

    if (api.open_account(session_utf8.c_str(), key.c_str(), &handle) != 0 || handle <= 0) {
        api.shutdown();
        emit_failure("fts_session_reopen");
        return false;
    }

    bool mmfts_tokenizer = false;
    const char* mmfts_error = "fts_database_missing";
    std::error_code fts_error;
    if (std::filesystem::is_regular_file(std::filesystem::path(contact_fts_path), fts_error)) {
        std::string contact_fts_utf8;
        if (!wide_to_utf8(contact_fts_path, contact_fts_utf8)) {
            cleanup();
            emit_failure("fts_path_conversion");
            return false;
        }
        std::string fts_output;
        int32_t fts_status = 0;
        const bool fts_valid_json = query(
            api,
            handle,
            "contact",
            contact_fts_utf8.c_str(),
            "SELECT rowid FROM \"contact_fts_v5\" WHERE \"contact_fts_v5\" MATCH 'ciphertalk_fts_probe_token_7f31' LIMIT 1",
            fts_output,
            fts_status);
        (void)fts_valid_json;
        std::string fts_logs;
        if (!get_logs(api, fts_logs)) {
            cleanup();
            emit_failure("fts_logs");
            return false;
        }
        if (fts_status == 0) {
            mmfts_tokenizer = true;
            mmfts_error = "match_succeeded_unexpectedly";
        } else if (fts_logs.find("no_such_tokenizer") != std::string::npos) {
            mmfts_error = "no_such_tokenizer";
        } else {
            mmfts_error = "fts_match_failed_without_tokenizer_category";
        }
    }

    if (api.close_account(handle) != 0) {
        cleanup();
        emit_failure("fts_session_close");
        return false;
    }
    handle = 0;

    const std::filesystem::path session_filesystem_path(session_path);
    const bool wal_present = std::filesystem::is_regular_file(
        std::filesystem::path(session_filesystem_path.wstring() + L"-wal"));
    const bool wal_shm_present = std::filesystem::is_regular_file(
        std::filesystem::path(session_filesystem_path.wstring() + L"-shm"));

    api.shutdown();
    api.shutdown();
    if (api.init() != 0 || api.init() != 0) {
        api.shutdown();
        emit_failure("shutdown_idempotence");
        return false;
    }
    api.shutdown();

    emit_success(
        configuration,
        unsupported,
        routing,
        wal_present,
        wal_shm_present,
        mmfts_tokenizer,
        mmfts_error);
    return !mmfts_tokenizer && std::string_view(mmfts_error) == "no_such_tokenizer";
}

} // namespace

int wmain(int argc, wchar_t** argv)
{
    Options options;
    if (!parse_arguments(argc, argv, options)) {
        emit_failure("arguments");
        return 2;
    }
    try {
        return run(options) ? 0 : 5;
    } catch (const std::exception&) {
        emit_failure("probe_exception");
        return 5;
    }
}
