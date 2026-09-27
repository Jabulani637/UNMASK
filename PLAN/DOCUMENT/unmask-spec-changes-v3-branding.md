# Unmask — Change Brief: Neutral Branding & Fast-Scale Institution Model

**Supersedes:** §3 and §7 framing in `unmask-spec-changes-v2.md`. Everything else in that document still stands — this is a narrower follow-up, not a rewrite.

---

## 1. What's changing and why

The previous spec framed the platform around "Cape Town students" — the dropdown's no-preference option said "Anywhere in Cape Town," and the sticker tags implied a single-city product. That framing was accurate for the *pilot institution list*, but wrong as a branding decision: the plan is to scale by simply adding new institutions' email domains, not by re-architecting anything region by region. The copy shouldn't claim a geographic limit the product isn't actually designed to have.

**Principle going forward:** the pilot list (CPUT, UCT, UWC, Stellenbosch, Northlink) is an internal launch detail, not a marketing claim. Public-facing copy should read as national/institution-agnostic from day one, even while only 5 institutions are actually live.

---

## 2. Copy changes

| Element | Old | New |
|---|---|---|
| Hero no-preference option | "Anywhere in Cape Town" | "Any institution" |
| Sticker tag | "CPUT ONLY" / implied "Cape Town students" | "Verified students only" |
| FAQ: "Is this only for CPUT?" | Cape Town–specific answer | "We're live at a growing list of South African institutions — check the dropdown when you sign up. Don't see yours? [Request it]." |
| General homepage framing | Implied single-city | Institution-name-driven, no city claim anywhere |

The hero dropdown itself is unaffected — it still lists whichever institutions are actually live (currently the 5-institution pilot) plus "Any institution." Only the *labeling and surrounding copy* changes; the underlying pilot list from §7 of the previous doc is unchanged.

---

## 3. Scaling principle, made explicit

This formalizes what was already implied by the curated-whitelist decision, as a non-functional requirement worth stating plainly so it doesn't quietly erode as the product grows:

> **NFR-SCALE-1:** Adding a new institution to the platform shall require only a new `Institution` document (name, type, city, email domains) — no code change, no redeploy, no schema migration.

This is already true of the `Institution` model as designed. The only discipline required going forward is resisting the urge to hardcode any institution name, city, or region into frontend copy, validation logic, or scoring code — the "CPUT" hardcoding in the original hero is exactly the mistake this principle exists to prevent from happening again elsewhere.

**Practical checklist for anything that touches institutions:**
- [ ] Does this text/logic reference a specific institution or city by name?
- [ ] If yes — should it instead read from the `Institution` collection?

---

## 4. Optional, worth considering: a "request your institution" capture

Since scaling is meant to be fast and low-effort, a lightweight way to prioritize *which* institution to add next is worth having, even if it's just a simple form or a logged event when someone selects "my institution isn't listed" during signup. Not required for this change, but flagged here since it fits directly into the scaling principle above — you'd be using real demand signal instead of guessing which institution to whitelist next.

## 5. What did *not* change

- The pilot institution list itself (still CPUT, UCT, UWC, Stellenbosch, Northlink)
- The ranked-preference model and scoring table from the previous spec
- The manual, curated-whitelist approach to adding institutions (still no auto-accept of arbitrary `.ac.za` domains)
