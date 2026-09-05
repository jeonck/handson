---
title: PowerShell on an Apple Silicon Mac — no arm64 container, and four comparisons that return the wrong kind of thing
date: 2026-09-04
domain: install
tags: [powershell, shell, portability, macos]
stack: [powershell, macos, podman]
summary: The official PowerShell container images publish linux/amd64 and linux/arm/v7 and no arm64, so this runs from the macOS tarball instead. Once running, -eq against an array returns a filtered collection rather than a boolean, a function returning one item returns a string instead of an array, $x -eq $null returns an empty collection, and a swallowed method return value became half the output of a function.
source: handson
env: PowerShell 7.6.5 (osx-arm64 tarball) · macOS 26.6.2 arm64 · Podman 5.7.1 for the image check
verified: 2026-09-04
verifiability: partial
verifiability-note: PowerShell 7.6.5 on macOS only. Windows PowerShell 5.1 differs in several of these areas — notably default encodings and error behaviour — and none of that is testable here. The container-manifest result is a point-in-time observation of the published tags, not a statement about what Microsoft supports.
duration: 45–60 min
risk: low
---

> **Verified 2026-09-04.** Every value below is the actual output of the script shown above it.

PowerShell passes objects down the pipeline instead of text, which removes the parsing that half of
[[shell-differences-that-produce-wrong-output]] is about. **It replaces it with a different question:
what type did that expression actually return?** — and the four cases below all answer it in a way
that reads as working code.

## 1. Getting it running on Apple Silicon

The container route does not work:

```bash
podman manifest inspect mcr.microsoft.com/powershell:lts
```

```
  linux    amd64
  linux    arm     v7
  windows  amd64
```

```
  Error: no image found in manifest list for architecture "arm64", variant "v8", OS "linux"
```

**There is a 32-bit ARM image and no arm64 one.** Forcing `--arch arm64` fails the same way; the
image does not exist to select. This is the same wall as
[[harbor-installer-on-podman-arm64]], reached from a different direction.

The macOS build is published directly, so install it the way the Pulumi CLI was in
[[pulumi-kubernetes-outputs-and-drift]] — into a directory you can delete:

```bash
V=$(curl -s https://api.github.com/repos/PowerShell/PowerShell/releases/latest \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["tag_name"].lstrip("v"))')
curl -fsSL -o pwsh.tar.gz \
  "https://github.com/PowerShell/PowerShell/releases/download/v${V}/powershell-${V}-osx-arm64.tar.gz"
mkdir -p bin && tar -xzf pwsh.tar.gz -C bin && chmod +x bin/pwsh
./bin/pwsh -NoLogo -Command '$PSVersionTable.PSVersion.ToString(); $PSVersionTable.OS'
```

```
  7.6.5
  macOS 26.6.2
```

**Write the tests as `.ps1` files and run them with `-File`.** Passing PowerShell through
`-Command` from bash means two sets of quoting rules over the same string, and the first attempt at
this page produced empty output for exactly that reason.

## 2. `-eq` against an array is a filter, not a test

```powershell
$a = @("dev","prod","test")
($a -eq "prod").GetType().Name
if ($a -eq "prod") { "true" } else { "false" }
```

```
  Object[]
  true
```

**The comparison returned a collection of matches.** `if` then applied its own truthiness rule —
non-empty is true — and the answer happened to be right. Now put a falsy value in the array:

```powershell
$b = @("", "0")
if ($b -eq "") { "true" } else { "false" }
```

```
  false
```

**`""` is in the array and the test says false.** The filter matched, returned `@("")`, and a
one-element collection holding an empty string is falsy. **A membership test written with `-eq` is
correct exactly when the thing you are looking for is not falsy**, which is why it survives review and
fails on the empty string, `0`, and `$false`.

Use `-contains`, or `-in`, which return actual booleans.

## 3. One result is not a one-element array

```powershell
function Get-One { @("only") }
function Get-Two { @("a","b") }

(Get-One).GetType().Name      # String
(Get-Two).GetType().Name      # Object[]

$r = Get-One
$r[0]                         # 'o'
@(Get-One)[0]                 # 'only'
```

```
  Get-One : Count 1, type String
  Get-Two : Count 2, type Object[]
  $r[0]   : 'o'      <- first character
  @()[0]  : 'only'
```

**The single-element array was unwrapped on the way out, so indexing it indexes a string.** The code
is correct for every input that returns two or more items and silently wrong for the one-item case —
which is usually the case that shows up in production, on the day one server matches the filter
instead of three.

**Wrap calls in `@()` when you are going to index or count them.** `.Count` alone will not warn you:
it returns 1 for the string as well.

## 4. `$null` belongs on the left, and the reason is not style

```powershell
$x = @(1,2)
@($x -eq $null).Count          # 0
if ($x -eq $null)  { … }       # false
if ($null -eq $x)  { … }       # false
```

```
  count of ($x -eq $null) : 0
```

`$x -eq $null` filtered the array for null elements and found none, so it returned an **empty
collection**. It is falsy, so the `if` behaves — but the value is not `$false`, and anything that
consumes it as one breaks:

