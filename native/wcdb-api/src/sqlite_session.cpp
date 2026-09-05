#include "sqlite_session.hpp"

#include <array>
#include <fstream>
#include <utility>
#include <vector>

namespace wcdb_native {

namespace {

constexpr int kSqliteOk = 0;
constexpr int kSqliteRow = 100;
constexpr int kSqliteDone = 101;
constexpr int kSqliteOpenReadonly = 0x00000001;
constexpr int kSqliteOpenFullmutex = 0x00010000;

void set_sqlite_error(const WcdbApi& api,
                      sqlite3* database,
                      int rc,
                      const char* category,
                      SqliteError& error)
{
    error.sqlite_rc = rc;
    error.sqlite_extended_rc =
        database == nullptr || api.extended_errcode == nullptr ? 0 : api.extended_errcode(database);
    error.category = category == nullptr ? "sqlite_failure" : category;
}

bool read_database_salt(const std::string& path,
                        std::array<unsigned char, kSaltBytes>& salt,
                        SqliteError& error)
{
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        error = {0, 0, "database_salt_read_failure"};
        return false;
    }
    input.read(reinterpret_cast<char*>(salt.data()), static_cast<std::streamsize>(salt.size()));
    if (input.gcount() != static_cast<std::streamsize>(salt.size())) {
        SecureZeroMemory(salt.data(), salt.size());
        error = {0, 0, "database_salt_too_short"};
        return false;
    }
    return true;
}

std::string make_raw_key(const SecureKey& key, const std::array<unsigned char, kSaltBytes>& salt)
{
    constexpr char kHex[] = "0123456789abcdef";
    std::string value;
    value.reserve(2u + kKeyBytes * 2u + kSaltBytes * 2u + 1u);
    value.append("x'");
    for (const unsigned char byte : key.bytes) {
        value.push_back(kHex[byte >> 4u]);
        value.push_back(kHex[byte & 0x0Fu]);
    }
    for (const unsigned char byte : salt) {
        value.push_back(kHex[byte >> 4u]);
        value.push_back(kHex[byte & 0x0Fu]);
    }
    value.push_back('\'');
    return value;
}

bool open_read_only(const std::shared_ptr<WcdbApi>& api,
                    const std::string& path,
                    SqliteConnection& output,
                    SqliteError& error)
{
    sqlite3* raw_database = nullptr;
    const int flags = kSqliteOpenReadonly | kSqliteOpenFullmutex;
    const int open_rc = api->open_v2(path.c_str(), &raw_database, flags, nullptr);
    SqliteConnection candidate(api, raw_database);
    if (open_rc != kSqliteOk) {
        set_sqlite_error(*api, raw_database, open_rc, "database_open_failure", error);
        return false;
    }

    const int extended_rc = api->extended_result_codes(candidate.get(), 1);
    if (extended_rc != kSqliteOk) {
        set_sqlite_error(*api, candidate.get(), extended_rc, "extended_result_code_setup_failure", error);
        return false;
    }
    const int busy_rc = api->busy_timeout(candidate.get(), 5000);
    if (busy_rc != kSqliteOk) {
        set_sqlite_error(*api, candidate.get(), busy_rc, "busy_timeout_setup_failure", error);
        return false;
    }

    output = std::move(candidate);
    return true;
}

bool execute_internal_pragma(const std::shared_ptr<WcdbApi>& api,
                             sqlite3* database,
                             const std::string& sql,
                             SqliteError& error)
{
    sqlite3_stmt* raw_statement = nullptr;
    const int prepare_rc = api->prepare_v2(database, sql.c_str(), -1, &raw_statement, nullptr);
    SqliteStatement statement(api, raw_statement);
    if (prepare_rc != kSqliteOk || raw_statement == nullptr) {
        set_sqlite_error(*api, database, prepare_rc, "cipher_config_prepare_failure", error);
        return false;
    }

    while (true) {
        const int step_rc = api->step(statement.get());
        if (step_rc == kSqliteDone) break;
        if (step_rc == kSqliteRow) continue;
        set_sqlite_error(*api, database, step_rc, "cipher_config_step_failure", error);
        return false;
    }

    const int finalize_rc = statement.finalize();
    if (finalize_rc != kSqliteOk) {
        set_sqlite_error(*api, database, finalize_rc, "cipher_config_finalize_failure", error);
        return false;
    }
    return true;
}

bool verify_schema(const std::shared_ptr<WcdbApi>& api,
                   sqlite3* database,
                   SqliteError& error)
{
    constexpr char kSchemaSql[] = "SELECT count(*) FROM sqlite_master";
    sqlite3_stmt* raw_statement = nullptr;
    const int prepare_rc = api->prepare_v2(database, kSchemaSql, -1, &raw_statement, nullptr);
    SqliteStatement statement(api, raw_statement);
    if (prepare_rc != kSqliteOk || raw_statement == nullptr) {
        set_sqlite_error(*api, database, prepare_rc, "schema_probe_prepare_failure", error);
        return false;
    }
    if (api->stmt_readonly(statement.get()) == 0) {
        error = {0, 0, "schema_probe_not_read_only"};
        return false;
    }

    const int first_step_rc = api->step(statement.get());
    if (first_step_rc != kSqliteRow) {
        set_sqlite_error(*api, database, first_step_rc, "schema_probe_step_failure", error);
        return false;
    }
    if (api->column_count(statement.get()) != 1) {
        error = {0, 0, "schema_probe_column_count_failure"};
        return false;
    }

    const int final_step_rc = api->step(statement.get());
    if (final_step_rc != kSqliteDone) {
        set_sqlite_error(*api, database, final_step_rc, "schema_probe_step_failure", error);
        return false;
    }

    const int finalize_rc = statement.finalize();
    if (finalize_rc != kSqliteOk) {
        set_sqlite_error(*api, database, finalize_rc, "schema_probe_finalize_failure", error);
        return false;
    }
    return true;
}

bool apply_key_and_cipher_configuration(const std::shared_ptr<WcdbApi>& api,
                                        const std::string& path,
                                        const SecureKey& key,
                                        const CipherConfiguration& configuration,
                                        sqlite3* database,
                                        SqliteError& error)
{
    if (configuration.key_mode == "passphrase") {
        const int key_rc = api->key_v2(
            database,
            "main",
            key.bytes.data(),
            static_cast<int>(key.bytes.size()));
        if (key_rc != kSqliteOk) {
            set_sqlite_error(*api, database, key_rc, "key_application_failure", error);
            return false;
        }
    } else if (configuration.key_mode == "raw") {
        std::array<unsigned char, kSaltBytes> salt{};
        if (!read_database_salt(path, salt, error)) return false;
        std::string raw_key = make_raw_key(key, salt);
        SecureZeroMemory(salt.data(), salt.size());
        if (raw_key.size() != 99u) {
            SecureZeroMemory(raw_key.data(), raw_key.size());
            error = {0, 0, "raw_key_construction_failure"};
            return false;
        }
        const int key_rc = api->key_v2(
            database,
            "main",
            raw_key.data(),
            static_cast<int>(raw_key.size()));
        SecureZeroMemory(raw_key.data(), raw_key.size());
        if (key_rc != kSqliteOk) {
            set_sqlite_error(*api, database, key_rc, "key_application_failure", error);
            return false;
        }
    } else {
        error = {0, 0, "unknown_key_mode"};
        return false;
    }

    if (configuration.cipher_version != 0) {
        const std::string pragma =
            "PRAGMA cipher_compatibility = " + std::to_string(configuration.cipher_version);
        if (!execute_internal_pragma(api, database, pragma, error)) return false;
    }
    if (configuration.page_size != 0) {
        const std::string pragma =
            "PRAGMA cipher_page_size = " + std::to_string(configuration.page_size);
        if (!execute_internal_pragma(api, database, pragma, error)) return false;
    }
    return true;
}

std::vector<CipherConfiguration> candidate_configurations()
{
    std::vector<CipherConfiguration> result;
    for (const char* key_mode : {"passphrase", "raw"}) {
        for (const int cipher_version : {0, 4, 3}) {
            for (const int page_size : {4096, 1024}) {
                result.push_back({key_mode, page_size, cipher_version});
            }
        }
    }
    return result;
}

} // namespace

