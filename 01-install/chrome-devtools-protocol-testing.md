---
title: CDP for testing — measurements you can trust, and two coverage calls that always flatter you
date: 2026-08-31
domain: install
tags: [testing, browser, performance, security]
stack: [chrome-devtools-protocol, chrome, python, websockets]
summary: Driving Chrome from forty lines of WebSocket JSON with no automation library. CPU and network emulation both landed within 8% of what they were asked for, while the JS and CSS coverage calls each reported zero unused code on a page that is mostly unused — in the one direction a CI budget would never catch.
source: handson
env: Chrome 152.0.7977.66 (headless=new) · CDP Protocol-Version 1.3 · Python 3.13 · websockets 15.0.1 · macOS 14.7.5 on M1 Pro
verified: 2026-08-31
verifiability: partial
verifiability-note: One Chrome version on one machine, against a four-file static page built for the purpose, so the coverage and emulation behaviour is Chrome 152's and not a protocol guarantee. The security section is entirely defensive and was run against this lab's own throwaway browser holding a cookie the lab set; no other browser, profile or host was touched, and the binding result is macOS-specific.
duration: 60–90 min
risk: low
---

> **Verified 2026-08-31.** Every number came off a throwaway Chrome launched for this page with its
> own `--user-data-dir`. The two coverage results are wrong in the flattering direction and the page
> shows what they should have said.

CDP is the wire protocol underneath Puppeteer, Playwright and the DevTools window itself: a WebSocket
carrying JSON-RPC. **This page uses it directly, because the things worth having for a test suite —
CPU emulation, bandwidth emulation, coverage, request stubbing — are protocol calls, and going
through them once shows which of them can be trusted.**

## Prerequisites

| Item | Check | Expected |
|---|---|---|
| Chrome | `"…/Google Chrome" --version` | 150+ |
| Python client | `python3 -c "import websockets"` | no error |
| Port free | `lsof -nP -iTCP:9222` | nothing listening |

## 1. The lab, on a throwaway profile

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cdp-profile --no-first-run --no-default-browser-check about:blank &
curl -s http://127.0.0.1:9222/json/version
```

```json
{"Browser": "Chrome/152.0.7977.66", "Protocol-Version": "1.3",
 "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/75b3b6b6-…"}
```

**`--user-data-dir` is not optional here.** Attaching to your real browser would put every cookie and
session in that profile behind an unauthenticated local port for as long as the lab runs — which is
the subject of section 6.

## 2. The client

```python title="cdp.py"
class CDP:
    def __init__(self, ws):
        self.ws, self.n, self.events = ws, 0, []

    async def call(self, method, **params):
        self.n += 1
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(await self.ws.recv())
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m["result"]
            self.events.append(m)          # everything unsolicited is an event
```

That is the whole protocol: numbered requests, matching replies, and a stream of events sharing the
socket. Two ordering rules cost an hour between them:

```python title="cdp.py"
async def goto(c, url):
    """Enable first, navigate second, then wait. Order is the whole trick."""
    await c.call("Page.enable")
    await c.call("Runtime.enable")
    await c.call("Page.navigate", url=url)
    await c.until("Page.loadEventFired")
```

**Opening the tab straight at the target URL hangs the wait forever**, because `/json/new?<url>`
navigates before `Page.enable` is on and the load event is gone by the time anything is listening.
And `/json/new` itself:

```
  GET  /json/new -> 405
  PUT  /json/new -> 200
```

**Chrome requires `PUT` there**, so a plain cross-origin `GET` from a web page cannot open tabs — the
first of several protections that section 6 tests properly.

## 3. CPU emulation is accurate to within 8%

A deterministic busy loop in the page, calibrated so one unthrottled run lands near 300 ms, then
`Emulation.setCPUThrottlingRate` with the rates **interleaved inside each repetition** and rate 1
repeated as a control.

```
  calibrated: 43,478,260 rounds -> 272 ms unthrottled

  rate    median ms          spread    observed  expected
  1             271       268–279         1.00x        1x
  2             574       567–591         2.12x        2x
  4            1164     1152–1202         4.29x        4x
  8            2339     2328–2426         8.62x        8x

  control (rate=1) spread: 4.3% of median  -> USABLE
```

**The control is the reason these numbers can be quoted.** A 4.3% spread on the unthrottled case says
the host was quiet enough during the run; the same discipline voided the benchmark in
[[valkey-redis-dragonfly-on-kubernetes]], where the control moved 61% and the medians had to be
thrown away.

The throttle is consistently a little *heavier* than requested — 6%, 7%, 8% over at rates 2, 4 and 8 —
which is the cost of the mechanism itself and is small enough to budget against.

## 4. Bandwidth emulation is tighter still

A 512 KiB payload fetched three times per setting through `Network.emulateNetworkConditions`:

```
  payload: 524,288 bytes (4.19 Mbit)

  limit        median ms      spread   implied Mbps  expected
  unthrottled          4     3–8            998.64         -
  10 Mbps            436   424–439            9.63        10
  4 Mbps            1061  1052–1063           3.95         4
  1 Mbps            4199  4198–4204           1.00         1
