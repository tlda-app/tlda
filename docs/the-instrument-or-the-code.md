# Validate the instrument before diagnosing the code

A diagnostic result is a claim about both the system and the instrument used to
measure it. An empty query, timeout, failed test, or clean count is evidence only
after the instrument has demonstrated that it can distinguish the relevant
states.

## Standing rule

Before reporting an absence, hang, failure, or clean bill of health, state what
the instrument should show when the system is healthy and confirm that it can
show that result. Then exercise the failure case and confirm that the result
changes.

## Common failure modes

### A timeout measures the machine

A bound chosen on an idle machine may fail under ordinary load. Time several
successful runs and compare their spread with the timeout. If normal runs come
close to the bound, widen the bound before changing the assertion or diagnosing
the product.

### The reading belongs to the wrong subject

A process, log, file, checkout, or deployment can be real and still be the wrong
one. Establish the active process, current modification time, repository ref,
deployed commit, and production caller before drawing a conclusion from it.

### The query cannot produce the expected result

Run a positive control against data known to exist. For counts, enumerate the
actual field names, categories, and input population before trusting the total.
A precise zero is not useful when the query has already excluded the rows that
could make it nonzero.

### The control cannot fail

Describe the result that would make the control red before running it. A merge
check against an ancestor, a search for text that is not in the target, or a
stubbed call that bypasses the behavior under test cannot validate the
instrument.

### The harness fails after the assertion passes

Read the failing assertion rather than relying on the process exit code alone.
Cleanup races, occupied ports, temporary-directory errors, and leaked child
processes are harness defects unless they invalidate the subject assertion.

### The metric cannot see the blocking mechanism

CPU usage cannot identify synchronous I/O or a blocked event loop. Process
arguments and uptime describe launch history, not current activity. Use a stack
sample, current request trace, or another measurement that observes the state in
question.

### A test name overstates its population

A test that iterates a directory, registry, or glob proves a property only for
the members it found. Print or assert the enumerated set so a missing deployment,
format, or implementation cannot pass silently.

### Two instruments share one blind spot

Agreement is independent evidence only when the instruments can disagree. Two
queries over the same store or two source inspections of the same checkout
confirm consistency, not reality. Cross the boundary: compare source with the
wire, local git with the server, or diagnostics with the rendered application.

### A monitor rejects designed behavior

A monitor can observe the state correctly and still classify it incorrectly.
Name the state it flags and check whether the system intentionally enters or
retains that state. A last-known-good render remaining available after a failed
build, for example, is availability behavior rather than proof that failure
reporting is broken.

### Reported output changed in transit

Rendering and attachment processing can transform paths or placeholders in
quoted command output. When the exact error text matters, retain a raw log or
test artifact and compare the rendered report with it before reasoning from the
quotation.

## Verification pattern

For each release-critical diagnostic:

1. Name the subject, environment, repository ref, and time window.
2. State the healthy and failing outputs.
3. Run a known-good positive control.
4. Introduce or simulate the target failure and confirm the check goes red.
5. Restore the healthy state and confirm it goes green again.
6. Verify that the input enumeration includes every intended member.
7. Preserve the raw output when rendering could transform it.
8. Corroborate important conclusions with an instrument that crosses a system
   boundary.

The relevant user-visible surface remains authoritative for user-visible
behavior. Tests, logs, database rows, and source inspection explain that surface;
they do not replace it.
