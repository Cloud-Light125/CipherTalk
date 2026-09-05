#include "json_writer.hpp"

#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace wcdb_probe {
namespace {

constexpr char kHex[] = "0123456789abcdef";

bool valid_utf8_sequence(std::string_view value, std::size_t offset, std::size_t& sequence_length)
{
    const auto byte = [&value](std::size_t index) -> unsigned char {
        return static_cast<unsigned char>(value[index]);
    };
    const std::size_t remaining = value.size() - offset;
    const unsigned char first = byte(offset);

    if (first <= 0x7Fu) {
        sequence_length = 1;
        return true;
    }
    if (first >= 0xC2u && first <= 0xDFu) {
        if (remaining < 2 || (byte(offset + 1) & 0xC0u) != 0x80u) return false;
        sequence_length = 2;
        return true;
    }
    if (first >= 0xE0u && first <= 0xEFu) {
        if (remaining < 3) return false;
        const unsigned char second = byte(offset + 1);
        const unsigned char third = byte(offset + 2);
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
        if (remaining < 4) return false;
        const unsigned char second = byte(offset + 1);
        if ((byte(offset + 2) & 0xC0u) != 0x80u || (byte(offset + 3) & 0xC0u) != 0x80u) {
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

} // namespace

JsonWriter::JsonWriter(std::size_t max_bytes)
    : max_bytes_(max_bytes)
{
    output_.reserve(1024);
}

void JsonWriter::append(std::string_view value)
{
    if (value.empty()) return;
    if (output_.size() > max_bytes_ || value.size() > max_bytes_ - output_.size()) {
        throw std::runtime_error("JSON output exceeds the configured size limit");
    }
    output_.append(value.data(), value.size());
}

void JsonWriter::append_char(char value)
{
    append(std::string_view(&value, 1));
}

void JsonWriter::raw(std::string_view value)
{
    append(value);
}

void JsonWriter::string(std::string_view value)
{
    append_char('"');
    for (std::size_t i = 0; i < value.size();) {
        const unsigned char current = static_cast<unsigned char>(value[i]);
        switch (current) {
        case '"':
            append("\\\"");
            ++i;
            continue;
        case '\\':
            append("\\\\");
            ++i;
            continue;
        case '\b':
            append("\\b");
            ++i;
            continue;
        case '\f':
            append("\\f");
            ++i;
            continue;
        case '\n':
            append("\\n");
            ++i;
            continue;
        case '\r':
            append("\\r");
            ++i;
            continue;
        case '\t':
            append("\\t");
            ++i;
            continue;
        default:
            break;
        }

        if (current < 0x20u) {
            char escaped[6] = {'\\', 'u', '0', '0', kHex[current >> 4u], kHex[current & 0x0Fu]};
            append(std::string_view(escaped, sizeof(escaped)));
            ++i;
            continue;
        }

        std::size_t sequence_length = 0;
        if (valid_utf8_sequence(value, i, sequence_length)) {
            append(value.substr(i, sequence_length));
            i += sequence_length;
            continue;
        }

        // SQLite TEXT is normally UTF-8. If a malformed byte sequence is
        // returned, escape the byte as a JSON Unicode code point so stdout
        // remains valid JSON instead of emitting malformed UTF-8.
        char escaped[6] = {'\\', 'u', '0', '0', kHex[current >> 4u], kHex[current & 0x0Fu]};
        append(std::string_view(escaped, sizeof(escaped)));
        ++i;
    }
    append_char('"');
}

void JsonWriter::integer(std::int64_t value)
{
    append(std::to_string(value));
}

void JsonWriter::real(double value)
{
    if (!std::isfinite(value)) {
        throw std::runtime_error("SQLite returned a non-finite floating-point value");
    }
    char buffer[64] = {};
    const int written = std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    if (written < 0 || static_cast<std::size_t>(written) >= sizeof(buffer)) {
        throw std::runtime_error("failed to format floating-point value");
    }
    append(std::string_view(buffer, static_cast<std::size_t>(written)));
}

void JsonWriter::blob(const void* data, std::size_t size)
{
    if (size > 0 && data == nullptr) {
        throw std::runtime_error("SQLite returned a null pointer for a non-empty BLOB");
    }
    if (output_.size() > max_bytes_ || max_bytes_ - output_.size() < 2u
        || size > (max_bytes_ - output_.size() - 2u) / 2u) {
        throw std::runtime_error("JSON output exceeds the configured size limit");
    }
    append_char('"');
    const auto* bytes = static_cast<const unsigned char*>(data);
    for (std::size_t i = 0; i < size; ++i) {
        const char encoded[2] = {kHex[bytes[i] >> 4u], kHex[bytes[i] & 0x0Fu]};
        append(std::string_view(encoded, sizeof(encoded)));
    }
    append_char('"');
}

} // namespace wcdb_probe
