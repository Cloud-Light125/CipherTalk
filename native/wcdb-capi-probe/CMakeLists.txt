cmake_minimum_required(VERSION 3.20)

project(wcdb_capi_probe LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "wcdb_capi_probe is a Windows-only validation executable")
endif()

if(NOT MSVC)
    message(FATAL_ERROR "wcdb_capi_probe requires the Visual Studio MSVC toolchain")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(wcdb_capi_probe
    src/json_writer.cpp
    src/main.cpp
    src/wcdb_symbols.cpp
)

target_compile_definitions(wcdb_capi_probe PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
)

target_compile_features(wcdb_capi_probe PRIVATE cxx_std_17)

if(MSVC)
    target_compile_options(wcdb_capi_probe PRIVATE /W4 /permissive- /utf-8)
    target_compile_options(wcdb_capi_probe PRIVATE $<$<CONFIG:Release>:/O2>)
endif()

# This target deliberately has no WCDB.lib/sqlite3.lib dependency. Every
# sqlite3_* function is resolved at runtime with LoadLibraryExW/GetProcAddress.
target_link_libraries(wcdb_capi_probe PRIVATE kernel32)

foreach(config Debug Release RelWithDebInfo MinSizeRel)
    set_target_properties(wcdb_capi_probe PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/${config}"
    )
endforeach()
