#include "json_writer.hpp"
#include "wcdb_symbols.hpp"

#include <windows.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wcdb_probe {
namespace {

constexpr int kSqliteOk = 0;
constexpr int kSqliteRow = 100;
constexpr int kSqliteDone = 101;
constexpr int kSqliteNull = 5;
constexpr int kSqliteInteger = 1;
constexpr int kSqliteFloat = 2;
constexpr int kSqliteText = 3;
constexpr int kSqliteBlob = 4;
constexpr int kSqliteOpenReadOnly = 0x00000001;
constexpr int kSqliteOpenReadWrite = 0x00000002;
constexpr int kSqliteOpenCreate = 0x00000004;
constexpr int kSqliteOpenFullMutex = 0x00010000;
constexpr std::size_t kKeyBytes = 32;
constexpr std::size_t kSaltBytes = 16;
constexpr std::size_t kMaxRepeat = 100;
constexpr std::size_t kMaxLimit = 100000;

enum class Operation {
    Query,
    CheckExports,
    SelfTest,
};

enum class RequestedKeyMode {
    Auto,
    Passphrase,
    Raw,
};

struct Arguments {
    Operation operation = Operation::Query;
    RequestedKeyMode key_mode = RequestedKeyMode::Auto;
    int page_size = 0; // 0 means auto.
    int cipher_version = -1; // -1 means auto, 0 means the default.
    std::size_t limit = 1000;
    std::size_t repeat = 1;
    bool no_cipher = false;
    bool require_stable_output = false;
    bool debug = false;
    bool help = false;
    bool has_wcdb = false;
    bool has_db = false;
    bool has_key = false;
    bool has_sql = false;
    std::wstring wcdb_path;
    std::wstring db_path;
    std::wstring key_hex;
    std::string key_hex_ascii;
    std::wstring sql;
    std::string sql_utf8;
};

struct AttemptFailure {
    std::string key_mode;
    int page_size = 0;
    int cipher_version = 0;
    std::string stage;
    int sqlite_rc = 0;
    int sqlite_extended_rc = 0;
    std::string message;
};

struct ProbeError {
    std::string stage;
    int sqlite_rc = 0;
    int sqlite_extended_rc = 0;
    std::string message;
    std::vector<AttemptFailure> attempts;
    std::vector<std::string> missing_exports;
};

struct CipherConfiguration {
    std::string key_mode = "none";
    int page_size = 0;
    int cipher_version = 0;
};

class Database final {
public:
    Database() = default;
    Database(const WcdbApi* api, sqlite3* database)
        : api_(api)
        , database_(database)
    {
    }

    ~Database()
    {
        close();
    }

    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    Database(Database&& other) noexcept
        : api_(other.api_)
        , database_(other.database_)
    {
        other.api_ = nullptr;
        other.database_ = nullptr;
    }

    Database& operator=(Database&& other) noexcept
    {
        if (this != &other) {
            close();
            api_ = other.api_;
            database_ = other.database_;
            other.api_ = nullptr;
            other.database_ = nullptr;
        }
        return *this;
    }

    sqlite3* get() const noexcept { return database_; }
    bool valid() const noexcept { return database_ != nullptr; }

    int close() noexcept
    {
        if (database_ == nullptr || api_ == nullptr) {
            database_ = nullptr;
            api_ = nullptr;
            return kSqliteOk;
        }
        const int result = api_->close_v2(database_);
        database_ = nullptr;
        api_ = nullptr;
        return result;
    }

private:
    const WcdbApi* api_ = nullptr;
    sqlite3* database_ = nullptr;
};

class Statement final {
public:
    Statement() = default;
    Statement(const WcdbApi* api, sqlite3_stmt* statement)
        : api_(api)
        , statement_(statement)
    {
    }

    ~Statement()
    {
        finalize();
    }

    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;

    Statement(Statement&& other) noexcept
        : api_(other.api_)
        , statement_(other.statement_)
    {
        other.api_ = nullptr;
        other.statement_ = nullptr;
    }

    Statement& operator=(Statement&& other) noexcept
    {
        if (this != &other) {
            finalize();
            api_ = other.api_;
            statement_ = other.statement_;
            other.api_ = nullptr;
            other.statement_ = nullptr;
        }
        return *this;
    }

    sqlite3_stmt* get() const noexcept { return statement_; }

    int finalize() noexcept
    {
        if (statement_ == nullptr || api_ == nullptr) {
            statement_ = nullptr;
            api_ = nullptr;
            return kSqliteOk;
        }
        const int result = api_->finalize(statement_);
        statement_ = nullptr;
        api_ = nullptr;
        return result;
    }

private:
    const WcdbApi* api_ = nullptr;
    sqlite3_stmt* statement_ = nullptr;
};

struct OpenedDatabase {
    Database database;
    CipherConfiguration configuration;
};

struct KeyMaterial final {
    std::array<unsigned char, kKeyBytes> passphrase{};

    ~KeyMaterial()
    {
        SecureZeroMemory(passphrase.data(), passphrase.size());
    }
};

int hex_value(wchar_t value)
{
    if (value >= L'0' && value <= L'9') return static_cast<int>(value - L'0');
    if (value >= L'a' && value <= L'f') return static_cast<int>(value - L'a' + 10);
    if (value >= L'A' && value <= L'F') return static_cast<int>(value - L'A' + 10);
    return -1;
}

bool is_hex_key(std::wstring_view value)
{
    if (value.size() != 64) return false;
    for (const wchar_t character : value) {
        if (hex_value(character) < 0) return false;
    }
    return true;
}

bool decode_key(std::wstring_view value, KeyMaterial& material)
{
    if (!is_hex_key(value)) return false;
    for (std::size_t i = 0; i < kKeyBytes; ++i) {
        const int high = hex_value(value[i * 2]);
        const int low = hex_value(value[i * 2 + 1]);
        material.passphrase[i] = static_cast<unsigned char>((high << 4) | low);
    }
    return true;
}

std::string lowercase_ascii(std::string value)
{
    for (char& character : value) {
        if (character >= 'A' && character <= 'Z') {
            character = static_cast<char>(character - 'A' + 'a');
        }
    }
    return value;
}

std::string redact_key(std::string message, const std::string& key_hex)
{
    if (key_hex.empty()) return message;
    const std::string lower_key = lowercase_ascii(key_hex);
    std::string lower_message = lowercase_ascii(message);
    std::size_t position = 0;
    while ((position = lower_message.find(lower_key, position)) != std::string::npos) {
        message.replace(position, lower_key.size(), "<redacted>");
        lower_message.replace(position, lower_key.size(), "<redacted>");
        position += 10;
    }
    return message;
}

bool wide_to_utf8(std::wstring_view value, std::string& output, std::string& error)
{
    output.clear();
    if (value.empty()) return true;
    if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
        error = "UTF-16 argument is too long";
        return false;
    }

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
    if (required <= 0) {
        error = "UTF-16 to UTF-8 conversion failed";
        return false;
    }

