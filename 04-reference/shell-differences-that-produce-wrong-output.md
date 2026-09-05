---
title: Shell differences that produce a clean wrong answer — bash 3.2, zsh, dash and BSD tools on macOS
date: 2026-09-04
domain: reference
tags: [bash, zsh, shell, portability, macos]
summary: Every difference below was hit while writing other pages in this repository, and each one produced output that looked correct. macOS ships bash 3.2 with no associative arrays, /bin/sh is bash rather than dash, zsh does not word-split unquoted expansions, set -e ignores a failure in a pipeline, and BSD sed and date reject the GNU flags every example on the internet uses.
source: handson
env: macOS 26.6.2 (arm64) · GNU bash 3.2.57(1) · zsh 5.9 · dash · BSD sed/awk/date · login shell zsh
verified: 2026-09-04
verifiability: partial
verifiability-note: One macOS machine, so the BSD-versus-GNU half is about this platform and a Linux box would invert most of it — which is the point, but it means the specific error strings are macOS's. bash 5, ksh, busybox ash and Windows shells are untested; the zsh results are for a default 5.9 with no options changed.
duration: 30–45 min
risk: low
---

Every item here cost real time on another page in this repository, and none of them announced itself.
**A shell that produces an error is not the problem; a shell that produces a clean, plausible, wrong
answer is**, and that is what all of these do.

## The interpreter is not the one you think

```bash
/bin/sh -c 'echo "${BASH_VERSION:-none}"; set -o | grep posix'
```

```
  3.2.57(1)-release
  posix   on
```

**On macOS `/bin/sh` is bash in POSIX mode, not dash.** A script that runs under `/bin/sh` here can
still use bashisms and appear portable; the same file on a Debian-family Linux, where `/bin/sh` is
dash, fails. Testing "POSIX compliance" on a Mac tests nothing of the kind.

And the bash itself is old:

```bash
bash -c 'declare -A m'
bash -c 'x=ABC; echo "${x,,}"'
bash -c 'mapfile -t a < /etc/hosts'
bash -c 'shopt -s globstar'
```

```
  declare: -A: invalid option
  ${x,,}: bad substitution
  mapfile: command not found
  shopt: globstar: invalid shell option name
```

**bash 3.2.57 predates every bash 4 feature**, because Apple stopped shipping bash at the last GPLv2
release. Associative arrays, case conversion, `mapfile`/`readarray` and `**` are all absent. Scripts
written against modern bash fail here with four different messages, none of which says "your bash is
too old".

## zsh does not split unquoted expansions, and it is the login shell

```bash
for sh in bash zsh dash; do $sh -c 'v="a b c"; set -- $v; echo $#'; done
```

```
  bash   3
  zsh    1
  dash   3
```

**This one bit twice while writing [[cka-practice-cluster-and-checks-that-lie]].** A loop building a
command in a variable —

```bash
q="get pods -n dev"
kubectl auth can-i $q --as=$SA        # bash: three words. zsh: one.
```

— gave `error: you must specify two arguments`, and the error was invisible because stderr was
redirected away. The same shape appeared again with `E="podman exec node crictl exec $CTR"` followed
by `$E ...`, which zsh tried to run as a single command name.

**The fix is not `${=q}`.** Build commands as shell functions or arrays; a command held in a string is
a portability bug in any shell, and zsh only makes it visible sooner.

## `${@:2}` is bash, and `/bin/sh` on Linux is not bash

```bash
bash -c 'f(){ echo "[${@:2}]"; }; f a b c'
dash -c 'f(){ echo "[${@:2}]"; }; f a b c'
```

```
  bash : [b c]
  dash : Bad substitution
```

Hit inside a container in [[cka-workloads-scheduling-drills]], where the image's `/bin/sh` was dash.
The function returned empty for every call and the test table filled with blanks rather than errors.
**Use `shift` instead**, which works in every shell.

## `set -e` does not mean "stop on error"

```bash
bash -e -c 'false | true; echo "still here ($?)"'
bash -e -c 'f(){ false; echo "still here"; }; if f; then :; fi'
bash -e -c 'x=$(false); echo "not reached"'
```

```
  still here (0)
  still here
  (no output — exit code 1)
```

**Three cases, two of which continue.** A failure anywhere but the end of a pipeline is invisible;
a failure inside a function used as an `if` condition is deliberately ignored, and so is everything
that function does after the failing line. The third case does exit, which makes the rule harder to
remember rather than easier.

The pipeline exit code is the last command's:

```bash
bash -c 'false | true; echo $?'
bash -c 'set -o pipefail; false | true; echo $?'
```

```
  0
  1
```

**`curl ... | jq ...` reports success when curl fails.** `set -euo pipefail` is the usual answer and
it still does not cover the `if` case above.