int SqliteConnection::close() noexcept
{
    if (database_ == nullptr || api_ == nullptr) {
        database_ = nullptr;
        api_.reset();
        return kSqliteOk;
    }
    const int result = api_->close_v2(database_);
    database_ = nullptr;
    api_.reset();
    return result;
}

int SqliteStatement::finalize() noexcept
{
    if (statement_ == nullptr || api_ == nullptr) {
        statement_ = nullptr;
        api_.reset();
        return kSqliteOk;
    }
    const int result = api_->finalize(statement_);
    statement_ = nullptr;
    api_.reset();
    return result;
}

bool open_configured_database(const std::shared_ptr<WcdbApi>& api,
                              const std::string& database_path,
                              const SecureKey& key,
                              const CipherConfiguration& configuration,
                              SqliteConnection& output,
                              SqliteError& error)
{
    output.close();
    error = {};
    SqliteConnection candidate;
    if (!open_read_only(api, database_path, candidate, error)) return false;
    if (!apply_key_and_cipher_configuration(api, database_path, key, configuration, candidate.get(), error)) {
        return false;
    }
    if (!verify_schema(api, candidate.get(), error)) return false;
    output = std::move(candidate);
    return true;
}

bool discover_database(const std::shared_ptr<WcdbApi>& api,
                       const std::string& database_path,
                       const SecureKey& key,
                       SqliteConnection& output,
                       CipherConfiguration& configuration,
                       SqliteError& error)
{
    output.close();
    error = {};
    for (const CipherConfiguration& candidate_configuration : candidate_configurations()) {
        SqliteConnection candidate;
        SqliteError candidate_error;
        if (open_configured_database(
                api,
                database_path,
                key,
                candidate_configuration,
                candidate,
                candidate_error)) {
            configuration = candidate_configuration;
            output = std::move(candidate);
            return true;
        }
        error = std::move(candidate_error);
    }
    if (error.category.empty()) error.category = "all_cipher_configurations_failed";
    return false;
}

} // namespace wcdb_native