    // Allocate exactly the byte count returned for the input characters. The
    // conversion calls do not include or write a C-string terminator.
    output.assign(static_cast<std::size_t>(required), '\0');
    const int written = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        input_length,
        output.data(),
        required,
        nullptr,
        nullptr);
    if (written != required) {
        output.clear();
        error = "UTF-16 to UTF-8 conversion failed";
        return false;
    }
    return true;
}

bool absolute_path(
    const std::wstring& input,
    std::filesystem::path& output,
    bool must_be_file,
    std::string& error)
{
    if (input.empty()) {
        error = "path argument is empty";
        return false;
    }

    std::error_code filesystem_error;
    const std::filesystem::path candidate(input);
    output = std::filesystem::absolute(candidate, filesystem_error).lexically_normal();
    if (filesystem_error || !output.is_absolute()) {
        error = "path could not be normalized to an absolute path";
        return false;
    }
    if (must_be_file) {
        filesystem_error.clear();
        if (!std::filesystem::is_regular_file(output, filesystem_error) || filesystem_error) {
            error = "path is not an existing regular file";
            return false;
        }
    }
    return true;
}

bool parse_unsigned(std::wstring_view value, std::size_t maximum, std::size_t& output)
{
    if (value.empty()) return false;
    std::size_t result = 0;
    for (const wchar_t character : value) {
        if (character < L'0' || character > L'9') return false;
        const std::size_t digit = static_cast<std::size_t>(character - L'0');
        if (result > (maximum - digit) / 10u) return false;
        result = result * 10u + digit;
    }
    output = result;
    return true;
}

bool parse_key_mode(std::wstring_view value, RequestedKeyMode& output)
{
    if (value == L"auto") {
        output = RequestedKeyMode::Auto;
        return true;
    }
    if (value == L"passphrase") {
        output = RequestedKeyMode::Passphrase;
        return true;
    }
    if (value == L"raw") {
        output = RequestedKeyMode::Raw;
        return true;
    }
    return false;
}

bool parse_page_size(std::wstring_view value, int& output)
{
    if (value == L"auto") {
        output = 0;
        return true;
    }
    if (value == L"4096") {
        output = 4096;
        return true;
    }
    if (value == L"1024") {
        output = 1024;
        return true;
    }
    return false;
}

bool parse_cipher_version(std::wstring_view value, int& output)
{
    if (value == L"auto") {
        output = -1;
        return true;
    }
    if (value == L"0") {
        output = 0;
        return true;
    }
    if (value == L"3") {
        output = 3;
        return true;
    }
    if (value == L"4") {
        output = 4;
        return true;
    }
    return false;
}

bool next_value(
    int& index,
    int argc,
    wchar_t** argv,
    const wchar_t* option,
    std::wstring& value,
    std::string& error)
{
    if (index + 1 >= argc) {
        static_cast<void>(option);
        error = "option requires a value";
        return false;
    }
    value = argv[++index];
    if (value.empty()) {
        static_cast<void>(option);
        error = "option cannot be empty";
        return false;
    }
    return true;
}

