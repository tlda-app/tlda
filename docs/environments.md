# Deployment environments

tlda uses separate environment pairs for application development and course
content development. Each pair has a working surface and a live surface.

| concern | development | live |
| --- | --- | --- |
| application | `testing` | `stable` |
| course content | `pic-dev` | `pic` |

Development work belongs on the corresponding development environment. The live
environments are not build or experimentation targets.

## Application environments

`testing` is the application-development environment. Use it to exercise code
changes and integration behavior before release.

`stable` is the live application environment. Deploy to it only after the exact
candidate has passed the relevant checks.

## Course environments

`pic-dev` isolates disruptive content work such as rendering decks, chapters,
and assignments. It keeps those builds away from both the live course and the
application-development environment.

`pic` is the published course surface.

### Class preview

`pic-preview` is the working preview surface for current class-development
material. Work happens on `pic-dev`; the resulting class artifacts must be
available on `pic-preview` so the class can be reviewed as it will appear.

For a release, identify the exact application image, content snapshot, and
configuration validated on `pic-preview`. Promotion to `pic` reuses those
validated bytes without rebuilding.

| artifact | no-rebuild promotion |
| --- | --- |
| application | Deploy the image digest already validated on `pic-preview`. `TLDA_DEPLOYMENT` selects the deployment configuration baked into that image. |
| course content | Use `scripts/course-release.mjs`: `stage` builds and records an immutable manifest; `deploy` moves native pointers without invoking a build. |

See [Staged course releases](course-release.md) for the content workflow.

`pic-preview` is tailnet-only and uses `tailscale serve`, not Funnel. Its server
configuration therefore leaves token gating off. Do not expose that configuration
through Funnel: doing so would publish an ungated service to the internet.

## Choosing an environment

- Application changes go to `testing` before `stable`.
- Course-content changes go to `pic-dev`, then `pic-preview`, before `pic`.
- Do not render course content on `testing`.
- Do not develop directly on `stable`, `pic-preview`, or `pic`.
