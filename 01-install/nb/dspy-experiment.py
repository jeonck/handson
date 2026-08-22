"""Measure what compiling a DSPy program actually buys, on one in-house convention."""
import json, time
from dotenv import load_dotenv
load_dotenv()
import dspy
from dspy.teleprompt import BootstrapFewShot

dspy.configure(lm=dspy.LM("gemini/gemini-3.6-flash", max_tokens=2048, cache=False))

# The house rule, nowhere in the model's training data:
#   money problems are P1, outages are P2, everything else P3.
TRAIN = [
    ("I was double-charged on my invoice this month.", "P1"),
    ("Refund still not received after two weeks.", "P1"),
    ("Your billing page shows the wrong VAT rate.", "P1"),
    ("The export button crashes the app every time.", "P2"),
    ("We lost yesterday's uploads after the outage.", "P2"),
    ("API returns 500 on every POST since this morning.", "P2"),
    ("Could you add dark mode to the dashboard?", "P3"),
    ("How do I change my notification settings?", "P3"),
    ("Loving the new reports, great work.", "P3"),
    ("Where can I find the keyboard shortcuts?", "P3"),
]
DEV = [
    ("My card was charged twice for one order.", "P1"),
    ("Invoice total does not match the quote.", "P1"),
    ("Dashboard freezes when I open the reports tab.", "P2"),
    ("Login has been failing for all users since 9am.", "P2"),
    ("Please support CSV export in a future release.", "P3"),
    ("Is there a mobile app planned?", "P3"),
]
mk = lambda rows: [dspy.Example(ticket=t, priority=p).with_inputs("ticket") for t, p in rows]
train, dev = mk(TRAIN), mk(DEV)

class Triage(dspy.Signature):
    """Assign a support ticket a priority."""
    ticket: str = dspy.InputField()
    priority: str = dspy.OutputField(desc="one of P1, P2, P3")

def call(prog, ticket, tries=6):
    """The free tier refuses bursts; back off and keep going rather than losing the run."""
    for i in range(tries):
        try:
            return prog(ticket=ticket).priority.strip().upper()[:2]
        except Exception as e:
            if "429" not in str(e) and "RESOURCE_EXHAUSTED" not in str(e):
                raise
            time.sleep(30)
    raise RuntimeError("still rate limited after backoff")


def score(prog, examples, label):
    hits, rows = 0, []
    for ex in examples:
        got = call(prog, ex.ticket)
        ok = got == ex.priority
        hits += ok
        rows.append({"ticket": ex.ticket, "want": ex.priority, "got": got, "ok": ok})
        time.sleep(7)  # pace: the free tier refuses bursts
    print(f"{label}: {hits}/{len(examples)}")
    for r in rows:
        print(f"   {'ok ' if r['ok'] else 'MISS'} want={r['want']} got={r['got']:3} | {r['ticket'][:44]}")
    return hits, rows

baseline = dspy.Predict(Triage)
b_hits, b_rows = score(baseline, dev, "BASELINE (no examples)")

metric = lambda gold, pred, trace=None: gold.priority == pred.priority.strip().upper()[:2]
compiled = BootstrapFewShot(metric=metric, max_bootstrapped_demos=3, max_labeled_demos=3).compile(
    dspy.Predict(Triage), trainset=train)
print("\ncompiled demos:", len(compiled.predictors()[0].demos))

c_hits, c_rows = score(compiled, dev, "\nCOMPILED (demos chosen by DSPy)")
json.dump({"baseline": b_hits, "compiled": c_hits, "n": len(dev),
           "b_rows": b_rows, "c_rows": c_rows,
           "demos": [{"ticket": d.get("ticket"), "priority": d.get("priority")}
                     for d in compiled.predictors()[0].demos]},
          open("result.json", "w"), indent=1)
print(f"\nRESULT  baseline {b_hits}/{len(dev)}  ->  compiled {c_hits}/{len(dev)}")