bool parse_arguments(int argc, wchar_t** argv, Arguments& arguments, std::string& error)
{
    bool operation_seen = false;
    bool key_mode_seen = false;
    bool page_size_seen = false;
    bool cipher_version_seen = false;
    bool limit_seen = false;
    bool repeat_seen = false;
    bool no_cipher_seen = false;
    bool require_stable_output_seen = false;
    bool debug_seen = false;

    for (int index = 1; index < argc; ++index) {
        const std::wstring_view argument(argv[index]);
        if (argument == L"--help" || argument == L"-h") {
            arguments.help = true;
            continue;
        }
        if (argument == L"--check-exports") {
            if (operation_seen) {
                error = "only one operation may be selected";
                return false;
            }
            arguments.operation = Operation::CheckExports;
            operation_seen = true;
            continue;
        }
        if (argument == L"--self-test") {
            if (operation_seen) {
                error = "only one operation may be selected";
                return false;
            }
            arguments.operation = Operation::SelfTest;
            operation_seen = true;
            continue;
        }
        if (argument == L"--wcdb") {
            if (arguments.has_wcdb || !next_value(index, argc, argv, L"--wcdb", arguments.wcdb_path, error)) {
                if (error.empty()) error = "--wcdb was specified more than once";
                return false;
            }
            arguments.has_wcdb = true;
            continue;
        }
        if (argument == L"--db") {
            if (arguments.has_db || !next_value(index, argc, argv, L"--db", arguments.db_path, error)) {
                if (error.empty()) error = "--db was specified more than once";
                return false;
            }
            arguments.has_db = true;
            continue;
        }
        if (argument == L"--key") {
            if (arguments.has_key || !next_value(index, argc, argv, L"--key", arguments.key_hex, error)) {
                if (error.empty()) error = "--key was specified more than once";
                return false;
            }
            arguments.has_key = true;
            continue;
        }
        if (argument == L"--key-mode") {
            std::wstring value;
            if (key_mode_seen || !next_value(index, argc, argv, L"--key-mode", value, error)) {
                if (error.empty()) error = "--key-mode was specified more than once";
                return false;
            }
            if (!parse_key_mode(value, arguments.key_mode)) {
                error = "--key-mode must be auto, passphrase, or raw";
                return false;
            }
            key_mode_seen = true;
            continue;
        }
        if (argument == L"--page-size") {
            std::wstring value;
            if (page_size_seen || !next_value(index, argc, argv, L"--page-size", value, error)) {
                if (error.empty()) error = "--page-size was specified more than once";
                return false;
            }
            if (!parse_page_size(value, arguments.page_size)) {
                error = "--page-size must be auto, 4096, or 1024";
                return false;
            }
            page_size_seen = true;
            continue;
        }
        if (argument == L"--cipher-version") {
            std::wstring value;
            if (cipher_version_seen || !next_value(index, argc, argv, L"--cipher-version", value, error)) {
                if (error.empty()) error = "--cipher-version was specified more than once";
                return false;
            }
            if (!parse_cipher_version(value, arguments.cipher_version)) {
                error = "--cipher-version must be auto, 0, 3, or 4";
                return false;
            }
            cipher_version_seen = true;
            continue;
        }
        if (argument == L"--sql") {
            if (arguments.has_sql || !next_value(index, argc, argv, L"--sql", arguments.sql, error)) {
                if (error.empty()) error = "--sql was specified more than once";
                return false;
            }
            arguments.has_sql = true;
            continue;
        }
        if (argument == L"--limit") {
            std::wstring value;
            if (limit_seen || !next_value(index, argc, argv, L"--limit", value, error)) {
                if (error.empty()) error = "--limit was specified more than once";
                return false;
            }
            if (!parse_unsigned(value, kMaxLimit, arguments.limit) || arguments.limit == 0) {
                error = "--limit must be between 1 and 100000";
                return false;
            }
            limit_seen = true;
            continue;
        }
        if (argument == L"--repeat") {
            std::wstring value;
            if (repeat_seen || !next_value(index, argc, argv, L"--repeat", value, error)) {
                if (error.empty()) error = "--repeat was specified more than once";
                return false;
            }
            if (!parse_unsigned(value, kMaxRepeat, arguments.repeat) || arguments.repeat == 0) {
                error = "--repeat must be between 1 and 100";
                return false;
            }
            repeat_seen = true;
            continue;
        }
        if (argument == L"--no-cipher") {
            if (no_cipher_seen) {
                error = "--no-cipher was specified more than once";
                return false;
            }
            arguments.no_cipher = true;
            no_cipher_seen = true;
            continue;
        }
        if (argument == L"--require-stable-output") {
            if (require_stable_output_seen) {
                error = "--require-stable-output was specified more than once";
                return false;
            }
            arguments.require_stable_output = true;
            require_stable_output_seen = true;
            continue;
        }
        if (argument == L"--debug") {
            if (debug_seen) {
                error = "--debug was specified more than once";
                return false;
            }
            arguments.debug = true;
            debug_seen = true;
            continue;
        }

        error = "unknown option";
        return false;
    }

    if (arguments.help) return true;
    if (!arguments.has_wcdb) {
        error = "--wcdb is required";
        return false;
    }
    if (arguments.operation == Operation::Query) {
        if (!arguments.has_db) {
            error = "--db is required for a query";
            return false;
        }
        if (!arguments.has_sql) {
            error = "--sql is required for a query";
            return false;
        }
        if (!arguments.no_cipher && !arguments.has_key) {
            error = "--key is required unless --no-cipher is specified";
            return false;
        }
    } else if (arguments.has_db || arguments.has_key || arguments.has_sql || arguments.no_cipher
        || arguments.require_stable_output) {
        error = "--db, --key, --sql, --no-cipher, and --require-stable-output are query-only options";
        return false;
    }

    if (arguments.operation == Operation::SelfTest) {
        if (!repeat_seen) arguments.repeat = 3;
        if (arguments.repeat < 2) {
            error = "--self-test requires --repeat of at least 2";
            return false;
        }
    }

    if (arguments.has_key) {
        if (!is_hex_key(arguments.key_hex)) {
            error = "--key must contain exactly 64 hexadecimal characters";
            return false;
        }
        arguments.key_hex_ascii.reserve(arguments.key_hex.size());
        for (const wchar_t character : arguments.key_hex) {
            const int value = hex_value(character);
            arguments.key_hex_ascii.push_back(
                static_cast<char>(value < 10 ? ('0' + value) : ('a' + value - 10)));
        }
    }
    return true;
}

std::string sqlite_error(const WcdbApi& api, sqlite3* database, int rc)
{
    const char* message = database == nullptr || api.errmsg == nullptr ? nullptr : api.errmsg(database);
    if (message != nullptr && *message != '\0') return message;
    return "SQLite error " + std::to_string(rc);
}

std::string wcdb_version(const WcdbApi& api)
{
    const char* version = api.libversion == nullptr ? nullptr : api.libversion();
    return version == nullptr ? std::string() : std::string(version);
}

int sqlite_extended_error(const WcdbApi& api, sqlite3* database)
{
    if (database == nullptr || api.extended_errcode == nullptr) return 0;
    return api.extended_errcode(database);
}

void set_error(
    ProbeError& error,
    const std::string& stage,
    int rc,
    int extended_rc,
    std::string message)
{
    error.stage = stage;
    error.sqlite_rc = rc;
    error.sqlite_extended_rc = extended_rc;
    error.message = std::move(message);
}

bool prepare_statement(
    const WcdbApi& api,
    sqlite3* database,
    const std::string& sql,
    Statement& statement,
    ProbeError& error)
{
    sqlite3_stmt* raw_statement = nullptr;
    const int rc = api.prepare_v2(database, sql.c_str(), -1, &raw_statement, nullptr);
    Statement candidate(&api, raw_statement);
    if (rc != kSqliteOk) {
        set_error(
            error,
            "prepare",
            rc,
            sqlite_extended_error(api, database),
            sqlite_error(api, database, rc));
        return false;
    }
    statement = std::move(candidate);
    return true;
}

