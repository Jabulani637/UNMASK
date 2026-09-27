# Unmask — Functional & Non-Functional Requirements

**Product:** Unmask — anonymity-first matching platform for CPUT students
**Version:** 1.0 (Draft)
**Prepared for:** CPUT student dating platform project

---

## 1. Purpose & Scope

Unmask is a web-based matching platform exclusively for Cape Peninsula University of Technology (CPUT) students. Unlike photo-first dating apps, Unmask matches users on stated preferences and interests, and keeps identity (name, photo) hidden until both matched users mutually consent to a "reveal." This document defines what the system must do (functional requirements) and the qualities it must have while doing it (non-functional requirements).

---

## 2. Functional Requirements

### 2.1 Account Registration & Verification

| ID | Requirement |
|----|-------------|
| FR-1.1 | The system shall allow a user to register using a valid CPUT student email address (e.g. `@mycput.ac.za`). |
| FR-1.2 | The system shall verify student status via a confirmation link sent to the CPUT email before the account is activated. |
| FR-1.3 | The system shall require users to be 18 years or older, self-attested at signup. |
| FR-1.4 | The system shall not require or display a user's legal name during registration. |
| FR-1.5 | The system shall allow a user to set a password and shall support a "forgot password" recovery flow via their verified email. |
| FR-1.6 | The system shall allow a user to delete their account and all associated data at any time. |

### 2.2 Profile Creation & Management

| ID | Requirement |
|----|-------------|
| FR-2.1 | The system shall allow a user to create a profile with: campus, faculty, year of study, gender, gender(s) they are looking for, age, an interest list, and one or more open-ended prompt answers. |
| FR-2.2 | The system shall allow a user to optionally upload a profile photo. |
| FR-2.3 | If a photo is uploaded, the system shall keep it hidden (not rendered to other users, including in blurred form beyond a generic placeholder) until a mutual reveal has occurred between the two specific matched users. |
| FR-2.4 | The system shall allow a user to edit their profile fields, interests, and prompt answers at any time. |
| FR-2.5 | The system shall allow a user to replace or remove their uploaded photo at any time. |
| FR-2.6 | The system shall never display a user's real name, student number, or contact details on their profile. |
| FR-2.7 | The system shall validate that a profile has a minimum set of completed fields (e.g. at least 2 interests, one completed prompt) before it becomes eligible for matching. |

### 2.3 Matching

| ID | Requirement |
|----|-------------|
| FR-3.1 | The system shall generate match suggestions based on shared interests, stated age range/preference, and mutual gender preference compatibility. |
| FR-3.2 | The system shall present one suggested match at a time, rather than a browsable list or swipe deck. |
| FR-3.3 | The system shall allow a user to decline a suggested match and receive the next-best suggestion. |
| FR-3.4 | The system shall not suggest a match to two users who have already matched, are already chatting, or have blocked each other. |
| FR-3.5 | The system shall recompute or refresh match suggestions when a user updates their profile or preferences. |
| FR-3.6 | The system shall display a compatibility indicator (e.g. percentage or shared-interest tags) with each suggested match, without revealing identity-linked information. |

### 2.4 Anonymous Messaging

| ID | Requirement |
|----|-------------|
| FR-4.1 | The system shall open a private, anonymous chat thread when a user chooses to start chatting with a suggested match. |
| FR-4.2 | The system shall display messages in real time (or near-real time) to both participants of a chat thread. |
| FR-4.3 | The system shall not display either participant's name or photo within the chat interface prior to a mutual reveal. |
| FR-4.4 | The system shall allow a user to end/leave a chat at any time without notifying the other party of the reason. |
| FR-4.5 | The system shall retain chat history for a user until they delete the conversation or their account. |
| FR-4.6 | The system shall allow a user to report or block another user directly from within a chat thread. |

### 2.5 Reveal Mechanism

| ID | Requirement |
|----|-------------|
| FR-5.1 | The system shall allow either participant in a chat to send a "reveal request." |
| FR-5.2 | The system shall only unlock both users' name and photo (if provided) once **both** participants have independently consented to the reveal. |
| FR-5.3 | The system shall notify a user when their chat partner has requested a reveal, without forcing an immediate response. |
| FR-5.4 | The system shall allow a user to decline or ignore a reveal request without ending the chat. |
| FR-5.5 | The system shall allow a user to revoke consent before the other party has also consented, cancelling the pending reveal. |
| FR-5.6 | Once revealed, the system shall continue the same chat thread with identities now visible to both parties. |

### 2.6 Safety & Moderation

| ID | Requirement |
|----|-------------|
| FR-6.1 | The system shall allow a user to report another user's profile, prompt content, photo, or chat messages. |
| FR-6.2 | The system shall allow a user to block another user, immediately preventing further matching or messaging between them. |
| FR-6.3 | The system shall provide an admin/moderation interface to review reported content and suspend or ban accounts. |
| FR-6.4 | The system shall automatically flag uploaded photos and prompt text for manual or automated review before they become visible to a match (e.g. basic content screening). |
| FR-6.5 | The system shall log moderation actions (reports, blocks, suspensions) for audit purposes. |

### 2.7 Notifications

| ID | Requirement |
|----|-------------|
| FR-7.1 | The system shall notify a user (in-app, and optionally by email) when they receive a new match suggestion. |
| FR-7.2 | The system shall notify a user of new chat messages when they are not actively viewing the thread. |
| FR-7.3 | The system shall notify a user when a reveal request is received or when a mutual reveal completes. |
| FR-7.4 | The system shall allow a user to configure or disable non-essential notifications. |