```

**1 Mbps came out at 1.00 Mbps and the spread at that setting is six milliseconds over three runs.**
Throttled transfers are more repeatable than unthrottled ones, because the shaper dominates
everything else on the machine — which makes bandwidth the easiest performance budget to enforce in
CI and the one least likely to flake.

## 5. Both coverage calls report zero unused, and both are wrong

`Profiler.takePreciseCoverage` and `CSS.stopRuleUsageTracking` are what the DevTools Coverage panel is
built on. The lab page is deliberately mostly dead: three functions never called, three CSS rules that
match nothing.

The first naive script said:

```
  app.js  715 bytes total, 555 unused (78%)
  app.css 206 bytes total, 0 bytes in unused rules (0%)
          rules used 1 / 1
```

**0% unused CSS, on a stylesheet that is three-quarters unused.** And after exercising the page the JS
number became `0/715 bytes unused (0%)` — better than the truth, again. Two calls, both flattering,
so both were dumped raw.

### `takePreciseCoverage` returns a delta and drops what never ran

```
  take #1 (at load): 7 function entries
      (top)            counts=[1]
      burn             counts=[0]
      window.measure   counts=[0]
      deadCodeA        counts=[0]
      deadCodeB        counts=[0]
      deadCodeC        counts=[0]
      window.loadData  counts=[0]

  take #2 (after measure()): 2 function entries
      burn             counts=[1, 1000]
      window.measure   counts=[1]
```

**The second call returns two functions, not seven.** `deadCodeA`, `deadCodeB` and `loadData` are not
reported with `count: 0` — they are **absent from the payload entirely**. Any script that computes
"unused" as the union of zero-count ranges therefore finds nothing to add up and reports 0% dead.

So `takePreciseCoverage` is a delta since the previous take. Call it **once, at the end of the run**,
or accumulate the deltas yourself. A mid-run call silently resets the counters and every later number
is a lie in your favour.

### `stopRuleUsageTracking` only reports rules that were used

```
  selectors in app.css      : 4  ['.used', '.unused-a', '.unused-b', '.unused-c']
  ruleUsage entries returned: 1
  of those, used=True       : 1
```

**One entry, for the one rule that matched.** The three unused rules are never mentioned, so
`[r for r in ruleUsage if not r["used"]]` is empty and the unused total is zero. Unused CSS is not
something this call returns — it is something you compute by subtracting what it returns from the
stylesheet's own rule list, which you have to fetch separately with `CSS.getStyleSheetText`.

**Both failures point the same way.** Neither call errors, neither returns anything malformed, and
both produce the most flattering possible answer for a dead-code budget. Wired into CI as
`assert unused_pct < 20`, either one passes forever.

## 6. What a reachable debug port hands over — and what still protects it

This section is why the profile in section 1 is a throwaway. Everything below ran against this lab's
own browser, holding a cookie the lab set.

```
  Network.getAllCookies -> session=lab-token-value (httpOnly=True)
  document.cookie in page -> (empty — httpOnly hidden from JS)
```

**`httpOnly` is the standard defence against a script stealing a session cookie, and it is worth
nothing here.** The page cannot read the cookie; the protocol reads it in full. Anything that can
reach the port also gets `Runtime.evaluate`, navigation, and every other domain used on this page —
**the port is not a debugging aid to be secured later, it is unauthenticated control of the browser.**

The protections that do hold, measured:

```
  default binding (port 9222)
    localhost                -> 200
    LAN IP                   -> 000    (refused)
    forged Host: evil.example.com -> 500
    GET  /json/new           -> 405
    PUT  /json/new           -> 200
```

The `500` on a forged `Host` is the DNS-rebinding defence: a page on an attacker's domain cannot make
your browser drive your browser. The `405` closes the same door for tab creation.

And the flag that looks like it removes the network boundary does not:

```
  --remote-debugging-address=0.0.0.0 --remote-debugging-port=9223

  lsof -nP -iTCP:9223 -sTCP:LISTEN
    Google Chrome  127.0.0.1:9223          <- not 0.0.0.0
  chrome log:
    DevTools listening on ws://127.0.0.1:9223/…
  macOS firewall: Firewall is disabled. (State = 0)