bool execute_statement(
    const WcdbApi& api,
    sqlite3* database,
    const std::string& sql,
    ProbeError& error)
{
    Statement statement;
    if (!prepare_statement(api, database, sql, statement, error)) {
        error.stage = "cipher_config";
        return false;
    }

    while (true) {
        const int rc = api.step(statement.get());
        if (rc == kSqliteDone) break;
        if (rc == kSqliteRow) continue;
        set_error(
            error,
            "cipher_config",
            rc,
            sqlite_extended_error(api, database),
            sqlite_error(api, database, rc));
        return false;
    }

    const int finalize_rc = statement.finalize();
    if (finalize_rc != kSqliteOk) {
        set_error(
            error,
            "cipher_config",
            finalize_rc,
            sqlite_extended_error(api, database),
            sqlite_error(api, database, finalize_rc));
        return false;
    }
    return true;
}

bool verify_schema_query(const WcdbApi& api, sqlite3* database, ProbeError& error)
{
    Statement statement;
    if (!prepare_statement(api, database, "SELECT count(*) FROM sqlite_master", statement, error)) {
        return false;
    }
    if (api.column_count(statement.get()) != 1) {
        set_error(error, "step", kSqliteOk, 0, "schema verification returned an unexpected column count");
        return false;
    }

    const int first_rc = api.step(statement.get());
    if (first_rc != kSqliteRow) {
        set_error(
            error,
            "step",
            first_rc,
            sqlite_extended_error(api, database),
            sqlite_error(api, database, first_rc));
        return false;
    }
    if (api.column_type(statement.get(), 0) != kSqliteInteger) {
        set_error(error, "step", kSqliteOk, 0, "schema count did not return an integer");
        return false;
    }
    static_cast<void>(api.column_int64(statement.get(), 0));

    const int final_step_rc = api.step(statement.get());
    if (final_step_rc != kSqliteDone) {
        set_error(
            error,
            "step",
            final_step_rc,
            sqlite_extended_error(api, database),
            sqlite_error(api, database, final_step_rc));
        return false;
    }
    const int finalize_rc = statement.finalize();
    if (finalize_rc != kSqliteOk) {
        set_error(
            error,
            "finalize",
            finalize_rc,
            sqlite_extended_error(api, database),
            sqlite_error(api, database, finalize_rc));
        return false;
    }
    return true;
}

bool read_database_salt(
    const std::filesystem::path& database_path,
    std::array<unsigned char, kSaltBytes>& salt,
    std::string& error)
{
    std::ifstream input(database_path, std::ios::binary);
    if (!input) {
        error = "could not read the database salt";
        return false;
    }
    input.read(reinterpret_cast<char*>(salt.data()), static_cast<std::streamsize>(salt.size()));
    if (input.gcount() != static_cast<std::streamsize>(salt.size())) {
        error = "database is shorter than the required 16-byte salt";
        SecureZeroMemory(salt.data(), salt.size());
        return false;
    }
    return true;
}

std::string make_raw_key(const std::string& key_hex, const std::array<unsigned char, kSaltBytes>& salt)
{
    constexpr char hex[] = "0123456789abcdef";
    std::string value;
    value.reserve(99);
    value.append("x'");
    value.append(key_hex);
    for (const unsigned char byte : salt) {
        value.push_back(hex[byte >> 4u]);
        value.push_back(hex[byte & 0x0Fu]);
    }
    value.push_back('\'');
    return value;
}

bool open_read_only(const WcdbApi& api, const std::string& path, Database& output, ProbeError& error)
{
    sqlite3* raw_database = nullptr;
    const int flags = kSqliteOpenReadOnly | kSqliteOpenFullMutex;
    const int rc = api.open_v2(path.c_str(), &raw_database, flags, nullptr);
    Database candidate(&api, raw_database);
    if (rc != kSqliteOk) {
        set_error(
            error,
            "open",
            rc,
            sqlite_extended_error(api, raw_database),
            sqlite_error(api, raw_database, rc));
        return false;
    }
    const int busy_rc = api.busy_timeout(candidate.get(), 5000);
    if (busy_rc != kSqliteOk) {
        set_error(
            error,
            "open",
            busy_rc,
            sqlite_extended_error(api, candidate.get()),
            sqlite_error(api, candidate.get(), busy_rc));
        return false;
    }
    output = std::move(candidate);
    return true;
}

bool open_configured(
    const WcdbApi& api,
    const std::filesystem::path& database_path,
    const std::string& database_path_utf8,
    const std::string& key_hex,
    const KeyMaterial& key_material,
    const CipherConfiguration& configuration,
    Database& output,
    ProbeError& error)
{
    Database candidate;
    if (!open_read_only(api, database_path_utf8, candidate, error)) return false;

    if (configuration.key_mode == "passphrase") {
        const int key_rc = api.key_v2(
            candidate.get(),
            "main",
            key_material.passphrase.data(),
            static_cast<int>(key_material.passphrase.size()));
        if (key_rc != kSqliteOk) {
            set_error(
                error,
                "key",
                key_rc,
                sqlite_extended_error(api, candidate.get()),
                sqlite_error(api, candidate.get(), key_rc));
            return false;
        }
    } else if (configuration.key_mode == "raw") {
        std::array<unsigned char, kSaltBytes> salt{};
        std::string salt_error;
        if (!read_database_salt(database_path, salt, salt_error)) {
            set_error(error, "key", kSqliteOk, 0, std::move(salt_error));
            return false;
        }
        std::string raw_key = make_raw_key(key_hex, salt);
        SecureZeroMemory(salt.data(), salt.size());
        if (raw_key.size() != 99) {
            SecureZeroMemory(raw_key.data(), raw_key.size());
            set_error(error, "key", kSqliteOk, 0, "constructed raw key has an unexpected length");
            return false;
        }
        const int key_rc = api.key_v2(
            candidate.get(),
            "main",
            raw_key.data(),
            static_cast<int>(raw_key.size()));
        SecureZeroMemory(raw_key.data(), raw_key.size());
        if (key_rc != kSqliteOk) {
            set_error(
                error,
                "key",
                key_rc,
                sqlite_extended_error(api, candidate.get()),
                sqlite_error(api, candidate.get(), key_rc));
            return false;
        }
    } else {
        set_error(error, "args", kSqliteOk, 0, "invalid encrypted key mode");
        return false;
    }

    if (configuration.cipher_version != 0) {
        const std::string pragma =
            "PRAGMA cipher_compatibility = " + std::to_string(configuration.cipher_version);
        if (!execute_statement(api, candidate.get(), pragma, error)) return false;
    }
    if (configuration.page_size != 0) {
        const std::string pragma = "PRAGMA cipher_page_size = " + std::to_string(configuration.page_size);
        if (!execute_statement(api, candidate.get(), pragma, error)) return false;
    }
    if (!verify_schema_query(api, candidate.get(), error)) return false;

    output = std::move(candidate);
    return true;
}

