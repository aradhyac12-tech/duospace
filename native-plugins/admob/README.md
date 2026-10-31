# duospace-admob (local Capacitor plugin)

Draws one adaptive banner (Android). Whether an ad is allowed is decided only by
`src/lib/monetization/adPolicy.ts`; use `<AdSlot surface="..."/>`, never call this directly.

## One-time setup (needs network, so it was not done in the authoring sandbox)
1. AdMob console -> Apps -> Add app -> Android. You do NOT need a domain to create the app or
   serve ads. Answer "not published yet" if asked about a store listing; link it to the Play
   listing after the app is live. (`app-ads.txt` needs a developer website and is optional.)
2. Create a **Banner** ad unit. Note the App ID (`ca-app-pub-...~...`) and unit ID (`ca-app-pub-.../...`).
3. Register the plugin (this edits the lockfile, which must be done by `npm`, never by hand -
   see DEPLOYMENT_INVARIANTS.md):
   `npm install --save ./native-plugins/admob` then `npm run verify:lock && npm run build`
   then `npx cap sync android`.
4. In the Android app module add `res/values/duospace_admob.xml` with the SAME two string names
   and your real values (`duospace_admob_app_id`, `duospace_admob_test_banner_unit_id`), or leave
   the Google test ids in place while testing.
5. Set `VITE_ADMOB_BANNER_UNIT_ID` to your real banner unit for release builds, and
   `VITE_ADS_ENABLED=true`. Unset/false = no ads.
6. Play Console: update Data safety (advertising ID) and the Ads declaration; the SDK adds the
   `AD_ID` permission. If you have users in the EEA/UK, add Google's consent form (UMP) first.
7. Test on a device with test ids. Never tap your own live ads.
