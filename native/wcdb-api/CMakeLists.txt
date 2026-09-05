cmake_minimum_required(VERSION 3.20)

project(wcdb_api_reimplementation LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "wcdb_api requires Windows")
endif()

if(NOT MSVC)
    message(FATAL_ERROR "wcdb_api requires the Visual Studio MSVC toolchain")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(wcdb_api SHARED
    src/exports.cpp
    src/runtime.cpp
    src/sqlite_session.cpp
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
    target_compile_options(wcdb_api PRIVATE /W4 /permissive- /utf-8)
    target_link_libraries(wcdb_api PRIVATE kernel32)
endif()

set_target_properties(wcdb_api PROPERTIES
    OUTPUT_NAME "wcdb_api"
    PREFIX ""
)

foreach(config Debug Release RelWithDebInfo MinSizeRel)
    set_target_properties(wcdb_api PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/${config}"
        LIBRARY_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/${config}"
        ARCHIVE_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/${config}"
    )
endforeach()

add_executable(wcdb_probe
    tests/wcdb_probe.cpp
)

target_include_directories(wcdb_probe PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(wcdb_probe PRIVATE cxx_std_17)

if (WIN32)
    target_compile_definitions(wcdb_probe PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_compile_options(wcdb_probe PRIVATE /W4 /permissive- /utf-8)
    target_link_libraries(wcdb_probe PRIVATE kernel32)
endif()

foreach(config Debug Release RelWithDebInfo MinSizeRel)
    set_target_properties(wcdb_probe PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/${config}"
    )
endforeach()
