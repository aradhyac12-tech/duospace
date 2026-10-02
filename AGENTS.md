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
