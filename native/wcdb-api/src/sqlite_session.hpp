#pragma once

#include "runtime.hpp"

#include <string>

namespace wcdb_native {

class SqliteConnection final {
public:
    SqliteConnection() = default;
    SqliteConnection(std::shared_ptr<WcdbApi> api, sqlite3* database)
        : api_(std::move(api)), database_(database)
    {
    }

    ~SqliteConnection() { close(); }

    SqliteConnection(const SqliteConnection&) = delete;
    SqliteConnection& operator=(const SqliteConnection&) = delete;

    SqliteConnection(SqliteConnection&& other) noexcept
        : api_(std::move(other.api_)), database_(other.database_)
    {
        other.database_ = nullptr;
    }

    SqliteConnection& operator=(SqliteConnection&& other) noexcept
    {
        if (this != &other) {
            close();
            api_ = std::move(other.api_);
            database_ = other.database_;
            other.database_ = nullptr;
        }
        return *this;
    }

    sqlite3* get() const noexcept { return database_; }
    const std::shared_ptr<WcdbApi>& api() const noexcept { return api_; }

    int close() noexcept;

private:
    std::shared_ptr<WcdbApi> api_;
    sqlite3* database_ = nullptr;
};

class SqliteStatement final {
public:
    SqliteStatement() = default;
    SqliteStatement(std::shared_ptr<WcdbApi> api, sqlite3_stmt* statement)
        : api_(std::move(api)), statement_(statement)
    {
    }

    ~SqliteStatement() { finalize(); }

    SqliteStatement(const SqliteStatement&) = delete;
    SqliteStatement& operator=(const SqliteStatement&) = delete;

    SqliteStatement(SqliteStatement&& other) noexcept
        : api_(std::move(other.api_)), statement_(other.statement_)
    {
        other.statement_ = nullptr;
    }

    SqliteStatement& operator=(SqliteStatement&& other) noexcept
    {
        if (this != &other) {
            finalize();
            api_ = std::move(other.api_);
            statement_ = other.statement_;
            other.statement_ = nullptr;
        }
        return *this;
    }

    sqlite3_stmt* get() const noexcept { return statement_; }

    int finalize() noexcept;

private:
    std::shared_ptr<WcdbApi> api_;
    sqlite3_stmt* statement_ = nullptr;
};

bool open_configured_database(const std::shared_ptr<WcdbApi>& api,
                              const std::string& database_path,
                              const SecureKey& key,
                              const CipherConfiguration& configuration,
                              SqliteConnection& output,
                              SqliteError& error);

bool discover_database(const std::shared_ptr<WcdbApi>& api,
                       const std::string& database_path,
                       const SecureKey& key,
                       SqliteConnection& output,
                       CipherConfiguration& configuration,
                       SqliteError& error);

} // namespace wcdb_native
