# Clean My Machine

Find what's taking up space on your Mac and choose what to clear.

```sh
bunx clean-my-machine
```

## Use it

- **Scan for cleanup and review package updates** finds caches, logs, Xcode DerivedData, and old build artifacts. Review the files, select what to clear, then confirm. Afterward you can run Homebrew cleanup or upgrade and update global npm or Bun packages.
- **Map largest folders** shows where space is going on your home volume or an external drive. Drill into folders by size. The map is read-only.
- **Review Xcode simulator storage** shows devices and shared runtimes. You can preview cache, log, and temporary-file cleanup for one device. Shut it down before applying the cleanup.

## Commands

```sh
npx clean-my-machine categories
npx clean-my-machine scan --json --verbose
npx clean-my-machine clean --categories dev-cache --dry-run
npx clean-my-machine xcode scan
```

Use `--help` on any command to see its options. Scripted cleanup needs `--yes` to skip confirmation. Risky categories require `--risky` in the interactive menu or `--unsafe` with `clean`.

### Project builds

Pass `--root` to scope repository scanning to a workspace. Repeat it to add more roots. Node and Rust are scanned by default. Pass `--include go` to add Go.

```sh
npx clean-my-machine scan --live --root ~/Developer
npx clean-my-machine clean --categories node-build-artifacts --root ~/Developer --unsafe --dry-run --json
```

The repository scanner checks project markers and protects tracked files. Generic build folders like `dist` and `build` also need a matching Git ignore rule. Set `excludePaths` in your config or pass `--exclude` to keep specific paths.

### Config and backups

```sh
npx clean-my-machine config --init
npx clean-my-machine config --show
```

Cleanup deletes files permanently by default. Set `"backupEnabled": true` in `~/.maccleanerrc` to move supported files into a local backup instead. Run `backup --list` and `backup --restore <dir>` to recover files. Backups use disk space until you remove them. Homebrew and Docker handle their own cleanup.

## Develop

```sh
bun install
bun run dev
bun run test
bun run build
```

## License

[MIT](LICENSE). Based on [mac-cleaner-cli by Gustavo Costa](https://github.com/guhcostan/mac-cleaner-cli).
