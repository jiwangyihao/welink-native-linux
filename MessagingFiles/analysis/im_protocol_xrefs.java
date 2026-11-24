import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;
import java.io.PrintWriter;
import java.util.TreeMap;
public class im_protocol_xrefs extends GhidraScript {
 protected void run() throws Exception {
  String[] args=getScriptArgs();
  TreeMap<Address,Function> functions=new TreeMap<>();
  for(int n=1;n<args.length;n++) {
   Address address=toAddr(Long.decode(args[n]));
   for(Reference reference:getReferencesTo(address)) {
    Function function=getFunctionContaining(reference.getFromAddress());
    if(function!=null)functions.put(function.getEntryPoint(),function);
   }
  }
  DecompInterface decompiler=new DecompInterface();decompiler.openProgram(currentProgram);
  try(PrintWriter output=new PrintWriter(args[0])) {
   for(Function function:functions.values()) {
    DecompileResults result=decompiler.decompileFunction(function,30,monitor);
    output.printf("/* %s %s */%n",function.getEntryPoint(),function.getName());
    if(result.decompileCompleted())output.println(result.getDecompiledFunction().getC());
   }
  } finally {decompiler.dispose();}
 }
}
