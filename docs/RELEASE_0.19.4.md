# 0.19.4: Following moved mail

Two refinements to how UniHub follows mail that was moved in another app.

### Fixed

- UniHub acts on the copy of a message it saw most recently, so a star or
  move no longer fails when an older copy was deleted meanwhile.
- Retry on a Download account no longer changes the message's folder.

### Upgrade

- Pull and restart. No database upgrade and no configuration change.