std::vector<CipherConfiguration> candidate_configurations(const Arguments& arguments)
{
    std::vector<std::string> key_modes;
    if (arguments.key_mode == RequestedKeyMode::Auto || arguments.key_mode == RequestedKeyMode::Passphrase) {
        key_modes.emplace_back("passphrase");
    }
    if (arguments.key_mode == RequestedKeyMode::Auto || arguments.key_mode == RequestedKeyMode::Raw) {
        key_modes.emplace_back("raw");
    }

    std::vector<int> page_sizes;
    if (arguments.page_size == 0) {
        page_sizes = {4096, 1024};
    } else {
        page_sizes = {arguments.page_size};
    }

    std::vector<int> cipher_versions;
    if (arguments.cipher_version < 0) {
        cipher_versions = {0, 4, 3};
    } else {
        cipher_versions = {arguments.cipher_version};
    }

    std::vector<CipherConfiguration> configurations;
    for (const std::string& key_mode : key_modes) {
        for (const int cipher_version : cipher_versions) {
            for (const int page_size : page_sizes) {
                configurations.push_back({key_mode, page_size, cipher_version});
            }
        }
    }
    return configurations;
}

void debug_attempt(const AttemptFailure& attempt)
{
    std::cerr << "attempt key_mode=" << attempt.key_mode
              << " page_size=" << attempt.page_size
              << " cipher_version=" << attempt.cipher_version
              << " stage=" << attempt.stage
              << " sqlite_rc=" << attempt.sqlite_rc
              << " sqlite_extended_rc=" << attempt.sqlite_extended_rc << '\n';
}

bool discover_encrypted_database(
    const WcdbApi& api,
    const std::filesystem::path& database_path,
    const std::string& database_path_utf8,
    const Arguments& arguments,
    const KeyMaterial& key_material,
    OpenedDatabase& output,
    ProbeError& error)
{
    std::vector<AttemptFailure> attempts;
    for (const CipherConfiguration& configuration : candidate_configurations(arguments)) {
        ProbeError attempt_error;
        Database candidate;
        if (open_configured(
                api,
                database_path,
                database_path_utf8,
                arguments.key_hex_ascii,
                key_material,
                configuration,
                candidate,
                attempt_error)) {
            output.database = std::move(candidate);
            output.configuration = configuration;
            if (arguments.debug) {
                std::cerr << "selected key_mode=" << configuration.key_mode
                          << " page_size=" << configuration.page_size
                          << " cipher_version=" << configuration.cipher_version << '\n';
            }
            return true;
        }

        AttemptFailure failure;
        failure.key_mode = configuration.key_mode;
        failure.page_size = configuration.page_size;
        failure.cipher_version = configuration.cipher_version;
        failure.stage = std::move(attempt_error.stage);
        failure.sqlite_rc = attempt_error.sqlite_rc;
        failure.sqlite_extended_rc = attempt_error.sqlite_extended_rc;
        failure.message = std::move(attempt_error.message);
        if (arguments.debug) debug_attempt(failure);
        attempts.push_back(std::move(failure));
    }

    error.stage = "open";
    error.sqlite_rc = attempts.empty() ? 0 : attempts.back().sqlite_rc;
    error.sqlite_extended_rc = attempts.empty() ? 0 : attempts.back().sqlite_extended_rc;
    error.message = "all encrypted key and cipher configuration attempts failed";
    std::ostringstream detail;
    detail << error.message << " (attempts=" << attempts.size() << ')';
    error.message = detail.str();
    error.attempts = std::move(attempts);
    return false;
}

bool append_column_value(
    const WcdbApi& api,
    sqlite3_stmt* statement,
    int column,
    JsonWriter& json,
    ProbeError& error,
    sqlite3* database)
{
    const int type = api.column_type(statement, column);
    switch (type) {
    case kSqliteNull:
        json.raw("null");
        return true;
    case kSqliteInteger:
        json.integer(api.column_int64(statement, column));
        return true;
    case kSqliteFloat:
        json.real(api.column_double(statement, column));
        return true;
    case kSqliteText: {
        const int byte_count = api.column_bytes(statement, column);
        if (byte_count < 0) {
            set_error(error, "serialize", kSqliteOk, 0, "SQLite returned a negative TEXT byte count");
            return false;
        }
        const auto* text = api.column_text(statement, column);
        if (byte_count > 0 && text == nullptr) {
            set_error(error, "serialize", kSqliteOk, 0, "SQLite returned a null pointer for non-empty TEXT");
            return false;
        }
        if (byte_count == 0) {
            json.string(std::string_view());
        } else {
            json.string(std::string_view(reinterpret_cast<const char*>(text), static_cast<std::size_t>(byte_count)));
        }
        return true;
    }
    case kSqliteBlob: {
        const int byte_count = api.column_bytes(statement, column);
        if (byte_count < 0) {
            set_error(error, "serialize", kSqliteOk, 0, "SQLite returned a negative BLOB byte count");
            return false;
        }
        json.blob(api.column_blob(statement, column), static_cast<std::size_t>(byte_count));
        return true;
    }
    default:
        set_error(
            error,
            "serialize",
            kSqliteOk,
            0,
            "SQLite returned an unknown column type " + std::to_string(type));
        static_cast<void>(database);
        return false;
    }
}

