#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

namespace wcdb_probe {

class JsonWriter final {
public:
    explicit JsonWriter(std::size_t max_bytes = 64u * 1024u * 1024u);

    void raw(std::string_view value);
    void string(std::string_view value);
    void integer(std::int64_t value);
    void real(double value);
    void blob(const void* data, std::size_t size);

    const std::string& value() const noexcept { return output_; }
    std::string take() && { return std::move(output_); }

private:
    void append(std::string_view value);
    void append_char(char value);

    std::size_t max_bytes_;
    std::string output_;
};

} // namespace wcdb_probe
