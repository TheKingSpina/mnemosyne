# Backup operations

These templates schedule a verified, encrypted PostgreSQL backup from the host. They are intentionally not installed automatically.

## Required host setup

1. Copy the repository to a stable path.
2. Create a protected backup directory and passphrase file outside the repository.
3. Create an environment file with mode `0600` containing the placeholders below.
4. Install only the template for the host operating system.
5. Verify one manual run before enabling the schedule.

The backup command keeps local retention, writes a manifest, and restores into a temporary database for verification. Copy both the `.dump` artifact and its `.manifest.json` to encrypted external storage after a successful run.

## Environment variables

```text
MNEMOSYNE_REPO=/absolute/path/to/mnemosyne
MNEMOSYNE_BACKUP_DIR=/absolute/path/to/backups
MNEMOSYNE_BACKUP_PASSPHRASE_FILE=/absolute/path/to/mnemosyne-backup.pass
MNEMOSYNE_BACKUP_ENV_FILE=/absolute/path/to/mnemosyne-backup.env
```

## macOS launchd

Replace placeholders in `launchd/com.mnemosyne.backup.plist`, copy it to `~/Library/LaunchAgents/`, then run:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mnemosyne.backup.plist
```

## Linux systemd

Copy `systemd/mnemosyne-backup.service` and `systemd/mnemosyne-backup.timer` to `/etc/systemd/system/`, replace placeholders, then run:

```bash
systemctl daemon-reload
systemctl enable --now mnemosyne-backup.timer
```

Inspect failures with `journalctl -u mnemosyne-backup.service`. Never put database passwords, provider keys, or the backup passphrase in the repository or in the unit files.
