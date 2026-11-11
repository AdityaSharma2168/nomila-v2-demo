"""Print the decision surface of one or more run artifacts, for the audit. Read-only."""
import json, sys, glob, os, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
def show(path):
    d = json.load(open(path, encoding="utf-8"))
    rec = d["record"]; out = rec.get("output")
    print("=" * 100); print(os.path.relpath(path), "· model", rec.get("model"), "· cost $%.3f" % rec.get("costUsd", 0), "· finish", rec.get("finishReason"), "· truncated", rec.get("truncated"))
    print("structural:", rec.get("structuralProblems")); print("grounding:", [(p["where"], p["ref"], p["reason"]) for p in rec.get("groundingProblems", [])])
    body = out if out else (rec.get("parsed") or {})
    if not out: print("!! NO OUTPUT (gates failed) — showing parsed body")
    def dec(prefix, x):
        k = x.get("decision"); print(f"\n{prefix} → {k}", f"· path {x.get('executionPath') or x.get('execution_path')}" if k == "RECOMMEND" else "", f"· relation {x.get('relationToExistingWork') or x.get('relation_to_existing_work')} · advances {x.get('advances')}" if k == "RECOMMEND" else "")
        if x.get("what"): print("  what:", x["what"])
        print("  why:", x.get("why"))
        if x.get("proposition"): print("  proposition:", x["proposition"]); print("  why_material:", x.get("whyMaterial") or x.get("why_material"), "· source", x.get("sourceClass") or x.get("source_class"))
        if x.get("notSeen") or x.get("not_seen"): print("  not_seen:", x.get("notSeen") or x.get("not_seen"))
        for c in x.get("cites", []): print("   cite", c.get("ref"), "—", c.get("how"))
    for x in body.get("decisions", []): dec(f"objective[{x.get('objectiveId') or x.get('objective_id')}]", x)
    for x in body.get("requested", []): dec(f"request[{x.get('requestId') or x.get('request_id')}]", x)
    for x in body.get("deferred", []): dec(f"deferred[{x.get('objectiveId') or x.get('objective_id')}]", x)
for a in sys.argv[1:]:
    for p in sorted(glob.glob(a)): show(p)
