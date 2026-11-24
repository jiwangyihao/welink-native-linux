import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import java.nio.file.Files;
import java.nio.file.Path;

public class ImportWorkflowDecompile extends GhidraScript {
    public void run() throws Exception {
        DecompInterface decompiler = new DecompInterface();
        if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("openProgram");
        try {
            Function function = getFunctionAt(toAddr(0x1003d990L));
            DecompileResults result = decompiler.decompileFunction(function, 240, monitor);
            if (!result.decompileCompleted()) throw new IllegalStateException(result.getErrorMessage());
            Files.writeString(Path.of(getScriptArgs()[0]), result.getDecompiledFunction().getC());
        } finally { decompiler.dispose(); }
    }
}
