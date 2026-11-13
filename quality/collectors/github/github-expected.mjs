// The worked metric values for the GitHub collector's known-good fixture, shared by github.test.mjs and github-security.test.mjs.

// Worked by hand from the fixture; the comments give the arithmetic where it is not a count.
export const EXPECTED = {
  "issues.open_bugs": 2, // #6 and #8, typed Bug; #5 carries the bug label but no type
  "issues.parked_open": 1, // #5, no type, 3 days old; #7 is a Feature but exactly a day old, #6 and #8 are Bugs
  "issues.area_labeled": 71.4, // 5 of 7
  "issues.stray_labels": 2, // good first issue and wontfix; usability is an area label, dependencies is on 2 PRs, question is archived
  "issues.intake_ready": 66.7, // both forms parse and config.yml turns blank issues off; idea.yml sets no type
  "issues.closed_by_pr": 66.7, // #1 by a PR, #2 by a PR's commit, #4 by hand; #3 not planned is left out
  "issues.reopened": 33.3, // #2 of the 3 closed as completed; #3 not planned is left out
  "issues.latest_close_hours": 30, // #2, the latest closed as completed, after 30 hours
  "issues.oldest_open_days": 3, // #5
  // Issues #7 3, #6 0, #5 80, #4 2; #3 and #2 (footer only) are empty. Draft cards are not read
  "issues.latest_card_words": 0, // #6, the newest card: a Mermaid diagram, no prose
  "issues.card_visual_share": 50, // #7 table, #6 diagram, #4 image: 3 of the 6 issues; draft cards are not read
  "pull_requests.green_at_head": 66.7, // #17 has no checks and is left out
  "pull_requests.reviewed": 25, // #20 only; see the review test below
  "pull_requests.fixed_after_review": 50, // #18's first review read 8a8a…, then a fix moved its head; #20 merged as first reviewed
  "pull_requests.reverted": 1, // #19 reverts #17, 3.4 days after #17 merged
  "pull_requests.commits_via_pr": 75,
  "pull_requests.merged_off_default": 1, // #18 merged into feat/fixture-b; main is the default branch
  "pull_requests.latest_body_words": 3, // #20, the latest merge, its table left out
  "pull_requests.body_table_share": 25, // #20 alone of 4
  "pull_requests.linked_issue_share": 0, // none of the 4 links an issue; #17 has Closes #9 only inside a code fence
  "pull_requests.latest_lines": 105, // #20, the latest merge: 120 lines, 15 of them a data snapshot
  "pull_requests.over_400_lines": 25, // #18's 500 reviewed lines
  "pull_requests.latest_merge_hours": 1, // #20, the latest merged, an hour after it opened
  "pull_requests.green_to_merge_minutes": 90, // #20 green 10:30, merged 11:00 (30); #18 green 21:30, merged 00:00 (150); #19 red and #17 no checks are left out
  "pull_requests.open_now": 3,
  "pull_requests.green_waiting_minutes": 90, // #31 green at 18:30, read at 20:00; #12 and #30 are Dependabot's
  "pull_requests.conflicting": 1, // #12
  "pull_requests.oldest_open_days": 24,
  "pull_requests.dependabot_open": 2,
  "actions.pinned_share": 75, // 3 of 4; the local ./ action is left out
  "actions.permissions_share": 50,
  "actions.locked_share": 50, // good.yml is in actions.lock, loose.yml is not
  "projects.cards_by_column": 1, // two cards in Doing: the open pull request is being built, the empty draft is not
  "projects.done_with_pr": 66.7, // one Done card has no link
  "projects.workflows_on": 40, // the fixture board has Item closed and Pull request merged on, Item added off, Auto-add and Pull request linked not listed
  "projects.cards_at_a_glance": 20, // 5 open cards without the pull request: one issue card has a picture and few words; the other runs to 80 words; 3 drafts have no picture
  "projects.bug_cards": 2, // one open issue card carries the bug label, one is typed Task; the Done card typed Bug is not open
  "projects.closed_not_done": 0, // no closed issue card sits outside Done
  "projects.latest_cycle_hours": 12, // the card done 2026-11-02T00Z, 12 hours after its PR opened; the later card has no PR
  "projects.oldest_doing_days": 2.8, // the draft in Doing since 2026-10-31T00Z, read 68 hours later
  // GitHub's five features: the three paid ones are off, as on a private repo of a plan without them.
  "security.policy_on": 1,
  "security.dependabot_alerts_on": 1,
  "security.code_scanning_on": 0,
  "security.secret_scanning_on": 0, // push protection on, secret scanning off
  "security.code_quality_on": 0,
  "security.dependabot_open": 5, // the malware alert is counted apart
  "security.malware_open": 1,
  "security.code_scanning_open": "Code scanning is off, so it has no findings to count",
  "security.secret_scanning_open": "Secret scanning is off, so it has no findings to count",
  "security.code_quality_open": "Code quality is off, so it has no findings to count",
  "security.headers": 3, // Referrer-Policy missing
  "security.token_default_read": 1,
  "security.actions_policy_share": 50, // selected actions on, required SHA pins off
  "security.prt_head_checkouts": 0,
  "security.dependabot_cooldown": 0, // neither update entry sets a cooldown
  "security.lockfile_registry_share": "no package-lock.json with a packages map at the root",
  "security.young_lockfile_packages": "no package-lock.json with a packages map at the root",
  "security.threat_model_current": "params.threat_model_covers in targets/github.json is empty: list the paths the threat model covers, such as the Worker's",
  "security.claude_review_share": 50, // #20 by Claude's app, #18 by Claude's bot; #19 forged, #17 another app

  "security.latest_fix_days": 6, // the latest fix, Dependabot's of 2026-10-16, 6 days after it opened
  "security.oldest_open_alert_days": 32.8, // open since 2026-10-01T00:00Z
  "security.features_dollars_per_month": 0,
  "settings.main_protected": 1,
  "settings.required_checks": 2,
  "settings.dependabot_security_updates": 1,
  "settings.pages_private": 1,
  "settings.dependabot_grouping": 50,
};
