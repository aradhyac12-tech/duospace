package com.duospace.appupdate

import androidx.core.content.FileProvider

/**
 * Distinct subclass so the manifest merger treats this provider as a different
 * component from the app's own androidx.core.content.FileProvider. Providers
 * are merged by android:name; sharing the stock class name causes a merge
 * conflict on authorities / FILE_PROVIDER_PATHS.
 */
class AppUpdateFileProvider : FileProvider()
