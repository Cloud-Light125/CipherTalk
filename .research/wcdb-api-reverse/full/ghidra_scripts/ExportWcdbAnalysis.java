import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.util.task.TaskMonitor;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Read-only export script for the wcdb_api/WCDB Ghidra projects.
 *
 * Script argument 0 is an output directory.  Script argument 1 may be
 * "decompileAll"; otherwise only entry points and reachable helpers are
 * decompiled by the caller that launches this script.
 */
public class ExportWcdbAnalysis extends GhidraScript {
    private static final int MAX_STRING_LENGTH = 240;

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length == 0) {
            println("ExportWcdbAnalysis requires an output directory argument");
            return;
        }

        File outputRoot = new File(args[0]);
        File programRoot = new File(outputRoot, safeFileName(currentProgram.getName()));
        File pseudoRoot = new File(programRoot, "pseudocode");
        if (!pseudoRoot.exists() && !pseudoRoot.mkdirs()) {
            throw new Exception("Cannot create output directory: " + pseudoRoot);
        }

        List<Function> functions = collectFunctions();
        Collections.sort(functions, Comparator.comparingLong(f -> f.getEntryPoint().getOffset()));

        writeProgramInfo(programRoot, functions.size());
        writeFunctions(programRoot, functions);
        writeCallGraph(programRoot, functions);
        writeExports(programRoot);
        decompileFunctions(pseudoRoot, functions, args.length > 1 && "decompileAll".equalsIgnoreCase(args[1]));

        println("ExportWcdbAnalysis: " + currentProgram.getName() + ": " + functions.size() + " internal functions");
    }

    private List<Function> collectFunctions() {
        List<Function> result = new ArrayList<>();
        FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
        while (iterator.hasNext()) {
            Function function = iterator.next();
            if (!function.isExternal()) {
                result.add(function);
            }
        }
        return result;
    }

    private void writeProgramInfo(File root, int count) throws Exception {
        try (PrintWriter out = writer(new File(root, "program.txt"))) {
            out.println("program=" + currentProgram.getName());
            out.println("language=" + currentProgram.getLanguageID());
            out.println("compiler=" + currentProgram.getCompilerSpec().getCompilerSpecID());
            out.println("imageBase=" + currentProgram.getImageBase());
            out.println("internalFunctionCount=" + count);
        }
    }

    private void writeFunctions(File root, List<Function> functions) throws Exception {
        try (PrintWriter out = writer(new File(root, "functions.tsv"))) {
            out.println("entry_va\trva\tname\tsize_bytes\tcallers\tcallees\tstrings\texternal_apis\tparameter_count\treturn_type");
            for (Function function : functions) {
                List<String> callers = new ArrayList<>();
                List<String> callees = new ArrayList<>();
                Set<String> externalApis = new LinkedHashSet<>();
                try {
                    for (Function caller : function.getCallingFunctions(monitor)) {
                        callers.add(functionLabel(caller));
                    }
                } catch (Exception ignored) {
                    callers.add("<xref-error>");
                }
                try {
                    for (Function callee : function.getCalledFunctions(monitor)) {
                        callees.add(functionLabel(callee));
                        if (callee.isExternal()) {
                            externalApis.add(callee.getName());
                        }
                    }
                } catch (Exception ignored) {
                    callees.add("<call-error>");
                }

                List<String> strings = referencedStrings(function);
                long size = estimatedSize(function);
                String rva = formatHex(function.getEntryPoint().getOffset() - currentProgram.getImageBase().getOffset());
                String entry = function.getEntryPoint().toString();
                int parameterCount = function.getParameterCount();
                String returnType = function.getReturnType() == null ? "" : function.getReturnType().getDisplayName();
                out.println(joinTsv(
                    entry,
                    rva,
                    function.getName(),
                    Long.toString(size),
                    joinList(callers),
                    joinList(callees),
                    joinList(strings),
                    joinList(new ArrayList<>(externalApis)),
                    Integer.toString(parameterCount),
                    returnType
                ));
            }
        }
    }

    private void writeCallGraph(File root, List<Function> functions) throws Exception {
        try (PrintWriter out = writer(new File(root, "callgraph.tsv"))) {
            out.println("caller_va\tcaller\tcallee_va\tcallee\texternal");
            for (Function function : functions) {
                try {
                    for (Function callee : function.getCalledFunctions(monitor)) {
                        out.println(joinTsv(
                            function.getEntryPoint().toString(),
                            function.getName(),
                            callee.getEntryPoint().toString(),
                            functionLabel(callee),
                            Boolean.toString(callee.isExternal())
                        ));
                    }
                } catch (Exception ignored) {
                    // The function inventory retains the error marker; do not
                    // abort the rest of the program export for one bad xref.
                }
            }
        }
    }

    private void writeExports(File root) throws Exception {
        try (PrintWriter out = writer(new File(root, "exports.tsv"))) {
            out.println("symbol\taddress\tfunction\tsource");
            SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
            while (symbols.hasNext()) {
                Symbol symbol = symbols.next();
                String name = symbol.getName();
                if (!name.startsWith("wcdb_")) {
                    continue;
                }
                Function function = currentProgram.getFunctionManager().getFunctionAt(symbol.getAddress());
                String functionName = function == null ? "" : function.getName();
                SourceType source = symbol.getSource();
                out.println(joinTsv(name, symbol.getAddress().toString(), functionName, source == null ? "" : source.toString()));
            }
        }
    }

    private void decompileFunctions(File root, List<Function> functions, boolean all) throws Exception {
        DecompInterface decompiler = new DecompInterface();
        decompiler.setOptions(new DecompileOptions());
        decompiler.openProgram(currentProgram);
        try (PrintWriter index = writer(new File(root, "index.tsv"))) {
            index.println("address\tname\tfile\tstatus");
            for (Function function : functions) {
                if (!all && !function.getName().startsWith("wcdb_")) {
                    continue;
                }
                String fileName = "function_" + Long.toHexString(function.getEntryPoint().getOffset()) + ".c.txt";
                File target = new File(root, fileName);
                String status;
                try (PrintWriter out = writer(target)) {
                    DecompileResults result = decompiler.decompileFunction(function, 30, monitor);
                    if (result != null && result.decompileCompleted() && result.getDecompiledFunction() != null) {
                        out.println("/* " + function.getEntryPoint() + " " + function.getName() + " */");
                        out.println(result.getDecompiledFunction().getC());
                        status = "ok";
                    } else {
                        String error = result == null ? "no-result" : result.getErrorMessage();
                        out.println("/* decompile failed: " + escapeComment(error) + " */");
                        status = "failed";
                    }
                } catch (Exception ex) {
                    status = "exception:" + ex.getClass().getSimpleName();
                }
                index.println(joinTsv(function.getEntryPoint().toString(), function.getName(), fileName, status));
            }
        } finally {
            decompiler.dispose();
        }
    }

    private List<String> referencedStrings(Function function) {
        Set<String> found = new LinkedHashSet<>();
        Listing listing = currentProgram.getListing();
        InstructionIterator instructions = listing.getInstructions(function.getBody(), true);
        while (instructions.hasNext()) {
            Instruction instruction = instructions.next();
            for (Reference reference : instruction.getReferencesFrom()) {
                Address target = reference.getToAddress();
                Data data = listing.getDataContaining(target);
                if (data == null) {
                    continue;
                }
                Object value = data.getValue();
                String typeName = data.getDataType() == null ? "" : data.getDataType().getName().toLowerCase();
                if (!(value instanceof String) && !typeName.contains("string")) {
                    continue;
                }
                String text = value == null ? "" : String.valueOf(value);
                text = text.replace('\n', ' ').replace('\r', ' ').replace('\t', ' ');
                if (text.length() > MAX_STRING_LENGTH) {
                    text = text.substring(0, MAX_STRING_LENGTH) + "...";
                }
                found.add(target + "=" + text);
            }
        }
        return new ArrayList<>(found);
    }

    private long estimatedSize(Function function) {
        Address entry = function.getEntryPoint();
        Address max = function.getBody().getMaxAddress();
        if (entry == null || max == null || max.getOffset() < entry.getOffset()) {
            return 0;
        }
        return max.getOffset() - entry.getOffset() + 1;
    }

    private String functionLabel(Function function) {
        if (function == null) {
            return "<null>";
        }
        return function.getName() + "@" + function.getEntryPoint();
    }

    private static String formatHex(long value) {
        return String.format("0x%x", value);
    }

    private static String joinList(List<String> values) {
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (builder.length() > 0) {
                builder.append("; ");
            }
            builder.append(value);
        }
        return builder.toString();
    }

    private static String joinTsv(String... values) {
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (builder.length() > 0) {
                builder.append('\t');
            }
            builder.append(value == null ? "" : value.replace('\t', ' ').replace('\r', ' ').replace('\n', ' '));
        }
        return builder.toString();
    }

    private static String safeFileName(String value) {
        return value.replaceAll("[^A-Za-z0-9_.-]", "_");
    }

    private static String escapeComment(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("*/", "* /").replace('\n', ' ').replace('\r', ' ');
    }

    private static PrintWriter writer(File file) throws Exception {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new Exception("Cannot create directory: " + parent);
        }
        return new PrintWriter(new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)));
    }
}
