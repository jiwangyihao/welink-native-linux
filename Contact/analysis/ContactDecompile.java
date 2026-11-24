import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;

public class ContactDecompile extends GhidraScript {
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        DecompInterface d = new DecompInterface();
        if (!d.openProgram(currentProgram)) throw new IllegalStateException("openProgram");
        try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Path.of(args[0])))) {
            for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
                if (f.isExternal() || f.isThunk()) continue;
                if (args.length > 1 && f.getEntryPoint().getOffset() >= Long.decode(args[1])) continue;
                out.printf("/* %s %s */%n", f.getEntryPoint(), f.getName());
                DecompileResults r = d.decompileFunction(f, 45, monitor);
                if (r.decompileCompleted()) out.println(r.getDecompiledFunction().getC());
                else out.println("/* FAILED " + r.getErrorMessage() + " */");
            }
        } finally { d.dispose(); }
    }
}
