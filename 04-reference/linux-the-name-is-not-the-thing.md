---
title: Six things Linux does that look like bugs — the name is never the thing
date: 2026-09-10
domain: reference
tags: [linux, filesystem, namespaces, kernel]
summary: A file keeps being readable after chmod 000, 300 MB stays used after rm with nothing on disk to show for it, a file survives having its name deleted, /proc reports zero bytes and returns 1306, and one command turns a normal process into PID 1 running as root. All six are the same principle seen from different sides, and each is a production incident when it is not recognised.
source: handson
env: Fedora CoreOS 43.20251110.3.1 · Linux 6.17.7-300.fc43 aarch64 · unprivileged user (uid 501) inside the Podman machine VM on macOS
verified: 2026-09-10
verifiability: lab
duration: 30–45 min
---

Most Linux surprises come from one assumption: that a path *is* a file, that a permission *is* a
property of a file, and that a container *is* a box. **None of those are true**, and the six
demonstrations below are the same fact seen from six directions — the name is a pointer, and Linux is
very consistent about not confusing the two.

Every command runs as an ordinary user. That matters more than it sounds: **root bypasses the first
demonstration entirely**, so a page like this written from a root shell would show nothing.

```bash
whoami; id -u
```

```
  core
  501
```

## 1. Permission is decided once, at `open()`

```bash
echo "the secret line" > p.txt
exec 3< p.txt          # open() happens here, while the mode is still 644
chmod 000 p.txt
cat p.txt              # a new open
head -1 <&3            # the descriptor from before
```

```
  before chmod: -rw-r--r--
  after  chmod: ----------
  new open   : cat: p.txt: Permission denied
  held fd    : the secret line
```

**The mode is checked when the descriptor is created and never again.** A file descriptor is a
capability: once handed out, it keeps working until it is closed, whatever happens to the path it came
from.

This is why revoking access to a file does not stop a process already reading it, and why "we chmod'd
it, we're fine" is not an incident response. **Restarting the reader is the action; changing the mode
is only the prevention.**

## 2. `rm` removes a name. The data leaves when the last descriptor closes

```bash
dd if=/dev/zero of=big.bin bs=1M count=300
exec 4< big.bin        # someone is holding it open
rm big.bin
```

```
  empty directory   df used=35040644 KB   du=0 KB        ls=0
  300MB file        df used=35347788 KB   du=307200 KB   ls=1
  after rm (fd held) df used=35347788 KB  du=0 KB        ls=0
  after closing fd   df used=35040588 KB  du=0 KB        ls=0
```

**`df` and `du` disagree by 300 MB and both are correct.** `du` walks names and there is no name left;
`df` asks the filesystem, which is still holding the blocks because a descriptor still refers to the
inode.

This is the "disk is full and there is nothing in it" incident, and it has a single diagnostic:

```bash
lsof -n | grep deleted
```

```
  d2.sh 1814443 4r (deleted)
```

**A log file rotated with `rm` instead of truncation does exactly this** — the writer keeps its
descriptor, the space never comes back, and the directory looks clean the whole time. `df` recovers the
moment the process closes the file or exits, which is why "restarting the service fixed the disk" is a
real and repeatedly rediscovered phenomenon.

## 3. A file has no name. A directory has names

```bash
echo content > a.txt
ln a.txt b.txt
stat -c '%n inode=%i links=%h' a.txt b.txt
rm a.txt
```

```
  a.txt  inode=14233519  links=2
  b.txt  inode=14233519  links=2

  b.txt  inode=14233519  links=1
  b.txt content: content
```

**One inode, two names, and `rm` decremented a counter.** The file is the inode; a directory is a table
mapping names to inode numbers. `rm` is `unlink()` — it removes an entry from that table — and the
inode is freed only when the link count and the open-descriptor count both reach zero.

Sections 1 to 3 are the same sentence: **the path is not the file.** Section 2 is what happens when the
link count hits zero with a descriptor still open, which is why the two demonstrations feel like one
trick told twice.

## 4. `/proc` is not stored anywhere. It is generated when you read it

```bash
ls -l /proc/self/status      # size
cat /proc/self/status | wc -c
```

```
  ls reports:  0 bytes
  reading it:  1306 bytes
```

```
  read 1: Pid: 1814659   VmRSS: 1904 kB
  read 2: Pid: 1814662   VmRSS: 1908 kB
```

```
  filesystem for /proc: proc (source=proc)
```

**Zero bytes and 1306 bytes are both honest answers.** There is no file; `ls` asks for a size that does
not exist and gets 0, and `cat` triggers the kernel to produce the content on the spot.

The two reads returning different PIDs is not a race — it is the mechanism. **`/proc/self` resolves to
whoever is asking**, and each `grep` in that pipeline is a different process, so it correctly reports
itself. A monitoring script that reads `/proc/self/…` and reports "the process" is reporting the
script.

