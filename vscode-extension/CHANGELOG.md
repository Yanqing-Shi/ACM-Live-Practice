# Changelog

## 0.2.3

- Without control, the Explorer's New File, New Folder, Rename and Delete are greyed out. Before, you could type a name and were only refused on confirming.
- Typing in a locked editor now explains why and offers Request Control.

## 0.2.2

- **Request Control** is now next to the file tree: a key button in the Explorer's folder header, and an "ICPC Live" section in the Explorer side bar with a Request Control button and who has control. The section opens by itself when you join.
- A read-only room file shows a **Request Control** button at the top right of the editor.
- The status bar item is highlighted while you cannot edit.
- The member with control sees pending requests in the same Explorer section, with Give Control and Decline buttons.

## 0.2.1

- Each member now has their own window: the room folder is named after the team code and your name, for example `ZNA-MR7 (Alice)`. Joining the same room under a second name from the same VS Code opens a second window instead of sending you back to the first.
- Your name is shown in the window title, the Explorer, the status bar and the Room view.

## 0.2.0

- The room now opens as the window's folder: files are in VS Code's own Explorer, with its New File and New Folder buttons, inline rename, delete, and indentation.
- Typing is shared live without saving; saving no longer happens automatically.
- Files are locked by VS Code while you do not hold control or are offline.
- Your editor follows the file the controller switches to.
- Program input opens as an editor tab.
- Contest clock in the status bar, with any length from 1 minute to 30 days.
- Reconnects on its own and keeps your seat.
- `Ctrl+Enter` and an editor-title button run the open file.
- Ships as a single bundled file; `npm run package` builds an installable `.vsix`.
- Removed the separate workspace tree and the Room Actions panel.

## 0.1.0

- Works with the reworked server: team codes, per-seat session tokens (kept across restarts), and per-file update messages.
- Edits carry sequence numbers, so a room update that is older than your typing no longer replaces it.
- Create Room and the Room Actions view (added after 0.0.1 without a changelog entry).

## 0.0.1

- Initial VS Code extension skeleton.
- Added room join, workspace tree, members tree, virtual file system, and basic room commands.