bool query_to_json(
    const WcdbApi& api,
    sqlite3* database,
    const std::string& sql,
    std::size_t limit,
    std::size_t repeat,
    const CipherConfiguration& configuration,
    std::string& output,
    ProbeError& error)
{
    Statement statement;
    if (!prepare_statement(api, database, sql, statement, error)) return false;

    const int column_count = api.column_count(statement.get());
    if (column_count < 0) {
        set_error(error, "prepare", kSqliteOk, 0, "SQLite returned a negative column count");
        return false;
    }

    JsonWriter json;
    json.raw("{\"ok\":true,\"stage\":\"query\",\"wcdb_version\":");
    json.string(wcdb_version(api));
    json.raw(",\"key_mode\":");
    json.string(configuration.key_mode);
    json.raw(",\"page_size\":");
    json.integer(configuration.page_size);
    json.raw(",\"cipher_version\":");
    json.integer(configuration.cipher_version);
    json.raw(",\"columns\":[");
    for (int column = 0; column < column_count; ++column) {
        if (column != 0) json.raw(",");
        const char* name = api.column_name(statement.get(), column);
        json.string(name == nullptr ? std::string_view() : std::string_view(name));
    }
    json.raw("],\"rows\":[");

    std::size_t row_count = 0;
    bool truncated = false;
    while (true) {
        const int rc = api.step(statement.get());
        if (rc == kSqliteDone) break;
        if (rc != kSqliteRow) {
            set_error(
                error,
                "step",
                rc,
                sqlite_extended_error(api, database),
                sqlite_error(api, database, rc));
            return false;
        }
        if (row_count >= limit) {
            truncated = true;
            break;
        }

        if (row_count != 0) json.raw(",");
        json.raw("[");
        for (int column = 0; column < column_count; ++column) {
            if (column != 0) json.raw(",");
            if (!append_column_value(api, statement.get(), column, json, error, database)) return false;
        }
        json.raw("]");
        ++row_count;
    }

    const int finalize_rc = statement.finalize();
    if (finalize_rc != kSqliteOk) {
        set_error(
            error,
            "finalize",
            finalize_rc,
            sqlite_extended_error(api, database),
            sqlite_error(api, database, finalize_rc));
        return false;
    }

    json.raw("],\"row_count\":");
    json.integer(static_cast<std::int64_t>(row_count));
    json.raw(",\"truncated\":");
    json.raw(truncated ? "true" : "false");
    json.raw(",\"repeat\":");
    json.integer(static_cast<std::int64_t>(repeat));
    json.raw("}");
    output = std::move(json).take();
    return true;
}

