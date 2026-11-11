# CanvCleanup

A teacher-facing bookmarklet that lists every file in a Canvas course by folder, flags likely duplicates and files that are still linked in your content, and lets you soft-delete the ones you no longer need. The point is reclaiming course storage quota and keeping the files you actually use easy to find.

**Install page:** https://techconsigliere.github.io/CanvCleanup/teacher/install-filecleanup.html

It runs entirely in your own browser, in your own Canvas session, with your own permissions. No account, no access token, nothing stored. Deletes are soft deletes, restorable from Canvas's own Restore Deleted Items (`/undelete`) page.

## What it checks, and what it can't

Before it calls a file safe to delete, it looks for links from your syllabus, pages, assignments, discussions, announcements, Classic Quizzes (including quiz questions), and modules. It does **not** check New Quizzes, question banks, rubrics, calendar events, or external tools, and it says so in the tool. A file used only in one of those can show as unlinked, so review anything you're unsure about before deleting.

## Build

The bookmarklet is built from readable source, never hand-edited:

```
python3 build-bookmarklets.py     # teacher/filecleanup_src.js -> teacher/filecleanup.bookmarklet.txt
python3 design/tc_build.py        # inlines design/tc.css + the build into the install page
```

`&` is deliberately percent-encoded as `%26` in the build, because a bare `&` inside an HTML `href` becomes an entity the browser decodes when the bookmark is dragged, which would corrupt the code.

## Credit and license

Made by Chris Powell, a Canvas administrator in higher education, for Western Washington University. Written up at [Canvas Insider](https://www.canvasinsider.blog). Released under the [MIT License](LICENSE), free to use, modify, and share, including at your institution.
