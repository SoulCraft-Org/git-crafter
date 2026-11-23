# Maintainers

| Maintainer | GitHub | Since | Can |
|---|---|---|---|
| <Name>, <role> | @<login> | <year> | Everything: merge any PR, promote to production, change these rules |

AI agents review and merge AI-mergeable PRs (`merge_policy.json`, beside `tools/merge_policy.py`). They are not maintainers: they never approve a PR and never change the rules they follow.

To become one, see [`GOVERNANCE.md`](GOVERNANCE.md#the-maintainer-seat).

```mermaid
flowchart LR
  C[Contributor<br/>five merged PRs in three months] -->|asks| O[Owner decides]
  O --> S[Maintainer seat]
  S -->|steps down, six months with no review,<br/>or the owner ends it| E[Seat ends]
```
