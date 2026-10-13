// Java call graph from javac itself (Compiler Tree API), for impact analysis.
// Run with the JDK's source launcher (Java 11+), no build step:
//   java JavaIndex.java <root> <file-list> [classpath]
// It parses and attributes the given sources (-proc:none: no annotation
// processors, nothing from the repository is executed) and prints JSON lines:
//   {"k":"type","fqn":..,"supers":[..],"file":..,"line":..}
//   {"k":"call","file":..,"line":..,"name":..,"owner":..,"params":N,"in":..}
// Only calls resolved to a type declared in the given sources are printed;
// unresolved calls (missing libraries) are left to the caller's heuristics.
import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class JavaIndex {
  static String esc(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }

  // The unit's path relative to the repository root, with forward slashes.
  static String relPath(Path realRoot, CompilationUnitTree u) {
    try {
      Path p = Paths.get(u.getSourceFile().toUri()).toRealPath();
      return realRoot.relativize(p).toString().replace('\\', '/');
    } catch (Exception e) {
      return u.getSourceFile().getName().replace('\\', '/');
    }
  }

  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]).toAbsolutePath();
    List<String> rels = Files.readAllLines(Paths.get(args[1]), StandardCharsets.UTF_8);
    String cp = args.length > 2 ? args[2] : "";
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      System.err.println("no system Java compiler (a JRE without javac?)");
      System.exit(3);
    }
    StandardJavaFileManager fm = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8);
    List<File> files = new ArrayList<>();
    for (String r : rels) {
      if (!r.isEmpty()) files.add(root.resolve(r).toFile());
    }
    Path realRoot = root.toRealPath();
    List<String> options = new ArrayList<>(Arrays.asList("-proc:none", "-implicit:none", "-nowarn", "-Xlint:none", "-Xmaxerrs", "100000"));
    if (!cp.isEmpty()) { options.add("-classpath"); options.add(cp); }
    DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
    JavacTask task = (JavacTask) compiler.getTask(null, fm, diags, options, null, fm.getJavaFileObjectsFromFiles(files));
    Iterable<? extends CompilationUnitTree> units = task.parse();
    // Errors reported by parsing alone are syntax this JDK cannot read (a
    // newer language level, `_` as a name in old code...): one line per file.
    List<Diagnostic<? extends JavaFileObject>> parseErrors = new ArrayList<>(diags.getDiagnostics());
    try { task.analyze(); } catch (Throwable t) { System.err.println("analyze: " + t); }
    Trees trees = Trees.instance(task);
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
    Set<String> reported = new HashSet<>();
    for (Diagnostic<? extends JavaFileObject> d : parseErrors) {
      if (d.getKind() != Diagnostic.Kind.ERROR || d.getSource() == null) continue;
      String rel;
      try { rel = realRoot.relativize(Paths.get(d.getSource().toUri()).toRealPath()).toString().replace('\\', '/'); }
      catch (Exception e) { rel = d.getSource().getName(); }
      if (!reported.add(rel)) continue;
      out.println("{\"k\":\"parse_error\",\"file\":" + esc(rel) + ",\"line\":" + d.getLineNumber() + ",\"msg\":" + esc(d.getMessage(Locale.ROOT).split("\n")[0]) + "}");
    }
    Set<String> declared = new HashSet<>();
    List<CompilationUnitTree> all = new ArrayList<>();
    for (CompilationUnitTree u : units) all.add(u);
    // Pass 1: types declared in these sources, with their supertypes.
    for (CompilationUnitTree u : all) {
      String rel = relPath(realRoot, u);
      new TreePathScanner<Void, Void>() {
        @Override public Void visitClass(ClassTree node, Void v) {
          Element e = trees.getElement(getCurrentPath());
          if (e instanceof TypeElement) {
            TypeElement t = (TypeElement) e;
            declared.add(t.getQualifiedName().toString());
            List<String> supers = new ArrayList<>();
            List<TypeMirror> ms = new ArrayList<>(t.getInterfaces());
            ms.add(t.getSuperclass());
            for (TypeMirror m : ms) {
              if (m instanceof DeclaredType) supers.add(((TypeElement) ((DeclaredType) m).asElement()).getQualifiedName().toString());
            }
            long line = u.getLineMap().getLineNumber(trees.getSourcePositions().getStartPosition(u, node));
            StringBuilder s = new StringBuilder();
            for (String x : supers) s.append(s.length() == 0 ? "" : ",").append(esc(x));
            out.println("{\"k\":\"type\",\"fqn\":" + esc(t.getQualifiedName().toString()) + ",\"supers\":[" + s + "],\"file\":" + esc(rel) + ",\"line\":" + line + "}");
          }
          return super.visitClass(node, v);
        }
      }.scan(new TreePath(u), null);
    }
    // Pass 2: calls (and method references) resolved to those types.
    for (CompilationUnitTree u : all) {
      String rel = relPath(realRoot, u);
      new TreePathScanner<Void, Void>() {
        // pos: where the method's name ends, so a call spread over lines is
        // reported on the line of its name (as a text search would find it).
        void emit(long pos) {
          Element e = trees.getElement(getCurrentPath());
          if (!(e instanceof ExecutableElement)) return;
          Element owner = e.getEnclosingElement();
          if (!(owner instanceof TypeElement)) return;
          String ofqn = ((TypeElement) owner).getQualifiedName().toString();
          if (!declared.contains(ofqn)) return;
          long line = u.getLineMap().getLineNumber(Math.max(0, pos - 1));
          String in = "";
          for (TreePath p = getCurrentPath(); p != null; p = p.getParentPath()) {
            if (p.getLeaf() instanceof MethodTree) { in = ((MethodTree) p.getLeaf()).getName().toString(); break; }
          }
          String name = e.getKind() == ElementKind.CONSTRUCTOR ? "<init>" : e.getSimpleName().toString();
          out.println("{\"k\":\"call\",\"file\":" + esc(rel) + ",\"line\":" + line + ",\"name\":" + esc(name) + ",\"owner\":" + esc(ofqn) + ",\"params\":" + ((ExecutableElement) e).getParameters().size() + ",\"in\":" + esc(in) + "}");
        }
        @Override public Void visitMethodInvocation(MethodInvocationTree node, Void v) {
          emit(trees.getSourcePositions().getEndPosition(u, node.getMethodSelect()));
          return super.visitMethodInvocation(node, v);
        }
        @Override public Void visitMemberReference(MemberReferenceTree node, Void v) {
          emit(trees.getSourcePositions().getEndPosition(u, node));
          return super.visitMemberReference(node, v);
        }
      }.scan(new TreePath(u), null);
    }
    out.flush();
  }
}
