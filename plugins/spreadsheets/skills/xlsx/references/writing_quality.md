# Writing Quality and Authored Content

Apply these defaults to text you write in workbooks, including titles, labels
and messages returned by formulas. User instructions and preferences,
reference/template conventions and domain guidance take precedence, in that
order. For edits, do not change unrelated content outside of the user's
request and follow the workbook's existing writing style.

- Write for the intended audience. Never include internal file paths, authoring commentary, planning notes, or requester instructions in the artifact unless explicitly requested. Do not repeat audience or style directives such as "executive-friendly" in headings, content, or comments.
  - Omit: `Discussion support only. This workbook does not make final rating or promotion decisions.` just because the user asked for a workbook for discussion.
  - Omit: `Supports discussion and consistency checks. Human reviewers remain responsible.` unless that limitation is explicitly required.

- Include text only when it helps the reader understand the data or use the workbook. Keep clear text unchanged. Rewrite useful text that is unclear. Delete unnecessary text instead of replacing it with a cleaner version of the same filler.

- Use concise, plain-language titles and labels. Name the specific subject, issue or action and avoid internal jargon and vague status labels. Preserve what each label measures, including the population, period, units, comparison, and uncertainty. Do not shorten a label by removing a distinction the reader needs.
  - Good: `Weekly metrics`. Bad: `Follow the weekly trends`
  - Use `Metric` for a general metric column and `Revenue driver` for a revenue assumption explanation. Avoid invented labels such as `Planning measure`, `Movement explanation` or `Planning basis`. Retain specific labels when they add necessary meaning.
  - Bad: `Requisition blockers`. Good: `Hiring requests awaiting approval` when approval is the issue.
  - Bad: `Two-band rating movement`. Choose a descriptive, clear phrase that represents the underlying event, e.g.:
    - Promotion: `Promoted by two job levels`
    - Rating change: `Performance rating increased by two levels`
  - Good: `Monthly results`. Bad: `Decision-ready monthly impact analysis`
  - Good: `Income and household assumptions`. Bad: `Same paycheck. Different purchasing power.`
  - Use `Retained employees` only for employees who remained over a defined period. Otherwise, name the population counted, such as `Total employees` or `Employees reviewed`.

- Avoid decorative bullets, icons, emoji, arrows and pipe-delimited titles. Omit filler suffixes; keep terms such as `review`, `analysis` or `dashboard` when they identify the content.
  - Bad: `$ in USD • monthly • forecast`
  - Good: `Monthly forecast (USD)`

- Prefer direct, specific human wording. Avoid slogans, buzzwords, invented terminology, vague framing and formulaic claims.
  - Good (when supported by the data): `Most revenue growth comes from data centers.` Bad: `Data centers are doing the heavy lifting.`
  - Good: `Contributions decreased`. Bad: `Contributions waned`
  - Good: `Revenue metrics`. Bad: `Strategic Value Drivers`
  - Bad formulaic phrasing: `The tool not only saves time, but also transforms how teams collaborate.` or `Faster, smarter, and more intuitive.`
  - Bad: `While remote work offers flexibility, it also presents unique challenges.` (synthetic balance without a real tradeoff)
  - Bad: `Operating evidence improved`. Operating evidence is unclear and not a common term used.

- Avoid AI-like sentence constructions. Use direct sentences with clear meaning and avoid vague explanations and forced contrasts. Prefer periods between sentences. Do not use semicolons, pipes, bullets, or dashes to assemble several labels into a slogan.
  - Semicolons and vague explanations: Use `Travel demand and employment fell from Jan to Feb.`, not `Travel demand and employment fell from Jan to Feb; persistent behavior shifts are shaping the path back.`.
  - Passive voice when active is clearer e.g. Use `The team approved the proposal.` not `The proposal was approved by the team.`
  - Contrast slogans like `It's not X, it's Y`: For a title, use `Humidity exposure over time` not `Humidity is an exposure trajectory, not a setpoint.`
  - Unnecessary em-dashes: Bad: `Purpose: isolate what changed – and what deliberately stayed in place – under Osaka Prefecture's Red Stage emergency response.`

- Keep wording factual, parseable and supported by the workbook.
  - Good: `Transit use is 79% of pre-pandemic levels.`
  - Bad: `79% Transit use back to pre-pandemic`

- Omit repeated information, obvious purpose statements and generic disclaimers. Subtitles are optional. State critical definitions and material assumptions once beside the relevant data or setting. Preserve task-required limits and warnings, such as a review supporting discussion rather than making final personnel decisions.

- Do not include motivational wording or self-assessment. Omit decorative badges and self-evaluation banners. Preserve task-required business statuses, risk flags, uncertainty labels and specific warnings as ordinary data. Do not invent scoring systems or confidence scales merely to decorate the workbook.
  - Omit: `This workbook is source-backed and ready for review`.

- For checks and logic, be specific:
  - Bad: `Signal integrity: BLOCKED`. Good: `Missing input: forecast rate` (a specific functional warning)

- For a requested workflow, provide an obvious editable field for required human input, separate from original source notes. Short calculated statuses or actions should reflect all required prerequisites. Do not imply completion while another required action is still open.
