cmake_minimum_required(VERSION 3.20)

project(wcdb_api_reimplementation LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(wcdb_api SHARED
    src/exports.cpp
    src/runtime.cpp
    src/json_serializer.cpp
    src/query_executor.cpp
)

target_include_directories(wcdb_api
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

if (WIN32)
    target_compile_definitions(wcdb_api PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_link_libraries(wcdb_api PRIVATE user32)
endif()

if (MINGW)
    # Keep the replacement DLL loadable without requiring Strawberry/MinGW's
    # libstdc++, libgcc, or libwinpthread beside the Electron application.
    target_link_options(wcdb_api PRIVATE -static -static-libgcc -static-libstdc++)
endif()

set_target_properties(wcdb_api PROPERTIES
    OUTPUT_NAME "wcdb_api"
    PREFIX ""
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)

add_executable(wcdb_probe
    tests/wcdb_probe.cpp
)

target_include_directories(wcdb_probe PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(wcdb_probe PRIVATE cxx_std_17)

if (WIN32)
    target_compile_definitions(wcdb_probe PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_link_libraries(wcdb_probe PRIVATE user32)
endif()

if (MINGW)
    target_link_options(wcdb_probe PRIVATE -static -static-libgcc -static-libstdc++)
endif()

set_target_properties(wcdb_probe PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)
