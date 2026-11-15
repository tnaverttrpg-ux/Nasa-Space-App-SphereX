# AI-use disclosure

The SPHERE TRACK team used AI assistants during development. This document records which tools were used, what they were used for, and what remained the team's own work. Items in *[brackets]* must be completed or confirmed by the team.

## Tools used

| Tool | Provider | Used for |
|---|---|---|
| **Claude Code** | Anthropic | Implementation assistance: writing and modifying code in this repository, debugging, refactoring, writing and running automated tests, investigating data issues, preparing git commits on request, and drafting documentation (including this document). |
| **ChatGPT** | OpenAI | Technical planning, architecture discussions, troubleshooting, scientific explanations, UI/UX recommendations and general development guidance. |

*[Team to confirm: model versions, if known, and whether any other AI tools (for example code completion in an editor, or image generation) were used. If any were used, add them to the table above.]*

## How AI assistance was used

- **Code:** a large share of the application code and the test suites was generated or modified by Claude Code, working from detailed written instructions from the team.
  - Each feature was specified by the team: Pipeline QA inspector, histogram, dashboard, synchronised zoom, pixel inspector, sky coverage map, and others.
  - Each specification stated its scientific constraints, for example: never fabricate data, keep pipeline QA separate from per-pixel flags, do not describe values as calibrated photometry, and label synthetic data.
- **Testing:** Claude Code wrote backend tests (pytest) and browser test suites (Playwright-core). The browser suites check results against independently computed values, and Claude Code ran them and reported results to the team.
- **Investigation:** Claude Code helped investigate specific data questions, such as the cause of unobserved regions near the detector edge and how the pipeline's detector-coordinate WCS should be applied. It reported its findings to the team for review.
- **Documentation:** the README and the documents in `docs/` were drafted by Claude Code from the actual code and test results, for the team to review and complete.
- **Commits:** some commits in the git history carry a `Co-Authored-By: Claude` trailer, indicating commits prepared by Claude Code at the team's request.
- **Planning and guidance:** ChatGPT was used for planning and discussion outside the repository; its output entered the project through the team's own decisions and instructions.

## What is the team's own work

| Area | Team responsibility |
|---|---|
| **Core idea** | The concept of a browser tool that turns SPHEREx archive data into an aligned time sequence for any sky position. |
| **Problem selection** | Choosing the "Planet X and SPHEREx" challenge and framing the problem: making SPHEREx's repeated observations explorable by non-specialists. |
| **Scientific decisions** | What may and may not be claimed (exploration tool, not a discovery system; no Planet X claims). What must be kept separate (measured vs derived values; pipeline QA vs per-pixel flags; whole-detector footprints vs displayed field). How limitations are communicated. |
| **Research and validation** | Reviewing the SPHEREx data products and archive services, choosing the targets, and checking results in the running application. *[Team to describe specific checks performed by members.]* |
| **Product direction** | Feature selection and priorities, the order of work, visual design direction (themes, layout) and acceptance of each change. |
| **Final review** | Reviewing, testing and approving the code, documentation and submission. *[Team to confirm who performed the final review.]* |

## Individual contributions

*[To be completed by the team. Do not leave this section empty in the final submission.]*

| Member | Responsibilities and contributions |
|---|---|
| Kiaan Samir | *[…]* |
| Revant Ghimiray | *[…]* |
| Abhinav Kumar Singh | *[…]* |
| Arya Agarwala | *[…]* |

## Accuracy statement

AI-generated code and text can contain errors. The team's safeguards were:

- explicit scientific constraints in every instruction;
- automated tests that compare results with independently computed values;
- review of results in the running application.

The documented limitations ([SCIENTIFIC_LIMITATIONS.md](SCIENTIFIC_LIMITATIONS.md)) apply regardless of how the code was written.
