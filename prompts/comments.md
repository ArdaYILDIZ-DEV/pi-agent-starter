---
description: Audit comments/docs against the language standard (py/go/c/sh). Comments-only diff.
argument-hint: "[files...]"
---
Read `~/.pi/agent/skills/comment-audit/SKILL.md` first. Detect the language of each target
file from its extension and read the matching `references/<lang>.md` before touching it.
Then audit per the skill: audit first, wrong-edit test, deletion pass, comments-only check,
report.

Target: `$@`
(If no target: the files changed in the working tree, or the files currently in context.)
