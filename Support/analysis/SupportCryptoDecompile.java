import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

public class SupportCryptoDecompile extends GhidraScript {
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        DecompInterface d = new DecompInterface();
        if (!d.openProgram(currentProgram)) throw new IllegalStateException("openProgram");
        Set<Function> seen = new HashSet<>();
        ArrayDeque<Function> queue = new ArrayDeque<>();
        for (int i = 1; i < args.length; i++) {
            Function f = getFunctionAt(toAddr(args[i]));
            if (f == null) throw new IllegalArgumentException("Missing function " + args[i]);
            queue.add(f);
        }
        try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(Path.of(args[0])))) {
            while (!queue.isEmpty() && seen.size() < 160) {
                Function f = queue.remove();
                if (!seen.add(f) || f.isExternal()) continue;
                out.printf("/* %s %s */%n", f.getEntryPoint(), f.getName());
                DecompileResults r = d.decompileFunction(f, 30, monitor);
                if (r.decompileCompleted()) out.println(r.getDecompiledFunction().getC());
                else out.println("/* FAILED " + r.getErrorMessage() + " */");
                for (Function c : f.getCalledFunctions(monitor))
                    if (!c.isExternal() && !c.isThunk() && !seen.contains(c)) queue.add(c);
            }
        } finally { d.dispose(); }
    }
}
