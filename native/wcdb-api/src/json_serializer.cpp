#include "json_serializer.hpp"

#include "sqlite_session.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace wcdb_native {

namespace {

constexpr int kSqliteOk = 0;
constexpr int kSqliteRow = 100;
constexpr int kSqliteDone = 101;
constexpr int kSqliteNull = 5;
constexpr int kSqliteInteger = 1;
constexpr int kSqliteFloat = 2;
constexpr int kSqliteText = 3;
constexpr int kSqliteBlob = 4;
constexpr char kHex[] = "0123456789abcdef";

bool valid_utf8_sequence(const char* data,
                         std::size_t length,
                         std::size_t offset,
                         std::size_t& sequence_length)
{
    const auto byte_at = [data](std::size_t index) -> unsigned char {
        return static_cast<unsigned char>(data[index]);
    };
    const std::size_t remaining = length - offset;
    const unsigned char first = byte_at(offset);

    if (first <= 0x7Fu) {
        sequence_length = 1;
        return true;
    }
    if (first >= 0xC2u && first <= 0xDFu) {
        if (remaining < 2u || (byte_at(offset + 1u) & 0xC0u) != 0x80u) return false;
        sequence_length = 2;
        return true;
    }
    if (first >= 0xE0u && first <= 0xEFu) {
        if (remaining < 3u) return false;
        const unsigned char second = byte_at(offset + 1u);
        const unsigned char third = byte_at(offset + 2u);
        if ((third & 0xC0u) != 0x80u) return false;
        if (first == 0xE0u) {
            if (second < 0xA0u || second > 0xBFu) return false;
        } else if (first == 0xEDu) {
            if (second < 0x80u || second > 0x9Fu) return false;
        } else if ((second & 0xC0u) != 0x80u) {
            return false;
        }
        sequence_length = 3;
        return true;
    }
    if (first >= 0xF0u && first <= 0xF4u) {
        if (remaining < 4u) return false;
        const unsigned char second = byte_at(offset + 1u);
        if ((byte_at(offset + 2u) & 0xC0u) != 0x80u
            || (byte_at(offset + 3u) & 0xC0u) != 0x80u) {
            return false;
        }
        if (first == 0xF0u) {
            if (second < 0x90u || second > 0xBFu) return false;
        } else if (first == 0xF4u) {
            if (second < 0x80u || second > 0x8Fu) return false;
        } else if ((second & 0xC0u) != 0x80u) {
            return false;
        }
        sequence_length = 4;
        return true;
    }
    return false;
}

void append_json_string(std::string& output, const char* data, std::size_t length)
{
    output.push_back('"');
    output += json_escape_bytes(data == nullptr ? "" : data, data == nullptr ? 0 : length);
    output.push_back('"');
}

void append_json_integer(std::string& output, std::int64_t value)
{
    output += std::to_string(value);
}

void append_json_real(std::string& output, double value)
{
    if (!std::isfinite(value)) throw std::runtime_error("non_finite_float");
    std::ostringstream stream;
    stream.imbue(std::locale::classic());
    stream << std::setprecision(std::numeric_limits<double>::max_digits10) << value;
    if (!stream.good()) throw std::runtime_error("float_format_failure");
    output += stream.str();
}

void append_json_blob(std::string& output, const void* data, std::size_t length)
{
    if (length > 0 && data == nullptr) throw std::runtime_error("null_blob_pointer");
    output.push_back('"');
    const auto* bytes = static_cast<const unsigned char*>(data);
    for (std::size_t index = 0; index < length; ++index) {
        output.push_back(kHex[bytes[index] >> 4u]);
        output.push_back(kHex[bytes[index] & 0x0Fu]);
    }
    output.push_back('"');
}

void set_error(SqliteError& error, int rc, const char* category)
{
    error.sqlite_rc = rc;
    error.sqlite_extended_rc = 0;
    error.category = category == nullptr ? "query_failure" : category;
}

void set_sqlite_error(const WcdbApi& api,
                      sqlite3* database,
                      int rc,
                      const char* category,
                      SqliteError& error)
{
    const char* sqlite_message =
        database == nullptr || api.errmsg == nullptr ? nullptr : api.errmsg(database);
    bool no_such_tokenizer = false;
    if (sqlite_message != nullptr) {
        std::string lower(sqlite_message);
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char value) {
            return static_cast<char>(value >= 'A' && value <= 'Z' ? value - 'A' + 'a' : value);
        });
        no_such_tokenizer = lower.find("no such tokenizer") != std::string::npos;
    }
    error.sqlite_rc = rc;
    error.sqlite_extended_rc =
        database == nullptr || api.extended_errcode == nullptr ? 0 : api.extended_errcode(database);
    error.category = no_such_tokenizer
        ? "no_such_tokenizer"
        : (category == nullptr ? "query_failure" : category);
}

bool prepare_single_read_only(const std::shared_ptr<WcdbApi>& api,
                              sqlite3* database,
                              const char* sql,
                              SqliteStatement& output,
                              SqliteError& error)
{
    sqlite3_stmt* raw_statement = nullptr;
    const char* tail = nullptr;
    const int prepare_rc = api->prepare_v2(database, sql, -1, &raw_statement, &tail);
    SqliteStatement statement(api, raw_statement);
    if (prepare_rc != kSqliteOk || raw_statement == nullptr) {
        set_sqlite_error(*api, database, prepare_rc, "query_prepare_failure", error);
        return false;
    }

    if (api->stmt_readonly(statement.get()) == 0) {
        set_error(error, 0, "write_statement_rejected");
        return false;
    }

    if (tail != nullptr && *tail != '\0') {
        sqlite3_stmt* trailing_raw = nullptr;
        const char* trailing_tail = nullptr;
        const int trailing_rc =
            api->prepare_v2(database, tail, -1, &trailing_raw, &trailing_tail);
        SqliteStatement trailing(api, trailing_raw);
        if (trailing_rc != kSqliteOk) {
            set_sqlite_error(*api, database, trailing_rc, "trailing_sql_failure", error);
            return false;
        }
        if (trailing_raw != nullptr) {
            set_error(error, 0, "multiple_statements_rejected");
            return false;
        }
    }

    output = std::move(statement);
    return true;
}