```
  "…{0}" -f ($x -eq $null)
  InvalidOperation: Error formatting a string: Index (zero based) must be greater than or
  equal to zero and less than the size of the argument list.
```

**That error was the first sign of the problem on this page**, and it only appeared because the value
reached a format string. In an `if` it would have stayed hidden.

`$null -eq $x` returns a real Boolean, which is the whole reason for the ordering convention.

## 5. A function returns everything nobody caught

```powershell
function Add-Thing {
    $list = New-Object System.Collections.ArrayList
    $list.Add("item")          # ArrayList.Add returns the new index
    return "done"
}
$r = Add-Thing
@($r).Count
@($r) -join " | "
```

```
  2
  0 | done
```

**`$r` is `@(0, "done")`.** `ArrayList.Add` returns the index it inserted at, that value was not
assigned to anything, and in PowerShell an uncaptured expression *is* output. The `return` keyword
does not restrict what the function emits — it only ends it.

Silence the method call with `[void]$list.Add("item")` or `$null = $list.Add("item")`. **The check is
`@($result).Count`**, because a function that returns one extra value still looks like it worked.

## 6. `$?` describes exactly one statement

```powershell
& /bin/sh -c "exit 3"
$immediately = $?          # capture on the very next line
$code = $LASTEXITCODE
```

```
  $? read immediately : False
  $LASTEXITCODE       : 3
  $? read after a print : True    <- describes the print
```

**`$?` is about the statement immediately before it and nothing else.** Print anything between the
command and the check — including the line that reports `$LASTEXITCODE` — and you are reading the
status of the print. Capture it on the next line, use `$LASTEXITCODE` for native commands, and
`$Error` for cmdlets:

```powershell
Get-Item /no/such/path -ErrorAction SilentlyContinue | Out-Null
$?                  # False
$Error.Count        # 1
```

**A non-terminating error does not stop the script**, so a run that ends successfully can still have
failed. `$Error.Count` is the check that notices.

## Verification checklist

- [x] `mcr.microsoft.com/powershell:lts` publishes **linux/amd64, linux/arm/v7 and windows/amd64** — no linux/arm64
- [x] The osx-arm64 tarball runs directly: `7.6.5` on `macOS 26.6.2`
- [x] `($a -eq "prod").GetType().Name` is **`Object[]`**, not `Boolean`
- [x] `if ($b -eq "")` returns **false** on an array that contains `""`
- [x] A function returning one element yields type **String**; `$r[0]` is `'o'` and `@(...)[0]` is `'only'`
- [x] `$x -eq $null` on a non-null array returns a collection of **count 0**, which breaks `-f` while passing an `if`
- [x] `$null -eq $x` returns a Boolean
- [x] An uncaptured `ArrayList.Add` makes a function return **2 values, `0 | done`**
- [x] `$?` is `False` when read on the next line after a failing native command and `True` when read after an intervening print
- [x] `$LASTEXITCODE` is `3` and survives the intervening statement
- [x] A cmdlet failing with `-ErrorAction SilentlyContinue` leaves `$Error.Count` at 1 while the script continues

## Rollback

```bash
rm -rf ./bin ./pwsh.tar.gz        # the whole install
```

Nothing was written outside that directory, and no profile was modified.

## Where this bit us

**The first three attempts at these tests produced no output at all**, because PowerShell was being
invoked through `pwsh -Command` from bash and the two quoting systems fought over the same string —
backticks, `$`, nested quotes. Writing `.ps1` files and running them with `-File` fixed every case at
once. **A one-liner that spans two languages is two chances to be wrong**, and the failure mode is
empty output rather than a syntax error.

**One of the traps announced itself only by accident.** `$x -eq $null` returning an empty collection
was invisible until the value reached `-f`, which needs a positional argument and complained. Had the
same expression only ever been used in an `if`, the page would have recorded the wrong reason for the
right behaviour. **Feeding a suspicious value into something that is strict about types is a cheap way
to find out what it really is** — `.GetType().Name` on every intermediate value, once, is faster than
reasoning about it.

**Four of the five language traps here share a shape**: an expression returns a *collection* where the
reader expected a scalar, or a *scalar* where they expected a collection. PowerShell's flattening is
consistent and it is not what the surrounding code assumes. `@()` around anything you will count or
index, and `-contains` instead of `-eq`, remove most of it.

## Follow-ups

- [ ] Run the same five tests under Windows PowerShell 5.1, where the flattening rules are the same but the error handling and default encodings are not
- [ ] Check whether `Set-StrictMode -Version Latest` catches any of these, which would make the recommendation one line instead of five
- [ ] Measure the encoding of `>` and `Out-File` on this build against 5.1, the difference that historically breaks cross-platform scripts
- [ ] Retry the container route when a linux/arm64 tag appears, since the tarball is a workaround rather than an answer

## Related

[[shell-differences-that-produce-wrong-output]] — the same class of failure in text-passing shells, and the known-good/known-bad habit that catches both.
[[harbor-installer-on-podman-arm64]] — the other page that stopped at a missing arm64 image.
[[pulumi-kubernetes-outputs-and-drift]] — another CLI installed from a tarball into a directory you can delete, and another value that stringified into something it was not.
