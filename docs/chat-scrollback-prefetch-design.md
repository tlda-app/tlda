# Chat scroll-back prefetch

Chat history is prefetched in rendered height, not in event count or elapsed
time. Height is the unit a person consumes while scrolling, and activity-heavy
pages can contain many events while adding little visible conversation.

## Target

Maintain at least a configured amount of rendered chat above the viewport. The
target is a floor:

- exceeding it costs additional fetch and render work;
- falling below it lets the reader reach an unloaded boundary.

Only the second outcome violates the interaction contract.

## Measurement loop

Rendered height is unknown until content is rendered, so prefetch is an adaptive
search:

1. choose an initial event-count estimate;
2. fetch and render that history;
3. measure the added height;
4. if the height is below the target, double the request and repeat;
5. stop only after the measured buffer meets or exceeds the target.

The initial estimate is an optimization, not a dependency. Doubling must work
from a poor estimate.

## Optional prediction

The client may use observed row heights to predict a better initial request.
Such a predictor should be conservative toward over-fetching: overestimating
height risks returning too little history, while underestimating height merely
fetches extra rows.

Prediction never replaces the render-and-measure loop. The measured height is
the acceptance condition.