bool self_test_round(
    const WcdbApi& api,
    std::size_t repeat,
    std::string& output,
    ProbeError& error)
{
    sqlite3* raw_database = nullptr;
    const int flags = kSqliteOpenReadWrite | kSqliteOpenCreate | kSqliteOpenFullMutex;
    const int open_rc = api.open_v2(":memory:", &raw_database, flags, nullptr);
    Database database(&api, raw_database);
    if (open_rc != kSqliteOk) {
        set_error(
            error,
            "open",
            open_rc,
            sqlite_extended_error(api, raw_database),
            sqlite_error(api, raw_database, open_rc));
        return false;
    }
    const int busy_rc = api.busy_timeout(database.get(), 5000);
    if (busy_rc != kSqliteOk) {
        set_error(
            error,
            "open",
            busy_rc,
            sqlite_extended_error(api, database.get()),
            sqlite_error(api, database.get(), busy_rc));
        return false;
    }

    constexpr char kSql[] =
        "SELECT NULL AS null_value, "
        "9223372036854775807 AS int_value, "
        "1.5 AS float_value, "
        "'中文 \"quote\" \\ slash' AS text_value, "
        "X'0001FEFF' AS blob_value";
    constexpr std::string_view expected_text = "中文 \"quote\" \\ slash";
    Statement statement;
    if (!prepare_statement(api, database.get(), kSql, statement, error)) return false;
    if (api.column_count(statement.get()) != 5) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test returned an unexpected column count");
        return false;
    }
    const std::array<const char*, 5> expected_names = {
        "null_value", "int_value", "float_value", "text_value", "blob_value"};
    for (int column = 0; column < 5; ++column) {
        const char* name = api.column_name(statement.get(), column);
        if (name == nullptr
            || std::string_view(name) != expected_names[static_cast<std::size_t>(column)]) {
            set_error(error, "serialize", kSqliteOk, 0, "self-test returned an unexpected column name");
            return false;
        }
    }

    const int first_step_rc = api.step(statement.get());
    if (first_step_rc != kSqliteRow) {
        set_error(
            error,
            "step",
            first_step_rc,
            sqlite_extended_error(api, database.get()),
            sqlite_error(api, database.get(), first_step_rc));
        return false;
    }
    if (api.column_type(statement.get(), 0) != kSqliteNull) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test NULL type check failed");
        return false;
    }
    if (api.column_type(statement.get(), 1) != kSqliteInteger
        || api.column_int64(statement.get(), 1) != std::numeric_limits<std::int64_t>::max()) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test integer value check failed");
        return false;
    }
    if (api.column_type(statement.get(), 2) != kSqliteFloat
        || std::abs(api.column_double(statement.get(), 2) - 1.5) > std::numeric_limits<double>::epsilon()) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test floating-point value check failed");
        return false;
    }
    if (api.column_type(statement.get(), 3) != kSqliteText) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test TEXT type check failed");
        return false;
    }
    const int text_bytes = api.column_bytes(statement.get(), 3);
    const auto* text = api.column_text(statement.get(), 3);
    if (text_bytes != static_cast<int>(expected_text.size())
        || text == nullptr
        || std::string_view(reinterpret_cast<const char*>(text), static_cast<std::size_t>(text_bytes))
            != expected_text) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test TEXT value check failed");
        return false;
    }
    if (api.column_type(statement.get(), 4) != kSqliteBlob) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test BLOB type check failed");
        return false;
    }
    const int blob_bytes = api.column_bytes(statement.get(), 4);
    const auto* blob = static_cast<const unsigned char*>(api.column_blob(statement.get(), 4));
    const std::array<unsigned char, 4> expected_blob = {0x00, 0x01, 0xFE, 0xFF};
    if (blob_bytes != static_cast<int>(expected_blob.size())
        || blob == nullptr
        || !std::equal(expected_blob.begin(), expected_blob.end(), blob)) {
        set_error(error, "serialize", kSqliteOk, 0, "self-test BLOB value check failed");
        return false;
    }

    JsonWriter json;
    json.raw("{\"ok\":true,\"stage\":\"self-test\",\"wcdb_version\":");
    json.string(wcdb_version(api));
    json.raw(",\"columns\":[");
    for (int column = 0; column < 5; ++column) {
        if (column != 0) json.raw(",");
        json.string(expected_names[static_cast<std::size_t>(column)]);
    }
    json.raw("],\"rows\":[[");
    for (int column = 0; column < 5; ++column) {
        if (column != 0) json.raw(",");
        if (!append_column_value(api, statement.get(), column, json, error, database.get())) return false;
    }
    json.raw("]],\"row_count\":1,\"truncated\":false,\"repeat\":");
    json.integer(static_cast<std::int64_t>(repeat));
    json.raw("}");

    const int final_step_rc = api.step(statement.get());
    if (final_step_rc != kSqliteDone) {
        set_error(
            error,
            "step",
            final_step_rc,
            sqlite_extended_error(api, database.get()),
            sqlite_error(api, database.get(), final_step_rc));
        return false;
    }
    const int finalize_rc = statement.finalize();
    if (finalize_rc != kSqliteOk) {
        set_error(
            error,
            "finalize",
            finalize_rc,
            sqlite_extended_error(api, database.get()),
            sqlite_error(api, database.get(), finalize_rc));
        return false;
    }

    JsonWriter escaped_text;
    escaped_text.string(expected_text);
    if (escaped_text.value() != "\"中文 \\\"quote\\\" \\\\ slash\"") {
        set_error(error, "serialize", kSqliteOk, 0, "JSON quote/backslash escaping check failed");
        return false;
    }
    const char controls[] = {0x00, '\b', '\f', '\n', '\r', '\t', 0x1F};
    JsonWriter escaped_controls;
    escaped_controls.string(std::string_view(controls, sizeof(controls)));
    if (escaped_controls.value() != "\"\\u0000\\b\\f\\n\\r\\t\\u001f\"") {
        set_error(error, "serialize", kSqliteOk, 0, "JSON control-character escaping check failed");
        return false;
    }

    output = std::move(json).take();
    const int close_rc = database.close();
    if (close_rc != kSqliteOk) {
        set_error(error, "close", close_rc, 0, "sqlite3_close_v2 failed after self-test");
        return false;
    }
    return true;
}

bool run_self_test(
    const WcdbApi& api,
    std::size_t repeat,
    std::string& output,
    ProbeError& error)
{
    std::string first;
    for (std::size_t index = 0; index < repeat; ++index) {
        std::string current;
        if (!self_test_round(api, repeat, current, error)) return false;
        if (index == 0) {
            first = std::move(current);
        } else if (current != first) {
            set_error(error, "serialize", kSqliteOk, 0, "self-test output changed across repeat rounds");
            return false;
        }
    }
    output = std::move(first);
    return true;
}

bool run_query(
    const WcdbApi& api,
    const Arguments& arguments,
    const std::filesystem::path& database_path,
    const std::string& database_path_utf8,
    std::string& output,
    ProbeError& error)
{
    KeyMaterial key_material;
    if (!arguments.no_cipher && !decode_key(arguments.key_hex, key_material)) {
        set_error(error, "args", kSqliteOk, 0, "--key must contain exactly 64 hexadecimal characters");
        return false;
    }

    std::string first_output;
    CipherConfiguration selected_configuration;
    for (std::size_t index = 0; index < arguments.repeat; ++index) {
        OpenedDatabase opened;
        if (arguments.no_cipher) {
            opened.configuration = {"none", 0, 0};
            if (!open_read_only(api, database_path_utf8, opened.database, error)) return false;
        } else if (index == 0) {
            if (!discover_encrypted_database(
                    api,
                    database_path,
                    database_path_utf8,
                    arguments,
                    key_material,
                    opened,
                    error)) {
                return false;
            }
            selected_configuration = opened.configuration;
        } else {
            opened.configuration = selected_configuration;
            if (!open_configured(
                    api,
                    database_path,
                    database_path_utf8,
                    arguments.key_hex_ascii,
                    key_material,
                    selected_configuration,
                    opened.database,
                    error)) {
                return false;
            }
        }

        std::string current_output;
        if (!query_to_json(
                api,
                opened.database.get(),
                arguments.sql_utf8,
                arguments.limit,
                arguments.repeat,
                opened.configuration,
                current_output,
                error)) {
            return false;
        }
        const int close_rc = opened.database.close();
        if (close_rc != kSqliteOk) {
            set_error(error, "close", close_rc, 0, "sqlite3_close_v2 failed after query");
            return false;
        }

        if (index == 0) {
            first_output = std::move(current_output);
        } else if (arguments.require_stable_output && current_output != first_output) {
            set_error(error, "serialize", kSqliteOk, 0, "query output changed across repeat rounds");
            return false;
        }
    }
    output = std::move(first_output);
    return true;
}