The consequence worth carrying: `ls -l` on `/proc` and `/sys` tells you nothing about content, and any
tool that skips zero-byte files skips all of it.

## 5. A container is a view, not a box

No container runtime is involved here. One command:

```bash
unshare --user --map-root-user --pid --fork --mount-proc sh
```

```
  outside   PID=1814723   user ns=4026531837   pid ns=4026531836   165 processes
  inside    PID=1         user ns=4026532519   pid ns=4026532688     4 processes   id 0:0 (root)

  kernel outside: 6.17.7-300.fc43.aarch64
  kernel inside : 6.17.7-300.fc43.aarch64
```

**Same kernel, same machine, same binary — a different set of numbers to look at.** The process became
PID 1 because it is now in a PID namespace where numbering restarts, and it sees four processes because
`--mount-proc` gave it a `/proc` that only enumerates that namespace.

A container image supplies the files; the namespaces supply the view. Everything a container runtime
adds on top of this — images, layers, networking, lifecycle — is arrangement around these two ideas.

## 6. "root" inside is a mapping, not a promotion

The most dangerous way to read section 5 is that `unshare` made an ordinary user root. Look at the same
process from outside:

```bash
grep -E '^(Uid|Gid):' /proc/$PID/status
cat /proc/$PID/uid_map
```

```
  inside : uid=0  pid=1
  outside: Uid:  501  501  501  501
           ps user = core
  uid_map: 0 501 1
```

**`0 501 1` is the whole mechanism in three numbers**: uid 0 inside corresponds to uid 501 outside, for
a range of one. The process is `core` to the kernel's access checks against the host filesystem, and
root only to checks made inside its own user namespace.

This is why an unprivileged user namespace is safe to hand out and why "the container runs as root" is
an incomplete sentence — the question is always *which namespace's root*, and `uid_map` answers it.

## Verification checklist

- [x] The demonstrations run as **uid 501**, so the permission check in section 1 is real rather than bypassed
- [x] A descriptor opened before `chmod 000` still reads `the secret line` while a new `cat` gets `Permission denied`
- [x] After `rm` of a 300 MB file with a descriptor held, `df` used is **unchanged at 35347788 KB** while `du` reports **0**
- [x] `lsof -n | grep deleted` names the holder — `4r (deleted)`
- [x] Closing the descriptor returns `df` to **35040588 KB**, below the pre-test figure
- [x] Two hard links share **inode 14233519** with `links=2`, and `rm` of one leaves `links=1` with the content intact
- [x] `ls -l /proc/self/status` reports **0 bytes** while reading it returns **1306**
- [x] Two consecutive reads of `/proc/self/status` report **different PIDs** (1814659, 1814662)
- [x] `unshare` puts the process at **PID 1 with 4 visible processes** against **1814723 and 165** outside, on an identical kernel string
- [x] The same process is **uid 0 inside and 501 outside**, with `uid_map` reading `0 501 1`

## Where this bit us

**The first version of section 1 was written from a root shell and proved nothing.** `chmod 000`
followed by a successful `cat` looks like the same result whether the descriptor is doing the work or
root is ignoring the mode. The fix was to print `id -u` before anything else — and the general form is
that a permission demonstration has to establish it is not running as the user who is exempt from
permissions.

**`df` reporting less free space than before the test is the alarming-but-correct output here.** The
final figure, 35040588, is *lower* than the starting 35040644 — the filesystem released the 300 MB and
also freed a little more, because other things on the machine moved during the run. A reader watching
for the number to return exactly is watching for something that will not happen.

**Every one of these looks like a bug the first time.** A file that ignores `chmod`, a disk that stays
full after `rm`, a zero-byte file with content in it, a process that is both root and not. Recognising
them is what separates thirty seconds of diagnosis from an afternoon, and the recognition is one
sentence: **the name is not the thing.**

## Follow-ups

- [ ] Add the memory equivalent — `VmRSS` against `VmSize`, and a `malloc` that succeeds without any page being backed, since overcommit is the same "the name is not the thing" shape applied to address space
- [ ] Demonstrate the truncate-versus-`rm` fix for section 2 by rotating a log both ways and watching `df`, which is the action item that section only describes
- [ ] Repeat section 5 with a network namespace, where the same process gets a different `ip addr` and the isolation is easier to see than a PID renumbering
- [ ] Check whether `unshare --user` is permitted on the distributions this repository actually deploys to, since some ship `kernel.unprivileged_userns_clone=0` and the whole section becomes root-only there

## Related

[[cka-workloads-scheduling-drills]] — the container abstractions these six mechanisms sit underneath.
[[container-image-size-and-what-breaks]] — the image half of a container, where namespaces are the other half.
[[talos-kubernetes-local-cluster]] — a Linux with the shell removed, where `/proc` is most of what is left to read.
[[pod-crashloopbackoff]] — where "the disk is full and there is nothing in it" arrives wearing a Kubernetes error message.
