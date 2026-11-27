![Clean My Machine. Find your biggest folders.](.README/cover.png)

Find what's taking up space on your Mac and choose what to clear.

```sh
bunx clean-my-machine
```

- Scan for caches, logs, and old build files. Choose what to delete, then review Homebrew, npm, and Bun updates.
- Review older Git worktrees and confirm removal of eligible clean checkouts.
- Browse your largest folders by size, including on external drives.
- See what Xcode simulators are using. Shut down a simulator before clearing its caches, logs, or temporary files.

## Commands

```sh
bunx clean-my-machine scan
bunx clean-my-machine clean --categories dev-cache --dry-run
bunx clean-my-machine scan --live --root ~/Developer
```

Use `--help` for more commands and options. Cleanup deletes files permanently by default. To keep backups of supported files, run `bunx clean-my-machine config --init` and set `"backupEnabled": true` in `~/.maccleanerrc`.

## Develop

```sh
bun install
bun run dev
bun run test
```

## License

[MIT](LICENSE). Based on [mac-cleaner-cli by Gustavo Costa](https://github.com/guhcostan/mac-cleaner-cli).
