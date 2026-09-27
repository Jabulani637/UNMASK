# Unmask — Specification of Changes (v2: Multi-Institution Expansion)

**Purpose of this document:** capture exactly what changed from the original CPUT-only design to the multi-institution version, so the existing requirements, brief, and architecture docs can be updated consistently. This is a diff, not a replacement — anything not mentioned here stays as originally specified.

---

## 1. Summary of the change

The platform is no longer CPUT-only. It now supports multiple tertiary institutions — universities **and** TVET colleges — starting with a 5-institution pilot in Cape Town. Users explicitly state which institution(s) they want to be matched with, ranked by preference, rather than the system assuming they only want their own campus.

---

## 2. What's replaced vs. what's new

| Original design | Replaced with |
|---|---|
| `Profile.campus` (free-text string, CPUT campuses only) | `Profile.institutionId` (reference to `Institution`) |
| Single hardcoded email domain check | `Institution.emailDomains` — per-institution verified list |
| Automatic "same campus as me" scoring bonus | Explicit, user-stated `preferredInstitutions` ranking (see §4) |
| Homepage hero: static "Find someone at CPUT…" | Homepage hero: dynamic, institution name driven by the visitor's own pick (see §3) |

---

## 3. Landing page: the dynamic hero

**What it does:** the headline itself becomes the first input, not just marketing copy.

> "Find someone at **[ dropdown: UWC ▾ ]** before you see their face."

- The dropdown lists the 5 pilot institutions plus "Anywhere in Cape Town" (maps to "no preference").
- Selecting an option live-updates the headline text — no page reload.
- Whatever is selected here is carried into onboarding as **rank 1** of `preferredInstitutions`. The user can change, reorder, or clear it once they reach the full ranked-preference step.
- This replaces every "CPUT" reference in the current homepage copy (hero, sticker tags, FAQ answers) with either the dynamic value or institution-neutral language.

**Sticker tags** ("CPUT ONLY" etc.) update to reflect the new scope — e.g. "CAPE TOWN STUDENTS" instead of a single-institution claim, since the platform is no longer single-institution.

---

## 4. Onboarding: ranked institution preference

**New profile field:**

```
preferredInstitutions: [
  { institutionId: ObjectId, rank: 1 },
  { institutionId: ObjectId, rank: 2 },
  { institutionId: ObjectId, rank: 3 }
]
```

- Maximum of **3** ranked preferences.
- Rank 1 is pre-filled from the landing-page pick; the user can add up to 2 more, reorder them, or clear all of them back to "no preference" (empty array = open to any institution).
- This field is distinct from `institutionId` on the profile — a user's *own* institution and the institution(s) they want to be matched with are no longer assumed to be the same thing.

---

## 5. Matching engine: scoring changes

The flat same-campus bonus from the original design is **removed entirely** and replaced by a preference-rank bonus:

| Signal | Points | Notes |
|---|---|---|
| Interest overlap (Jaccard) | 60 | unchanged in method, weight reduced slightly |
| Age proximity | 20 | unchanged |
| Institution preference match | up to 14 | rank 1 match = 14, rank 2 match = 9, rank 3 match = 5, no match or "no preference" = 0 |
| Same city | 6 | new tier — applies regardless of institution match, since two people in the same city are realistically meetable even without an institution match |

**Worked example:** User A ranks UWC #1, CPUT #2. Candidate B attends CPUT. B scores the rank-2 bonus (9 points) toward the preference tier, plus whatever interest/age/city points apply independently.

All hard filters from the original matching engine requirements (gender/looking-for compatibility, block list, active-match exclusion, 30-day decline cooldown) are unchanged and still apply before scoring runs.

---

## 6. Institution model (replaces the university-only concept)

```
Institution {
  _id,
  name,               // e.g. "University of the Western Cape"
  shortName,          // e.g. "UWC"
  type: "university" | "tvet",
  city,
  emailDomains: [String],
  isActive: Boolean
}
```

`type` exists specifically because Northlink (TVET) is now in scope alongside universities — this field lets future filtering or copy ("students & TVET learners") differ by type if needed, without a schema change later.

---

## 7. Pilot institution list (v1 launch)

| Institution | Type | City |
|---|---|---|
| CPUT | University | Cape Town |
| University of Cape Town (UCT) | University | Cape Town |
| University of the Western Cape (UWC) | University | Cape Town |
| Stellenbosch University | University | Stellenbosch |
| Northlink College | TVET | Cape Town |

All five share the same city tier for now — cross-city scoring differentiation only becomes visible once a non-Cape Town institution is added in a later phase.

---

## 8. Downstream doc updates needed

- **`unmask-requirements.md`** — replace CPUT-specific FRs (email domain, campus field) with institution-model equivalents; add FR/NFR entries for the ranked-preference feature and the revised scoring table above.
- **`unmask-project-brief.md`** — update target users from "CPUT students" to "students and TVET learners at partner Cape Town institutions," and update the MVP scope line for matching.
- **`unmask-file-architecture-v2.md`** — `Profile.campus` → `Profile.institutionId`; add `Institution` model; add `preferredInstitutions` to the profile schema section.
- **Live site copy** — homepage hero, sticker tags, and FAQ answers referencing "CPUT" need the dynamic/neutral rewrite described in §3.

## 9. Explicitly out of scope for this change

- Institutions outside Cape Town (later phase, once cross-city scoring has real data to validate against)
- Self-service institution submission by users — additions stay manually curated by you, per the earlier decision
- Any weighting of `type` (university vs. TVET) in scoring — a TVET and a university match score identically; `type` is metadata only for now
