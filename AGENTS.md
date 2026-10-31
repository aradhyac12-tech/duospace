<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Deployment

Before changing ANY build/deploy config (package.json, package-lock.json,
vite.config.ts, vercel.json, netlify.toml, wrangler.toml, native-plugins/),
read and obey [DEPLOYMENT_INVARIANTS.md](./DEPLOYMENT_INVARIANTS.md).
Always run `npm run verify:lock && npm run build` before pushing.

## Session delivery (owner rule)

When you work on an uploaded project zip, always hand back the updated zip at
the end of the session, before your token/context budget runs out (see
`.ai/IMPLEMENTATION_RULES.md` rule 11). Finish or park in-flight work, update
`.ai/CHANGELOG.md` and the session's `.ai/HANDOFF_*.md`, then build the zip
(exclude `node_modules/`, `dist/`, `.git/`).

## Session delivery rule
When working on an uploaded project zip, always deliver the updated zip at the end of the session (before tokens run out). Rule recorded here and in .ai/IMPLEMENTATION_RULES.md.