## Unquoted is not "the same, shorter"

```bash
f="a file.txt"; set -- $f;  echo $#      # 2
v="*";         set -- $v;  echo $#      # 18
```

**The second one read the directory.** An unquoted expansion is split *and* glob-expanded, so a
variable holding `*` becomes every filename in the working directory — a count that changes with the
directory it runs in.

## The tools are BSD, and every example online is GNU

```bash
sed -i 's/hello/world/' file        # GNU form
sed -i '' 's/hello/world/' file     # BSD form
date -d '2026-01-01'
date -v-1d '+%Y-%m-%d'
```

```
  sed: 2: "/tmp/bsd.txt          <- GNU form, BSD sed reads the filename as the script
  world                          <- BSD form
  date: illegal option -- d
  2026-09-03
```

**`sed -i` without an argument silently treats the next word as the backup suffix**, so the GNU form
consumes the expression and then complains about the filename — an error that points at the wrong
thing. `date` rejects `-d` outright, which is at least honest.

`timeout` does not exist here at all, which produced a false finding in
[[cka-practice-cluster-and-checks-that-lie]]: `timeout 25 kubectl exec …` failed as
`command not found`, the `&&` never fired, and the test printed `exec failed` — for a pod that was
perfectly healthy. **It fitted the hypothesis, which is why it nearly shipped.**

## `read` eats backslashes

```bash
printf 'C:\\Users\\name\n' > f
while read    l; do echo "$l"; done < f
while read -r l; do echo "$l"; done < f
```

```
  C:Usersname
  C:\Users\name
```

**Always `read -r`.** There is no case where the backslash-mangling behaviour is what you wanted.

## Verification checklist

- [x] `/bin/sh` on macOS reports `BASH_VERSION=3.2.57(1)` with `posix on` — it is bash, not dash
- [x] `declare -A`, `${x,,}`, `mapfile` and `globstar` all fail on the system bash, with four different messages
- [x] The same unquoted expansion yields **3 words in bash and dash, 1 in zsh**
- [x] `${@:2}` works in bash and is `Bad substitution` in dash
- [x] `set -e` does **not** stop on a failure mid-pipeline or inside a function used as an `if` condition, and **does** stop on `x=$(false)`
- [x] `false | true` exits 0, and 1 only with `pipefail`
- [x] An unquoted `v="*"` expanded to **18 arguments** — the file count of the working directory
- [x] GNU `sed -i 's/…/'` fails on BSD sed by consuming the expression as a backup suffix
- [x] `date -d` is `illegal option`; `date -v-1d` is the BSD equivalent
- [x] `timeout` is not installed on macOS
- [x] `read` turns `C:\Users\name` into `C:Usersname`; `read -r` does not

## Where this bit us

**Every one of these produced a table, not an error.** The `IFS='|'` left set in a loop made
`kubectl auth can-i` receive `get pods -n dev` as a single argument, and the resulting page of
`ERR unknown command 'SET'` looked like three broken database engines rather than one broken test
harness. The `\r` in `redis-benchmark -q` output glued progress lines onto the summary so that
`grep '^SET'` matched nothing, and 36 benchmark samples came back `NA` — a clean, empty, plausible
table.

**The habit that catches all of them costs two commands.** Before trusting any harness, run it
against one input whose answer you know is good and one whose answer you know is bad:

```bash
echo "GET k    -> [$(probe redis GET k)]"        # expect: hello
echo "NOSUCH   -> [$(probe redis NOSUCHCMD)]"    # expect: ERR unknown command
```

A harness that fails on the known-good input is broken, and one that passes on the known-bad input is
broken differently. **Neither is visible from reading the output of the real run**, which always looks
like data.

## Follow-ups

- [ ] Run the same checks on a Linux box to record which half inverts, since every BSD result above has a GNU counterpart this page cannot see
- [ ] Test `shellcheck` against the seven failures here and record which it catches — if it catches most, the recommendation is one line rather than this page
- [ ] Add the busybox `ash` column, which is what a container's `/bin/sh` usually is and is neither bash nor dash
- [ ] Check whether `bash` from Homebrew (5.x) is on `PATH` ahead of `/bin/bash` on this machine, because a script that works interactively and fails in `#!/bin/bash` is the same problem again

## Related

[[cka-practice-cluster-and-checks-that-lie]] — where the zsh splitting and the missing `timeout` cost real time.
[[cka-workloads-scheduling-drills]] — the dash `${@:2}` failure, inside a container image.
[[valkey-redis-dragonfly-on-kubernetes]] — the `IFS` and `\r` failures, both of which produced complete wrong tables.
[[powershell-objects-and-the-checks-that-lie]] — the same class of problem in a shell that passes objects instead of text.
