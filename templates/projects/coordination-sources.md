# Coordination: the docs behind each choice

Part of [coordination.md](coordination.md). Every page was read on 2026-11-25.

| Question | The page says | Page, read 2026-11-25 | What follows |
|---|---|---|---|
| Can a project reach another? | "A project belongs to one user." and "A thread belongs to the one project that started it." No message route between projects. | Claude Code, Projects. | The rule sits in GitHub and in each project's instructions |
| Can a cloud session reach a board? | "Claude can't reach GitHub APIs that exist only in GraphQL, such as Projects v2, through the proxy." | Claude Code, cloud environments. | An issue is the claim, set over REST. A board is only the view |
| Is the environment shared? | On a network change, "its existing sessions follow the new setting within about a minute." | Claude Code, cloud environments. | An environment edit reaches other projects' running sessions, so it is a shared change |
| Where do Owner project and Target live? | Up to 25 issue fields per org, applied across all repositories. | GitHub, managing issue fields. | Org-level issue fields, so a claim from a cloud session carries them. A project-only field would stay empty |
| How does a claim reach the board? | "Existing items matching your criteria will not be added." One workflow filters on a label and targets a repo. | GitHub, adding items automatically. | One auto-add workflow on the label. Claims that exist before it are added once by hand |
| Is a claim a lock? | No page offers a lock, and two sessions can both look and both open | None | List again after opening. The lower number holds the target |

Sources: [Claude Code, Projects](https://code.claude.com/docs/en/claude-projects), [Claude Code, cloud environments](https://code.claude.com/docs/en/cloud-environments), [GitHub, managing issue fields](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields-in-your-organization), [GitHub, adding items automatically](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically).
