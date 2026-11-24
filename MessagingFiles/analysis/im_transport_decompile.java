import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public class im_transport_decompile extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 3) throw new IllegalArgumentException("output minimum-address maximum-address");
        long minimum = Long.decode(args[1]), maximum = Long.decode(args[2]);
        DecompInterface decompiler = new DecompInterface();
        if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("program unavailable");
        int count = 0;
        try (PrintWriter output = new PrintWriter(Files.newBufferedWriter(Path.of(args[0]), StandardCharsets.UTF_8))) {
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext() && !monitor.isCancelled()) {
                Function function = functions.next();
                long address = function.getEntryPoint().getOffset();
                if (function.isExternal() || function.isThunk() || address < minimum || address >= maximum) continue;
                DecompileResults result = decompiler.decompileFunction(function, 15, monitor);
                output.printf("/* %s %s */%n", function.getEntryPoint(), function.getName());
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
                    output.println(result.getDecompiledFunction().getC());
                    ++count;
                } else output.printf("/* DECOMPILATION FAILED: %s */%n", result.getErrorMessage());
                output.println();
            }
        } finally { decompiler.dispose(); }
        println("Decompiled selected functions: " + count);
    }
}
