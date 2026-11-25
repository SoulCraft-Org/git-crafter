# Active and unused audit

Part of the [Projects setup](README.md). The [setup check](check-card.md) reads what is set. This audit lists what is switched on and never used, so no seat, credit or lane sits idle. It reads and records. It switches nothing off.

```mermaid
flowchart LR
  L[List what is on] --> U{Used since the last audit?}
  U -->|yes| K[Keep: note who uses it]
  U -->|no, free| R[Record it]
  U -->|no, billed| I[One issue: keep or end]
```

## What to list

| Kind | Active means | Used means | Read from |
|---|---|---|---|
| Plan or seat | Assigned and billed or included | A session ran under it | The vendor's usage page |
| API credit | Granted, not expired | A job drew on it | The console's credit page |
| Cloud environment | Attached to the project | A thread ran in it | Project settings, Usage |
| Connector or plugin | Connected | A thread called a tool | A thread's tool list |
| Paid repo feature | A licence is assigned | The feature produced a finding or a run | The repo's settings page |
| Free-tier lane | Signed up | A job ran on it | The lane's dashboard |

## Reads that need a Mac

A cloud thread cannot read these. A local thread (Remote Control) reads each and changes none.

| Read | Why local |
|---|---|
| Folders Claude may use without asking | The list sits in the desktop app |
| Permission mode and deny rules | They sit in the user's settings file |
| Installed plugins and their source | They sit in the user's Claude folder |
| Each clone's branch and state | The clone sits on the disk |
| A web settings page the cloud tool refuses | Claude in Chrome reads it from the Mac |

## Result

One row per item: item, active, used, read (UTC), source, then keep, record or issue. A row not read is marked "not read", never a guess.
