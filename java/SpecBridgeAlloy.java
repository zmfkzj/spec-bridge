// SpecBridge Alloy bridge: uses the official Alloy 6 Java API (CompUtil parser +
// TranslateAlloyToKodkod) to extract model structure and execute commands.
// Output: one JSON document on stdout. No third-party dependencies besides Alloy.
//
// Usage:
//   java -cp alloy.jar:build SpecBridgeAlloy parse <model.als>
//   java -cp alloy.jar:build SpecBridgeAlloy exec  <model.als> [commandLabel ...]
import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.alloy4.Err;
import edu.mit.csail.sdg.alloy4.ErrorWarning;
import edu.mit.csail.sdg.alloy4.Pair;
import edu.mit.csail.sdg.alloy4.Pos;
import edu.mit.csail.sdg.ast.Assert;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.ast.CommandScope;
import edu.mit.csail.sdg.ast.Expr;
import edu.mit.csail.sdg.ast.Func;
import edu.mit.csail.sdg.ast.Module;
import edu.mit.csail.sdg.ast.Sig;
import edu.mit.csail.sdg.parser.CompUtil;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.A4Tuple;
import edu.mit.csail.sdg.translator.A4TupleSet;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class SpecBridgeAlloy {
  static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
      }
    }
    return b.append('"').toString();
  }

  static String pos(Pos p) {
    if (p == null) return "null";
    return "{\"file\":" + q(p.filename) + ",\"line\":" + p.y + ",\"column\":" + p.x + ",\"endLine\":" + p.y2 + ",\"endColumn\":" + p.x2 + "}";
  }

  static String strip(String label) {
    return label != null && label.startsWith("this/") ? label.substring(5) : label;
  }

  // Names of user sigs/fields referenced by an expression (token scan of the
  // pretty-printed, resolved expression; Alloy prints sig names as this/Name).
  static String refs(Expr e, Module world) {
    String text = e == null ? "" : e.toString();
    Set<String> found = new LinkedHashSet<>();
    for (Sig s : world.getAllReachableUserDefinedSigs()) {
      String n = strip(s.label);
      if (Pattern.compile("(^|[^A-Za-z0-9_'])(this/)?" + Pattern.quote(n) + "($|[^A-Za-z0-9_'])").matcher(text).find()) found.add(n);
      for (Sig.Field f : s.getFields()) {
        if (Pattern.compile("(^|[^A-Za-z0-9_/])" + Pattern.quote(f.label) + "($|[^A-Za-z0-9_])").matcher(text).find()) found.add(n + "." + f.label);
      }
    }
    StringBuilder b = new StringBuilder("[");
    boolean first = true;
    for (String f : found) { if (!first) b.append(','); first = false; b.append(q(f)); }
    return b.append(']').toString();
  }

  static String sigJson(Sig s, Module world) {
    StringBuilder b = new StringBuilder();
    b.append("{\"name\":").append(q(strip(s.label)));
    b.append(",\"pos\":").append(pos(s.pos));
    b.append(",\"abstract\":").append(s.isAbstract != null);
    b.append(",\"one\":").append(s.isOne != null);
    b.append(",\"lone\":").append(s.isLone != null);
    b.append(",\"some\":").append(s.isSome != null);
    b.append(",\"enum\":").append(s.isEnum != null);
    b.append(",\"variable\":").append(s.isVariable != null);
    String parent = null;
    if (s instanceof Sig.PrimSig) {
      Sig.PrimSig ps = (Sig.PrimSig) s;
      if (ps.parent != null && !ps.parent.builtin) parent = strip(ps.parent.label);
    }
    b.append(",\"parent\":").append(q(parent));
    b.append(",\"fields\":[");
    boolean first = true;
    for (Sig.Field f : s.getFields()) {
      if (!first) b.append(',');
      first = false;
      String decl = f.decl().expr.toString();
      b.append("{\"name\":").append(q(f.label)).append(",\"pos\":").append(pos(f.pos))
          .append(",\"decl\":").append(q(decl)).append(",\"variable\":").append(f.isVariable != null)
          .append(",\"multiplicity\":").append(q(multiplicity(f.decl().expr))).append('}');
    }
    b.append("]}");
    return b.toString();
  }

  // Multiplicity keyword of a unary field declaration (one/lone/some/set), as printed by Alloy.
  static String multiplicity(Expr declExpr) {
    String t = declExpr.toString().trim();
    Matcher m = Pattern.compile("^(one|lone|some|set)\\s+[^\\s>-]+$").matcher(t);
    if (m.find()) return m.group(1);
    if (!t.contains("->") && !t.contains(" ")) return "one"; // Alloy default for unary fields
    return null;
  }

  static String commandJson(Command c) {
    StringBuilder b = new StringBuilder();
    b.append("{\"label\":").append(q(c.label));
    b.append(",\"check\":").append(c.check);
    b.append(",\"pos\":").append(pos(c.pos));
    b.append(",\"overall\":").append(c.overall);
    b.append(",\"bitwidth\":").append(c.bitwidth);
    b.append(",\"maxseq\":").append(c.maxseq);
    b.append(",\"minprefix\":").append(c.minprefix);
    b.append(",\"maxprefix\":").append(c.maxprefix);
    b.append(",\"expects\":").append(c.expects);
    b.append(",\"text\":").append(q(c.toString()));
    b.append(",\"target\":").append(q(c.nameExpr == null ? null : strip(c.nameExpr.toString())));
    b.append(",\"scopes\":[");
    boolean first = true;
    for (CommandScope s : c.scope) {
      if (!first) b.append(',');
      first = false;
      b.append("{\"sig\":").append(q(strip(s.sig.label))).append(",\"exact\":").append(s.isExact)
          .append(",\"start\":").append(s.startingScope).append(",\"end\":").append(s.endingScope).append('}');
    }
    b.append("]}");
    return b.toString();
  }

  static String tuples(A4TupleSet ts) {
    StringBuilder b = new StringBuilder("[");
    boolean first = true;
    for (A4Tuple t : ts) {
      if (!first) b.append(',');
      first = false;
      b.append('[');
      for (int i = 0; i < t.arity(); i++) { if (i > 0) b.append(','); b.append(q(t.atom(i))); }
      b.append(']');
    }
    return b.append(']').toString();
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      System.err.println("usage: SpecBridgeAlloy parse|exec <model.als> [command...]");
      System.exit(64);
    }
    String mode = args[0];
    String file = args[1];
    final List<String> warnings = new ArrayList<>();
    A4Reporter rep = new A4Reporter() {
      @Override public void warning(ErrorWarning msg) { warnings.add(msg.toString().trim()); }
    };
    Module world;
    try {
      world = CompUtil.parseEverything_fromFile(rep, null, file);
    } catch (Err e) {
      System.out.println("{\"ok\":false,\"phase\":\"parse\",\"error\":" + q(e.getMessage()) + ",\"pos\":" + pos(e.pos) + "}");
      System.exit(0);
      return;
    }
    StringBuilder out = new StringBuilder();
    out.append("{\"ok\":true,\"alloyVersion\":").append(q(edu.mit.csail.sdg.alloy4.Version.getShortversion()));
    out.append(",\"file\":").append(q(file));
    out.append(",\"modules\":[");
    boolean first = true;
    for (String m : world.getAllReachableModulesFilenames()) { if (!first) out.append(','); first = false; out.append(q(m)); }
    out.append(']');
    if (mode.equals("parse")) {
      out.append(",\"sigs\":[");
      first = true;
      for (Sig s : world.getAllReachableUserDefinedSigs()) {
        if (!first) out.append(',');
        first = false;
        out.append(sigJson(s, world));
      }
      out.append("],\"facts\":[");
      first = true;
      int i = 0;
      for (Pair<String, Expr> f : world.getAllFacts()) {
        if (!first) out.append(',');
        first = false;
        out.append("{\"name\":").append(q(f.a)).append(",\"index\":").append(i++).append(",\"pos\":").append(pos(f.b.span()))
            .append(",\"refs\":").append(refs(f.b, world)).append('}');
      }
      out.append("],\"functions\":[");
      first = true;
      for (Func f : world.getAllFunc()) {
        if (!first) out.append(',');
        first = false;
        String body = f.getBody() == null ? "" : f.getBody().toString();
        out.append("{\"name\":").append(q(strip(f.label))).append(",\"pred\":").append(f.isPred).append(",\"pos\":").append(pos(f.span()))
            .append(",\"params\":").append(f.decls.size()).append(",\"primed\":").append(body.contains("'"))
            .append(",\"refs\":").append(refs(f.getBody(), world)).append('}');
      }
      out.append("],\"assertions\":[");
      first = true;
      for (Assert a : world.getAllAssertions()) {
        if (!first) out.append(',');
        first = false;
        out.append("{\"name\":").append(q(strip(a.label))).append(",\"pos\":").append(pos(a.span())).append(",\"body\":").append(q(a.expr.toString()))
            .append(",\"refs\":").append(refs(a.expr, world)).append('}');
      }
      out.append("],\"commands\":[");
      first = true;
      for (Command c : world.getAllCommands()) {
        if (!first) out.append(',');
        first = false;
        out.append(commandJson(c));
      }
      out.append(']');
    } else if (mode.equals("exec")) {
      Set<String> wanted = new LinkedHashSet<>();
      for (int k = 2; k < args.length; k++) wanted.add(args[k]);
      A4Options opt = new A4Options();
      opt.solver = kodkod.engine.satlab.SATFactory.DEFAULT;
      opt.originalFilename = file;
      out.append(",\"solver\":").append(q(opt.solver.id()));
      out.append(",\"results\":[");
      first = true;
      for (Command c : world.getAllCommands()) {
        if (!wanted.isEmpty() && !wanted.contains(c.label)) continue;
        if (!first) out.append(',');
        first = false;
        long t0 = System.nanoTime();
        out.append("{\"command\":").append(commandJson(c));
        try {
          A4Solution sol = TranslateAlloyToKodkod.execute_command(rep, world.getAllReachableSigs(), c, opt);
          long ms = (System.nanoTime() - t0) / 1000000L;
          out.append(",\"ok\":true,\"satisfiable\":").append(sol.satisfiable()).append(",\"durationMs\":").append(ms);
          if (sol.satisfiable()) {
            int trace = Math.max(1, sol.getTraceLength());
            out.append(",\"traceLength\":").append(sol.getTraceLength()).append(",\"loopState\":").append(sol.getLoopState());
            out.append(",\"states\":[");
            for (int st = 0; st < trace; st++) {
              if (st > 0) out.append(',');
              out.append("{\"sigs\":{");
              boolean f1 = true;
              for (Sig s : world.getAllReachableUserDefinedSigs()) {
                if (!f1) out.append(',');
                f1 = false;
                out.append(q(strip(s.label))).append(':').append(tuples(sol.eval(s, st)));
              }
              out.append("},\"fields\":{");
              f1 = true;
              for (Sig s : world.getAllReachableUserDefinedSigs()) {
                for (Sig.Field f : s.getFields()) {
                  if (!f1) out.append(',');
                  f1 = false;
                  out.append(q(strip(s.label) + "." + f.label)).append(':').append(tuples(sol.eval(f, st)));
                }
              }
              out.append("}}");
            }
            out.append(']');
            StringBuilder skolems = new StringBuilder("{");
            boolean f2 = true;
            for (edu.mit.csail.sdg.ast.ExprVar v : sol.getAllSkolems()) {
              if (!f2) skolems.append(',');
              f2 = false;
              Object val = sol.eval(v, 0);
              skolems.append(q(v.label)).append(':').append(val instanceof A4TupleSet ? tuples((A4TupleSet) val) : q(String.valueOf(val)));
            }
            out.append(",\"skolems\":").append(skolems.append('}'));
          }
        } catch (Err e) {
          out.append(",\"ok\":false,\"error\":").append(q(e.getMessage()));
        }
        out.append('}');
      }
      out.append(']');
    } else {
      System.err.println("unknown mode " + mode);
      System.exit(64);
    }
    out.append(",\"warnings\":[");
    first = true;
    for (String w : warnings) { if (!first) out.append(','); first = false; out.append(q(w)); }
    out.append("]}");
    System.out.println(out);
  }
}
