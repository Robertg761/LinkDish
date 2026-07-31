package com.linkdish.app
import expo.modules.splashscreen.SplashScreenManager

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import java.net.URLEncoder
import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setIntent(rewriteSendIntent(intent))
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)
  }

  override fun onNewIntent(intent: Intent) {
    val rewrittenIntent = rewriteSendIntent(intent)
    setIntent(rewrittenIntent)
    super.onNewIntent(rewrittenIntent)
  }

  private fun rewriteSendIntent(sourceIntent: Intent): Intent {
    if (sourceIntent.action != Intent.ACTION_SEND) {
      return sourceIntent
    }

    val mimeType = sourceIntent.type

    if (mimeType?.startsWith("image/") == true) {
      val sharedImageUri = getSharedImageUri(sourceIntent)

      if (sharedImageUri != null) {
        val encodedImageUri = URLEncoder.encode(sharedImageUri.toString(), "UTF-8")
        val encodedMimeType = URLEncoder.encode(mimeType, "UTF-8")
        val importUri = Uri.parse("linkdish://import-progress?imageUri=$encodedImageUri&mimeType=$encodedMimeType")
        sourceIntent.setAction(Intent.ACTION_VIEW)
        sourceIntent.setData(importUri)
        sourceIntent.setPackage(packageName)
        sourceIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        if (sourceIntent.clipData == null) {
          sourceIntent.clipData = ClipData.newRawUri("Shared recipe image", sharedImageUri)
        }

        return sourceIntent
      }
    }

    val sharedText = sourceIntent.getStringExtra(Intent.EXTRA_TEXT)?.trim()

    if (!sharedText.isNullOrEmpty()) {
      val encodedText = URLEncoder.encode(sharedText, "UTF-8")
      val importUri = Uri.parse("linkdish://import-progress?text=$encodedText")
      sourceIntent.setAction(Intent.ACTION_VIEW)
      sourceIntent.setData(importUri)
      sourceIntent.setPackage(packageName)
      return sourceIntent
    }

    return sourceIntent
  }

  @Suppress("DEPRECATION")
  private fun getSharedImageUri(sourceIntent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      sourceIntent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      sourceIntent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
