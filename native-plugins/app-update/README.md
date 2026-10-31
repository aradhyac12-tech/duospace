# duospace-app-update

Android in-app APK update for **sideloaded** DuoSpace builds (see
`docs/OTA_APP_UPDATES.md`). Not for Google Play builds: Play forbids an app from
updating itself by any means other than Play, and `REQUEST_INSTALL_PACKAGES` is a
restricted permission there. The JS layer disables self-update automatically
when the installer is `com.android.vending`, but a Play upload should still be
built without this plugin (see the doc).
