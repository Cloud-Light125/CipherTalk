#include "json_serializer.hpp"

#include <charconv>
#include <cstring>
#include <iomanip>
#include <iterator>
#include <limits>
#include <sstream>

namespace wcdb_native {

namespace {

constexpr char kHex[] = "0123456789abcdef";

void append_json_string(std::string& output, const char* data, std::size_t length)
{
    output.push_back('"');
    output += json_escape_bytes(data, length);
    output.push_back('"');
}

void append_integer(std::string& output, int64_t value)
{
    char buffer[32]{};
    auto result = std::to_chars(std::begin(buffer), std::end(buffer), value);
    if (result.ec == std::errc()) {
        output.append(buffer, result.ptr);
    }
}

} // namespace

std::string json_escape_bytes(const char* data, std::size_t length)
{
    std::string output;
    output.reserve(length);
    for (std::size_t i = 0; i < length; ++i) {
        const unsigned char byte = static_cast<unsigned char>(data[i]);
        switch (byte) {
        case '\b': output += "\\b"; break;
        case '\t': output += "\\t"; break;
        case '\n': output += "\\n"; break;
        case '\f': output += "\\f"; break;
        case '\r': output += "\\r"; break;
        case '"': output += "\\\""; break;
        case '\\': output += "\\\\"; break;
        default:
            if (byte < 0x20) {
                output += "\\u00";
                output.push_back(kHex[(byte >> 4) & 0x0F]);
                output.push_back(kHex[byte & 0x0F]);
            } else {
                output.push_back(static_cast<char>(byte));
            }
            break;
        }
    }
    return output;
}

std::string serialize_cell(WcdbFns& fns, void* inner_handle, int column)
{
    const int type = fns.inner_handle_column_type(inner_handle, column);
    if (type == 0) {
        return "null";
    }
    if (type == 1) {
        std::string output;
        append_integer(output, fns.inner_handle_integer(inner_handle, column));
        return output;
    }
    if (type == 2) {
        std::ostringstream stream;
        stream << std::setprecision(16) << fns.inner_handle_double(inner_handle, column);
        return stream.str();
    }
    if (type == 4) {
        alignas(16) unsigned char data_storage[kUnsafeDataBytes]{};
        fns.inner_handle_blob(inner_handle, data_storage, column);
        const std::size_t length = fns.unsafe_data_size(data_storage);
        const unsigned char* data = fns.unsafe_data_buffer(data_storage);
        std::string output;
        output.reserve(length * 2 + 2);
        output.push_back('"');
        for (std::size_t i = 0; i < length; ++i) {
            output.push_back(kHex[(data[i] >> 4) & 0x0F]);
            output.push_back(kHex[data[i] & 0x0F]);
        }
        output.push_back('"');
        fns.unsafe_data_dtor(data_storage);
        return output;
    }

    alignas(16) unsigned char text_storage[kUnsafeStringViewBytes]{};
    fns.inner_handle_text(inner_handle, text_storage, column);
    const char* data = fns.unsafe_string_view_data(text_storage);
    const std::size_t length = fns.unsafe_string_view_length(text_storage);
    std::string output;
    append_json_string(output, data ? data : "", data ? length : 0);
    fns.unsafe_string_view_dtor(text_storage);
    return output;
}

int32_t serialize_query(WcdbFns& fns, void* inner_database, const char* sql, std::string& output)
{
    if (inner_database == nullptr) {
        return kStatusInternal;
    }

    alignas(16) unsigned char recyclable_handle[kRecyclableHandleBytes]{};
    fns.inner_database_get_handle(inner_database, recyclable_handle, false, false);
    void* inner_handle = fns.recyclable_handle_get(recyclable_handle);
    if (inner_handle == nullptr) {
        fns.recyclable_handle_dtor(recyclable_handle);
        return kStatusDatabaseFailed;
    }

    alignas(16) unsigned char sql_view[kUnsafeStringViewBytes]{};
    fns.unsafe_string_view_ctor_len(sql_view, sql, std::strlen(sql));
    const bool prepared = fns.inner_handle_prepare(inner_handle, sql_view);
    fns.unsafe_string_view_dtor(sql_view);
    if (!prepared) {
        fns.inner_handle_done(inner_handle);
        fns.recyclable_handle_dtor(recyclable_handle);
        return kStatusQueryFailed;
    }

    std::string rows;
    rows.push_back('[');
    bool first_row = true;
    bool step_succeeded = fns.inner_handle_step(inner_handle);
    while (step_succeeded && !fns.inner_handle_done(inner_handle)) {
        if (!first_row) {
            rows.push_back(',');
        }
        first_row = false;
        rows.push_back('{');
        const int columns = fns.inner_handle_number_of_columns(inner_handle);
        for (int column = 0; column < columns; ++column) {
            if (column != 0) {
                rows.push_back(',');
            }
            alignas(16) unsigned char name_storage[kUnsafeStringViewBytes]{};
            fns.inner_handle_column_name(inner_handle, name_storage, column);
            const char* name = fns.unsafe_string_view_data(name_storage);
            const std::size_t name_length = fns.unsafe_string_view_length(name_storage);
            append_json_string(rows, name ? name : "", name ? name_length : 0);
            fns.unsafe_string_view_dtor(name_storage);
            rows.push_back(':');
            rows += serialize_cell(fns, inner_handle, column);
        }
        rows.push_back('}');
        step_succeeded = fns.inner_handle_step(inner_handle);
    }
    fns.inner_handle_done(inner_handle);
    fns.recyclable_handle_dtor(recyclable_handle);

    if (!step_succeeded) {
        return kStatusQueryFailed;
    }
    rows.push_back(']');
    output = std::move(rows);
    return 0;
}

} // namespace wcdb_native