### 2.8 Administration

| ID | Requirement |
|----|-------------|
| FR-8.1 | The system shall provide administrators with the ability to view aggregate platform statistics (e.g. active users, match rate, reveal rate) without exposing individual chat content unnecessarily. |
| FR-8.2 | The system shall provide administrators with tools to manually verify or revoke a user's student status. |
| FR-8.3 | The system shall allow administrators to remove content or accounts that violate platform guidelines. |

---

## 3. Non-Functional Requirements

### 3.1 Performance

| ID | Requirement |
|----|-------------|
| NFR-1.1 | The system shall generate a match suggestion within 3 seconds of a user request under normal load. |
| NFR-1.2 | Chat messages shall be delivered to the recipient within 2 seconds under normal network conditions. |
| NFR-1.3 | The system shall support at least 2,000 concurrent active users without perceptible degradation, scaling to CPUT's full student population (~35,000) over time. |

### 3.2 Security

| ID | Requirement |
|----|-------------|
| NFR-2.1 | All data in transit shall be encrypted using TLS 1.2 or higher. |
| NFR-2.2 | User passwords shall be stored using a salted, industry-standard hashing algorithm (e.g. bcrypt or Argon2) — never in plain text. |
| NFR-2.3 | Uploaded photos shall be stored with access control such that they are retrievable only by the authorized backend, not via guessable public URLs, until a valid reveal has occurred. |
| NFR-2.4 | The system shall implement rate limiting on login, registration, and messaging endpoints to mitigate abuse and brute-force attacks. |
| NFR-2.5 | The system shall log and monitor for suspicious account behaviour (e.g. mass reporting, rapid account creation) to detect fake or bot accounts. |

### 3.3 Privacy

| ID | Requirement |
|----|-------------|
| NFR-3.1 | The system shall comply with South Africa's Protection of Personal Information Act (POPIA), including lawful processing, purpose limitation, and data subject access/deletion rights. |
| NFR-3.2 | The system shall not share, sell, or expose user data to third parties without explicit consent. |
| NFR-3.3 | A user's real identity (name, photo) shall never be inferable by another user before a valid mutual reveal, including via metadata, timestamps, or indirect profile clues introduced by the system itself. |
| NFR-3.4 | The system shall provide a clear, accessible privacy policy describing what data is collected and how it is used. |
| NFR-3.5 | Deleted accounts and their associated data shall be permanently removed from active systems within 30 days, except where retention is legally required. |

### 3.4 Usability

| ID | Requirement |
|----|-------------|
| NFR-4.1 | A new user shall be able to complete registration and profile creation in under 5 minutes. |
| NFR-4.2 | The interface shall be fully responsive and usable on mobile devices, given the majority of students will access it via phone. |
| NFR-4.3 | The system shall meet WCAG 2.1 AA accessibility standards, including keyboard navigation and screen-reader compatibility. |
| NFR-4.4 | Error messages (e.g. failed login, invalid email domain) shall be clear, specific, and actionable. |

### 3.5 Reliability & Availability

| ID | Requirement |
|----|-------------|
| NFR-5.1 | The system shall maintain 99.5% uptime, excluding scheduled maintenance windows. |
| NFR-5.2 | The system shall perform automated daily backups of user data, with tested restore procedures. |
| NFR-5.3 | The system shall gracefully degrade (e.g. disable matching temporarily) rather than fail completely if a non-critical subsystem (e.g. notifications) goes down. |

### 3.6 Scalability & Maintainability

| ID | Requirement |
|----|-------------|
| NFR-6.1 | The system architecture shall support horizontal scaling of the matching and messaging services independently as user load grows. |
| NFR-6.2 | The codebase shall follow a documented style guide and include automated tests covering core flows (registration, matching, chat, reveal). |
| NFR-6.3 | The system shall support deployment of updates without extended downtime (e.g. via rolling deployments). |

### 3.7 Compatibility

| ID | Requirement |
|----|-------------|
| NFR-7.1 | The web application shall function correctly on the latest two major versions of Chrome, Safari, Firefox, and Edge. |
| NFR-7.2 | The system shall be designed to allow a future native mobile app (iOS/Android) to consume the same backend API. |

### 3.8 Legal & Ethical Compliance

| ID | Requirement |
|----|-------------|
| NFR-8.1 | The system shall restrict registration to verified CPUT students only, as its core eligibility rule. |
| NFR-8.2 | The system shall include age verification (18+) consistent with South African law on data processing consent. |
| NFR-8.3 | The system shall provide accessible terms of service outlining acceptable use, harassment policy, and consequences for violations. |

---

## 4. Assumptions & Constraints

- Users have a valid, active CPUT student email for verification.
- The platform is web-first; a native mobile app is a future consideration, not part of this scope.
- Content moderation for photos/text will initially rely on a combination of automated screening and manual admin review; a fully automated AI moderation pipeline is a future enhancement.
- Real-time messaging assumes a persistent backend connection (e.g. WebSockets) rather than polling, for NFR-1.2 to be met at scale.

## 5. Out of Scope (v1.0)

- Video or voice calling within the app.
- In-person meetup scheduling or location-sharing features.
- Payment processing or premium subscription tiers.
- Integration with external social media platforms.