void output_error(const ProbeError& error, const std::string& key_hex)
{
    JsonWriter json(4u * 1024u * 1024u);
    json.raw("{\"ok\":false,\"stage\":");
    json.string(error.stage.empty() ? "args" : error.stage);
    json.raw(",\"sqlite_rc\":");
    json.integer(error.sqlite_rc);
    json.raw(",\"sqlite_extended_rc\":");
    json.integer(error.sqlite_extended_rc);
    json.raw(",\"error\":");
    json.string(redact_key(error.message, key_hex));
    if (!error.missing_exports.empty()) {
        json.raw(",\"missing_exports\":[");
        for (std::size_t index = 0; index < error.missing_exports.size(); ++index) {
            if (index != 0) json.raw(",");
            json.string(error.missing_exports[index]);
        }
        json.raw("]");
    }
    if (!error.attempts.empty()) {
        json.raw(",\"attempts\":[");
        for (std::size_t index = 0; index < error.attempts.size(); ++index) {
            if (index != 0) json.raw(",");
            const AttemptFailure& attempt = error.attempts[index];
            json.raw("{\"key_mode\":");
            json.string(attempt.key_mode);
            json.raw(",\"page_size\":");
            json.integer(attempt.page_size);
            json.raw(",\"cipher_version\":");
            json.integer(attempt.cipher_version);
            json.raw(",\"stage\":");
            json.string(attempt.stage);
            json.raw(",\"sqlite_rc\":");
            json.integer(attempt.sqlite_rc);
            json.raw(",\"sqlite_extended_rc\":");
            json.integer(attempt.sqlite_extended_rc);
            json.raw(",\"error\":");
            json.string(redact_key(attempt.message, key_hex));
            json.raw("}");
        }
        json.raw("]");
    }
    json.raw("}");
    std::cout << json.value() << '\n';
}

void output_exports(const WcdbApi& api)
{
    JsonWriter json;
    json.raw("{\"ok\":true,\"stage\":\"exports\",\"wcdb_version\":");
    json.string(wcdb_version(api));
    json.raw(",\"required_export_count\":");
    json.integer(static_cast<std::int64_t>(WcdbSymbols::required_export_names().size()));
    json.raw(",\"verified_exports\":[");
    const auto& exports = WcdbSymbols::required_export_names();
    for (std::size_t index = 0; index < exports.size(); ++index) {
        if (index != 0) json.raw(",");
        json.string(exports[index]);
    }
    json.raw("]}");
    std::cout << json.value() << '\n';
}

void output_usage()
{
    JsonWriter json;
    json.raw("{\"ok\":true,\"stage\":\"help\",\"usage\":");
    json.string(
        "--check-exports --wcdb <WCDB.dll>; --self-test --wcdb <WCDB.dll>; "
        "--wcdb <WCDB.dll> --db <database.db> --key <64-hex> "
        "[--key-mode auto|passphrase|raw] [--page-size auto|4096|1024] "
        "[--cipher-version auto|0|3|4] --sql <SQL> [--limit N] [--repeat N] "
        "[--no-cipher] [--require-stable-output] [--debug]; "
        "auto cipher order: default (0), compatibility 4, compatibility 3; "
        "each key-mode/cipher-version/page-size attempt uses a new connection; "
        "--require-stable-output is for static database snapshots only");
    json.raw("}");
    std::cout << json.value() << '\n';
}

} // namespace
} // namespace wcdb_probe

int wmain(int argc, wchar_t** argv)
{
    using namespace wcdb_probe;

    Arguments arguments;
    std::string parse_error;
    if (!parse_arguments(argc, argv, arguments, parse_error)) {
        ProbeError error;
        error.stage = "args";
        error.message = std::move(parse_error);
        output_error(error, "");
        return 2;
    }
    if (arguments.help) {
        output_usage();
        return 0;
    }

    try {
    std::filesystem::path wcdb_path;
    std::string path_error;
    if (!absolute_path(arguments.wcdb_path, wcdb_path, true, path_error)) {
        ProbeError error;
        error.stage = "args";
        error.message = std::move(path_error);
        output_error(error, arguments.key_hex_ascii);
        return 2;
    }

    std::filesystem::path database_path;
    if (arguments.operation == Operation::Query
        && !absolute_path(arguments.db_path, database_path, true, path_error)) {
        ProbeError error;
        error.stage = "args";
        error.message = std::move(path_error);
        output_error(error, arguments.key_hex_ascii);
        return 2;
    }

    if (arguments.operation == Operation::Query) {
        if (!wide_to_utf8(arguments.sql, arguments.sql_utf8, path_error)) {
            ProbeError error;
            error.stage = "args";
            error.message = std::move(path_error);
            output_error(error, arguments.key_hex_ascii);
            return 2;
        }
    }

    std::string wcdb_error;
    WcdbSymbols symbols;
    if (!symbols.load(wcdb_path.wstring(), wcdb_error)) {
        ProbeError error;
        if (!symbols.missing_exports().empty()) {
            error.stage = "exports";
            error.message = "one or more required C exports are missing";
            error.missing_exports = symbols.missing_exports();
        } else {
            error.stage = "load";
            error.message = std::move(wcdb_error);
        }
        output_error(error, arguments.key_hex_ascii);
        return 3;
    }

    const WcdbApi& api = symbols.api();
    if (arguments.operation == Operation::CheckExports) {
        output_exports(api);
        return 0;
    }
    if (arguments.operation == Operation::SelfTest) {
        std::string output;
        ProbeError error;
        if (!run_self_test(api, arguments.repeat, output, error)) {
            output_error(error, arguments.key_hex_ascii);
            return 4;
        }
        std::cout << output << '\n';
        return 0;
    }

    std::string output;
    ProbeError error;
    if (!run_query(api, arguments, database_path, database_path.u8string(), output, error)) {
        output_error(error, arguments.key_hex_ascii);
        return 5;
    }
    std::cout << output << '\n';
    return 0;
    } catch (const std::exception& exception) {
        ProbeError error;
        error.stage = "serialize";
        error.message = exception.what();
        output_error(error, arguments.key_hex_ascii);
        return 5;
    }
}
