import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public class im_transport_db_decompile extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) throw new IllegalArgumentException("output address...");
        DecompInterface decompiler = new DecompInterface();
        if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("program unavailable");
        try (PrintWriter output = new PrintWriter(Files.newBufferedWriter(Path.of(args[0]), StandardCharsets.UTF_8))) {
            for (int index = 1; index < args.length && !monitor.isCancelled(); ++index) {
                Function function = getFunctionAt(toAddr(Long.decode(args[index])));
                if (function == null) throw new IllegalArgumentException("function missing: " + args[index]);
                DecompileResults result = decompiler.decompileFunction(function, 600, monitor);
                output.printf("/* %s %s */%n", function.getEntryPoint(), function.getName());
                if (result.decompileCompleted() && result.getDecompiledFunction() != null)
                    output.println(result.getDecompiledFunction().getC());
                else output.printf("/* DECOMPILATION FAILED: %s */%n", result.getErrorMessage());
                output.flush();
            }
        } finally { decompiler.dispose(); }
    }
}
