# Chat scroll-back prefetch: the design

**This is Skip's design, in his words, captured as he gave it on 2026-08-12 from 17:22
EDT.** It is written down because he specified it once before, nobody could find it, and
an agent then offered him a menu of alternatives instead — which is how a design that
already exists gets re-litigated.

His words are quoted exactly. Anything not in a quote is an agent's reading and is marked
as such.

## The unit is height, not events

> the ideal unit for, like, scroll back prefetch. Right? Like, for, like, how, you know, a
> Sentinel like, region between sentinels or whatever. Like, the ideal thing to do is to,
> like, have **a certain height of chat prefetched**.

> Right? Because **that's the speed at which you move when you scroll.**

So the quantity to hold ahead of the viewport is a **height** — screen-heights of rendered
chat — because that is the unit a person moves in. It is not a count of events, and it is
not a span of time.

**Why the current behaviour is wrong**, for context rather than as part of the spec: a
chat subscription is type-agnostic, so a page is 100 *events*, of which roughly 93 are
activity. One pull-up therefore buys about eleven minutes of a busy conversation, and a
716-minute gap took roughly 55 consecutive pull-ups. The budget is denominated in the
wrong unit entirely.

## The obstacle

> The issue, right, is, like, **you don't know how tall shit is until you fucking render
> it.**

The count of events that produces a given height cannot be computed in advance. It can
only be discovered by rendering and measuring. This is what makes it a search rather than
a calculation, and it is why he remembered the design as involving **binary search**.

## The rule: price-is-right, flipped

> So the idea is to think of, like, the prefetch height, right, as, like, **that is a
> target. That it's fine to exceed it. It's not fine to go under.** Like, **price is right
> rules. Flipped.**

The target height is a **floor, not a goal**. Overshooting costs bytes and render time.
Undershooting means the user reaches the end of the buffer while still scrolling — which
is the failure they actually experience.

**Agent's reading, offered to him and not corrected at the time of writing:** this makes
the search one-sided. You cannot stop at "close enough." You keep fetching until you are
over the target, and only then is trimming worth considering; no candidate below the floor
is acceptable. A page that comes back short is not a cheap answer, it is a wrong one.

## The algorithm: guess, render, measure, double

> So basically, the idea is you, like, **start with a guess**. And, like, I don't know. Do
> this guess, like, however you fucking wanna do it. Right? Like, you could do it based on
> like, we could be smart about it. **We could try to have some kind of, like, actual
> regression that, like, predicts rendered height**, probably we could do pretty good,
> honestly.

> But, also, **just, like, who cares?** Right? Like, just like, **do fucking something and
> then, you know, like, do binary search, you know, do doubling until you have enough
> events to get enough height.**

**The starting guess is unimportant by construction.** That is the point of choosing
doubling: it converges from anywhere, so no accuracy is required up front. Fetch
something, render it, measure the height, double until the target is cleared.

**The height-predicting regression is an optimisation, not a prerequisite.** It saves
round trips on the first attempt and nothing should wait on it. Build the doubling first.

**Agent's note on the regression, if and when it is built** — offered in conversation and
not yet ruled on: the training data is free, since every render already measures every
row's height. And the loss is asymmetric, so a mean fit is the wrong object. Under-
predicting a row's height causes over-fetching, which is the cheap direction; over-
predicting causes a short page, which is the direction that is not allowed. A low quantile
of height-per-event is conservative by construction rather than by adding a fudge factor.
A predictor biased low is more useful than a predictor that is accurate on average.

---

*This document is incomplete — it captures the design as far as he had given it at the
time of writing. Do not treat the absence of a detail here as a decision that the detail
does not matter. Anyone continuing it should append his words, not summarise them.*
