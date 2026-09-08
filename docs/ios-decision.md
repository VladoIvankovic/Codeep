# The iOS app: paused, and what would unpause it

**Status: paused, 8 September 2026.** No code exists — this is a decision not to
start, recorded so it does not get re-argued from scratch every few weeks.

## Why not now

Codeep runs on four surfaces already: terminal, macOS, VS Code and Zed over ACP,
plus the web dashboard. An iOS app is the most expensive thing on the list —
a new platform, a new store, a new review cycle, a new release process, and a UI
that cannot reuse the Mac app's because a phone is not a small desktop.

That cost would be paid on the weakest evidence we have. Nobody has asked for it
in an issue, in Discussions, or anywhere else, because until this week there was
nowhere to ask.

## Why a poll was rejected

The obvious move is to poll: *"would you like an iOS app?"*

That question is free to answer yes to. Nobody spends a minute or a euro on that
vote, and stated preference for a free thing is very close to always yes. A poll
would come back positive, look like evidence, and be worth nothing — the failure
mode is not an unclear result, it is a confidently wrong one.

There is also a size problem. Discussions opened on 8 September with no
participants; a poll now would collect single-digit votes. A decision made on six
votes is a decision made on nothing, dressed as data.

## What is being measured instead

Codeep 3.1.0 shipped the cheap version of an iOS app: **starting a task from
your phone through the Telegram inbox**, with the answer sent back. Anyone who
wants Codeep on a phone can already have most of it.

So the question becomes behavioural: *does anyone actually do this?*

From 3.2.x, every stats event records `fromPhone` — whether the run was started
from a phone rather than at the machine. The clients always knew it; it was
thrown away at the point the event was sent.

```sql
SELECT COUNT(DISTINCT github_id) AS people,
       COUNT(*)                  AS runs
  FROM stats_events
 WHERE from_phone = 1
   AND created_at > NOW() - INTERVAL 30 DAY;
```

Read against the denominator — everyone who ran anything in the same window.
Distinct people, not runs: one enthusiast with a loop is not demand for an app.

## What would unpause it

Any one of these is a real signal; none of them is a survey.

1. **Sustained phone use.** A meaningful share of active users starting runs from
   a phone over a full month, still doing it in the second month.
2. **Specific asks.** People describing what they would do on a phone that they
   cannot do now — in [Discussions](https://github.com/VladoIvankovic/Codeep/discussions).
   "An app would be nice" is not one of these. "I want to approve a dangerous
   command while I am away from my desk, and Telegram is not where my team
   works" is.
3. **A wall the Telegram path hits.** If people use it and keep running into the
   same limit, that limit is the specification for the app — and until it is
   named, there is no specification.

## What would confirm the pause

Phone-started runs staying near zero after a month with the feature shipped,
documented and announced. That is not a failure to measure; it is an answer.

## Related

- [`remote-codeep-design.md`](remote-codeep-design.md) — running a task away from
  the machine that started it. Designed, also parked, and a prerequisite for a
  phone client that does more than send instructions to a Mac that must be awake.