bool append_cell(const std::shared_ptr<WcdbApi>& api,
                 sqlite3_stmt* statement,
                 int column,
                 std::string& output,
                 SqliteError& error)
{
    const int type = api->column_type(statement, column);
    switch (type) {
    case kSqliteNull:
        output += "null";
        return true;
    case kSqliteInteger:
        append_json_integer(output, api->column_int64(statement, column));
        return true;
    case kSqliteFloat:
        append_json_real(output, api->column_double(statement, column));
        return true;
    case kSqliteText: {
        const int bytes = api->column_bytes(statement, column);
        if (bytes < 0) {
            set_error(error, 0, "negative_text_length");
            return false;
        }
        const auto* text = api->column_text(statement, column);
        if (bytes > 0 && text == nullptr) {
            set_error(error, 0, "null_text_pointer");
            return false;
        }
        append_json_string(
            output,
            reinterpret_cast<const char*>(text),
            static_cast<std::size_t>(bytes));
        return true;
    }
    case kSqliteBlob: {
        const int bytes = api->column_bytes(statement, column);
        if (bytes < 0) {
            set_error(error, 0, "negative_blob_length");
            return false;
        }
        append_json_blob(output, api->column_blob(statement, column), static_cast<std::size_t>(bytes));
        return true;
    }
    default:
        set_error(error, 0, "unknown_sqlite_column_type");
        return false;
    }
}

} // namespace

std::string json_escape_bytes(const char* data, std::size_t length)
{
    if (data == nullptr || length == 0) return {};

    std::string output;
    output.reserve(length);
    for (std::size_t index = 0; index < length;) {
        const unsigned char byte = static_cast<unsigned char>(data[index]);
        switch (byte) {
        case '\b': output += "\\b"; ++index; continue;
        case '\f': output += "\\f"; ++index; continue;
        case '\n': output += "\\n"; ++index; continue;
        case '\r': output += "\\r"; ++index; continue;
        case '\t': output += "\\t"; ++index; continue;
        case '"': output += "\\\""; ++index; continue;
        case '\\': output += "\\\\"; ++index; continue;
        default: break;
        }

        if (byte < 0x20u) {
            output += "\\u00";
            output.push_back(kHex[byte >> 4u]);
            output.push_back(kHex[byte & 0x0Fu]);
            ++index;
            continue;
        }

        std::size_t sequence_length = 0;
        if (valid_utf8_sequence(data, length, index, sequence_length)) {
            output.append(data + index, sequence_length);
            index += sequence_length;
            continue;
        }

        // Keep the returned document valid JSON even if SQLite returns malformed
        // UTF-8 bytes. Valid UTF-8, including Chinese text, is preserved above.
        output += "\\u00";
        output.push_back(kHex[byte >> 4u]);
        output.push_back(kHex[byte & 0x0Fu]);
        ++index;
    }
    return output;
}

int32_t serialize_query(const std::shared_ptr<WcdbApi>& api,
                        sqlite3* database,
                        const char* sql,
                        std::string& output,
                        SqliteError& error)
{
    output.clear();
    error = {};
    if (api == nullptr || database == nullptr || sql == nullptr || *sql == '\0') {
        error.category = "invalid_query_argument";
        return kStatusInvalidArgument;
    }

    try {
        SqliteStatement statement;
        if (!prepare_single_read_only(api, database, sql, statement, error)) {
            return kStatusQueryFailed;
        }

        const int column_count = api->column_count(statement.get());
        if (column_count < 0) {
            set_error(error, 0, "negative_column_count");
            return kStatusQueryFailed;
        }

        std::string result = "[";
        bool first_row = true;
        while (true) {
            const int step_rc = api->step(statement.get());
            if (step_rc == kSqliteDone) break;
            if (step_rc != kSqliteRow) {
                set_sqlite_error(*api, database, step_rc, "query_step_failure", error);
                return kStatusQueryFailed;
            }

            if (!first_row) result.push_back(',');
            first_row = false;
            result.push_back('{');
            for (int column = 0; column < column_count; ++column) {
                if (column != 0) result.push_back(',');
                const char* name = api->column_name(statement.get(), column);
                append_json_string(result, name == nullptr ? "" : name, name == nullptr ? 0 : std::strlen(name));
                result.push_back(':');
                if (!append_cell(api, statement.get(), column, result, error)) {
                    return kStatusQueryFailed;
                }
            }
            result.push_back('}');
        }

        const int finalize_rc = statement.finalize();
        if (finalize_rc != kSqliteOk) {
            set_sqlite_error(*api, database, finalize_rc, "query_finalize_failure", error);
            return kStatusQueryFailed;
        }

        result.push_back(']');
        output = std::move(result);
        return 0;
    } catch (const std::bad_alloc&) {
        output.clear();
        error = {0, 0, "json_allocation_failure"};
        return kStatusQueryFailed;
    } catch (const std::exception&) {
        output.clear();
        error = {0, 0, "json_serialization_failure"};
        return kStatusQueryFailed;
    }
}

} // namespace wcdb_native
