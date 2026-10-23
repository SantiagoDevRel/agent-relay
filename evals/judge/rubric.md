# Spec rubric (Relay Evals, Layer 3)

Score only the text of the first prompt (the spec). Do not judge how the chat
ended. Each criterion is 0, 1 or 2; the total is 0 to 8.

## literal — Literal requirements

Are the literal requirements stated, one per item, preserved verbatim or clearly enumerated?

- **0:** No identifiable requirement: only a goal or a wish.
  Example: "Improve the settings page."
- **1:** Requirements are present but mixed into prose, merged or partly implicit.
  Example: "Add dark mode and also the export, and fix the date thing on the list."
- **2:** Each requirement is a separate, numbered or labeled item, kept in the user's own words.
  Example: "R1 Add a dark mode toggle. R2 Export the list as CSV. R3 Show dates as YYYY-MM-DD."

## acceptance — Observable acceptance

Does it say what observable result proves each requirement (behavior, numbers, screens), not just "make it work"?

- **0:** No observable result: "make it work", "fix it", "should be good".
  Example: "Fix the login so it works."
- **1:** Some observable results, but not for every requirement or not precise.
  Example: "Login should show an error when the password is wrong."
- **2:** Each requirement has a concrete observable result: values, states, screens or limits.
  Example: "Acceptance: a wrong password shows 'Invalid credentials' and returns 401; three failures lock the form for 60 s."

## scope — Scope limits

Does it set the boundaries: files or areas allowed or forbidden, what not to touch, authorization limits?

- **0:** No boundary: any file, any action.
  Example: "Refactor whatever you need."
- **1:** A partial boundary: an area is named, or one thing is off limits.
  Example: "Work in the billing module."
- **2:** Explicit allowed scope plus what must not be touched or done without asking.
  Example: "Only edit src/billing/ and its tests. Do not touch the database schema. Do not deploy or commit."

## verification — Verification

Does it say how the work will be verified: tests, commands, viewports, evidence to report?

- **0:** No verification is mentioned.
  Example: "Add the CSV export."
- **1:** Verification is mentioned in general terms only.
  Example: "Make sure it is tested."
- **2:** Specific checks and the evidence to report: commands, tests, viewports or screenshots.
  Example: "Run npm test and npm run lint; check the page at 390 px and 1440 px and report both screenshots."
