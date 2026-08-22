"""Show the prompt DSPy builds, before and after compiling — no API calls at all."""
import dspy
from dspy.teleprompt import LabeledFewShot
from dspy.adapters import ChatAdapter

class Triage(dspy.Signature):
    """Assign a support ticket a priority."""
    ticket: str = dspy.InputField()
    priority: str = dspy.OutputField(desc="one of P1, P2, P3")

TRAIN = [("I was double-charged on my invoice this month.", "P1"),
         ("Refund still not received after two weeks.", "P1"),
         ("The export button crashes the app every time.", "P2"),
         ("We lost yesterday's uploads after the outage.", "P2"),
         ("Could you add dark mode to the dashboard?", "P3")]
train = [dspy.Example(ticket=t, priority=p).with_inputs("ticket") for t, p in TRAIN]

def render(prog, label):
    msgs = ChatAdapter().format(prog.signature, prog.demos, {"ticket": "My card was charged twice."})
    print(f"\n########## {label}: {len(msgs)} messages, {sum(len(m['content']) for m in msgs)} chars")
    for m in msgs:
        print(f"--- {m['role']} ---")
        print(m["content"][:700])

base = dspy.Predict(Triage)
render(base, "BEFORE compiling (demos=%d)" % len(base.demos))

compiled = LabeledFewShot(k=4).compile(dspy.Predict(Triage), trainset=train)
render(compiled, "AFTER LabeledFewShot (demos=%d)" % len(compiled.demos))
