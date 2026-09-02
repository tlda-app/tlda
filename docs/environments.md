# What the four servers are for

Skip, 2026-09-01 22:03 EDT, explaining it because agents kept asking:

> **Pic-dev plays the same role testing does.** Except, like, basically, we're
> acknowledging that **building class shit is so disruptive that it needs its own
> fucking box. It's not part of the fucking class. The fucking class is on
> fucking pic.**

**Two pairs, not four independent boxes.** Each pair is one live surface and one
place to break things.

| | live surface | where you break things |
|---|---|---|
| **the app** | `stable` | `testing` |
| **the class** | `pic` | `pic-dev` |

## The class pair

**`pic` is the class.** Students are on it. It is a live surface with people
depending on it, in the same sense `stable` is.

**`pic-dev` is where class material gets built.** Decks, chapters, homework,
anything that involves rendering and re-rendering course content. It exists
because that work is disruptive enough that it cannot share a box with the app's
own development.

**So "which server" for class work is `pic-dev`, and it is not a judgement call.**
Skip named it directly for the deck work: *"the deck shit should go to fucking
pic dev — that's where we fucking do fucking class dev."*

## The app pair

**`stable` is the live app** and does not go down.

**`testing` is where the app gets developed**, and it is the one Skip uses day to
day. That matters: breaking `testing` costs him his own working surface, which is
why it is not the place to do disruptive class rendering.

## What this settles

**Do not ask which server.** Class content → `pic-dev`. App changes → `testing`.
Neither live surface is a development target.

**And do not treat a dev box as precious.** Skip, in the same conversation:

> I'm telling you, you have **two hours in which you can break whatever the fuck
> you want. Take advantage.**

> why are we being so **prissy** with any of this shit

**That licence is for the dev boxes.** It is not a licence for `pic` or `stable`,
and it was given inside a window rather than as a standing permission — but the
disposition it corrects is real and standing: **a dev server exists to be broken,
and refusing to deploy to one is not caution, it is a stall.**

## The failure this document exists to stop

On 2026-09-01 the deck work sat undeployed while its owner reported design
findings, because nobody had said where it should go. **The answer already
existed and no one had written it down.** Skip's own words on the pattern:

> the shit is stalled out because it's **gate after gate after gate after gate**

> It's not like we don't have fucking four separate servers where we serve this
> shit
