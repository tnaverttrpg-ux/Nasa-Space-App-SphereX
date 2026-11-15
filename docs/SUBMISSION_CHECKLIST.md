# Submission checklist: NASA Space Apps Challenge 2026

**Legend:**
- **✅ Done:** completed in this repository (state as of 2026-11-15).
- **🟡 Draft:** content exists but a person must review or complete it.
- **⬜ Human action:** cannot be done from the code; a team member must do it.

## Content

| Item | Status | Where / what remains |
|---|---|---|
| Project description | ✅ Done | [README](../README.md): plain-language opening, problem and solution. |
| Challenge relevance ("Planet X and SPHEREx") | ✅ Done | README, *Challenge context*. ⬜ Check the wording against the official challenge statement. |
| Main features | ✅ Done | README, *Main features*. Lists only features in the code. |
| Scientific methodology | ✅ Done | [docs/SCIENTIFIC_METHODS.md](SCIENTIFIC_METHODS.md) |
| Scientific limitations and validation | ✅ Done | [docs/SCIENTIFIC_LIMITATIONS.md](SCIENTIFIC_LIMITATIONS.md) |
| Data attribution | 🟡 Draft | [docs/DATA_SOURCES.md](DATA_SOURCES.md). ⬜ Confirm the SPHEREx acknowledgement wording against IRSA's published text, and check every link. |
| NASA non-endorsement disclaimer | ✅ Done | README *Disclaimer*, DATA_SOURCES, and the app footer. ⬜ Check whether Space Apps requires its own wording. |
| AI disclosure | 🟡 Draft | [docs/AI_DISCLOSURE.md](AI_DISCLOSURE.md). ⬜ Confirm the tools and versions, and complete the bracketed items. |
| Team members | 🟡 Draft | Names are listed in the README (taken from the previous README). ⬜ Confirm spelling and add any missing members. |
| Team contributions | ⬜ Human action | README *Team* and AI_DISCLOSURE *Individual contributions* are placeholders. Each member writes their own contributions. |

## Links and media

| Item | Status | Where / what remains |
|---|---|---|
| GitHub URL | ⬜ Human action | Two remotes are configured: `origin` = https://github.com/tnaverttrpg-ux/Nasa-Space-App-SphereX and `kiaansamir` = https://github.com/kiaansamir/Nasa-SphereX-Challenge. Choose the submission repository, confirm it is public, and push the final state, including these documents. Local `main` currently matches `origin`. |
| Public application URL | ⬜ Human action | *[PUBLIC APP URL]*. The app currently runs locally only; no hosting configuration exists in the repository. The host must serve `index.html` for `/explorer` (SPA fallback). |
| Hosting verification | ⬜ Human action | After deploying: confirm the backend can reach IRSA, CDS and ESA/GAVO; confirm `/api/health` responds; load Barnard's Star end to end; test on a phone. Note that the disk cache starts empty on a new host, so first loads are slow. |
| Demo video | ⬜ Human action | *[DEMO VIDEO URL]*. Record it with the cache already filled (load each target once first). The README *Screenshots and demonstration* section has a suggested walk-through. |
| Screenshots | 🟡 Draft | Six Explorer screenshots of real data (dark theme) and three real SPHEREx frames are on the homepage (`frontend/public/media/`). ⬜ Choose the screenshots for the submission form; optionally capture the light theme with `CAPTURE_THEME=light node scripts/capture-home-media.mjs`. |

## Repository state

| Item | Status | Where / what remains |
|---|---|---|
| README | ✅ Done | Rewritten from the implementation. |
| Installation instructions (Windows) | ✅ Done | README *Installation*, with `start.bat` and manual steps. ⬜ Test on a clean Windows machine. |
| Final regression results | ✅ Done (2026-11-15) | Backend 90/90; browser 227/227 in two consecutive full runs; type check, lint and build clean. ⬜ Re-run `npm run test:all` (in `frontend/`, with both servers running) after any further change and before submitting. |
| Uncommitted work | ⬜ Human action | The updated `README.md` and the new `docs/` folder are uncommitted. Review, commit and push them. All application code is committed. |
| Synthetic vs real data labelling | ✅ Done | Demo mode is labelled in the interface, README, methods and data sources. |

## Before you press submit

1. Complete every ⬜ and 🟡 item above.
2. Run `npm run test:all` and record the result.
3. Read the README top to bottom as a non-specialist would.
4. Check that no document claims a discovery or implies NASA endorsement.
