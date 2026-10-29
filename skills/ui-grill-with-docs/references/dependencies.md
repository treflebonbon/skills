# Dependencies and source

The interview and domain-recording workflow uses the third-party `grilling` and `domain-modeling` skills. Load them from their official distribution before starting an interview. `codebase-design` is needed only when the discussion reaches module interfaces or seams. These skills are not bundled or forked here.

The currently recorded upstream source is [mattpocock/skills at `49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336). This commit identifies the separate skills' source; it does not install or copy them. Use the runtime's official skill or plugin installation path.

`playwright-cli` is an optional, separately installed dependency for opening the generated sheet in a browser. Creating the self-contained HTML and asking the human to open its file link does not require it. If browser display is unavailable, keep the existing fallback: provide the file link and explain that answers can be pasted from the sheet.

The template, inline answer script, and round-question example are packaged at `assets/round.html`. The HTML uses no network resources and needs no build step. Write each session's sheet below task-owned scratch space outside the installed plugin.