```

**Chrome 152 bound to localhost anyway and said so in its own log.** The firewall line is the control:
with it disabled, nothing but Chrome could have refused the bind.

So on this version the network boundary holds by default and resists being switched off. **The
exposure that matters is local** — another process on the host, a container sharing the host network
namespace, an `ssh -L` left open, a CI runner that publishes the port. Treat `--remote-debugging-port`
as equivalent to handing out the browser's cookie jar to every local process, keep it on a throwaway
profile, and do not leave it running past the test.

## Verification checklist

- [x] `/json/version` reports `Chrome/152.0.7977.66` and `Protocol-Version: 1.3`
- [x] A 40-line WebSocket client drives `Target.createTarget`, `Runtime.evaluate`, `Profiler`, `Network`, `Emulation` and `Fetch` with no automation library
- [x] `GET /json/new` returns **405** and `PUT` returns **200**
- [x] Opening a tab directly at the target URL makes `Page.loadEventFired` never arrive; enable-then-navigate fixes it
- [x] CPU throttling control (rate=1) spreads **4.3%** across five interleaved repetitions — the measurement is usable
- [x] Requested 2/4/8x throttling measures **2.12 / 4.29 / 8.62x** — consistently 6–8% heavier than asked
- [x] Requested 10/4/1 Mbps measures **9.63 / 3.95 / 1.00 Mbps** on a 512 KiB payload
- [x] `Profiler.takePreciseCoverage` returns **7 function entries on the first call and 2 on the second** — never-run functions are absent, not zero-counted
- [x] `CSS.stopRuleUsageTracking` returns **1 entry for a stylesheet with 4 selectors**, and it is the used one
- [x] Both coverage calls therefore yield **0% unused** on a page that is mostly unused
- [x] `Fetch.fulfillRequest` serves `/api/data`, which returns **404** unstubbed — the test runs with no backend
- [x] An `httpOnly` cookie is empty in `document.cookie` and fully readable via `Network.getAllCookies`
- [x] A forged `Host` header returns **500**; the LAN IP returns **000**
- [x] With `--remote-debugging-address=0.0.0.0`, `lsof` shows Chrome listening on **127.0.0.1**, with the macOS firewall disabled as the control

## Rollback

```bash
pkill -f "remote-debugging-port=9222"
pkill -f "http.server 8899"
rm -rf /tmp/cdp-profile
```

## Where this bit us

**The two coverage results were nearly published as findings.** "78% of the JS unused" is a plausible
number for a page written to be mostly dead, and "0% unused CSS" was small enough to read as a rounding
artefact rather than a broken measurement. What caught both was that the page's contents were known in
advance: three functions and three rules were *written to be unused*, so a tool reporting zero had to
be wrong. **A coverage tool pointed at unfamiliar code cannot be checked this way**, which is an
argument for pointing it at a file whose answer you already know before trusting it on one you don't.

**Stubbing needed proof the backend was absent, not just that the stub fired.** `Fetch.fulfillRequest`
returning the page text `STUBBED PAYLOAD` shows the interception worked; it does not show the test
would have failed without it. Disabling `Fetch` and re-fetching the same URL for a `404` is what makes
that claim, and it is one extra call.

**One WebSocket means one reader.** Awaiting a promise through `Runtime.evaluate` in a task while
waiting for `Fetch.requestPaused` on the same connection raises
`cannot call recv while another coroutine is already running recv`. The fix was to stop awaiting the
promise and let the single loop handle the pause event — obvious afterwards, and the sort of thing an
automation library hides at the cost of never showing you the socket.

## Follow-ups

- [ ] Compute unused CSS properly by subtracting `ruleUsage` from the rule list in `CSS.getStyleSheetText`, and confirm it reports 3 of 4 rules unused on this page
- [ ] Accumulate `takePreciseCoverage` deltas across a full test run and compare the total against a single take at the end, which is the only version currently trusted
- [ ] Check whether Playwright's `coverage` API has the same delta and unused-rule behaviour underneath, since it wraps these exact calls
- [ ] Re-run the binding test on Linux, where `--remote-debugging-address` may not be ignored the way Chrome 152 ignored it here
- [ ] Measure whether CPU throttling at rate 4 actually resembles a low-end device on a real page, rather than only scaling a busy loop cleanly

## Related

[[valkey-redis-dragonfly-on-kubernetes]] — the control that voided a benchmark there is the control that validated the throttling numbers here.
[[local-rag-retrieval-failure-modes]] — another pair of checks that could not fail, reporting success in the flattering direction.
[[crossplane-cloud-resources-as-crds]] — a status field standing in for the property it claims to verify.
[[vault-secrets-rotation]] — the other page about a secret that is protected in one direction and readable in another.
