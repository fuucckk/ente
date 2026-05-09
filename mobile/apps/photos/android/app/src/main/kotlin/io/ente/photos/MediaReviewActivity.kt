package io.ente.photos

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.MimeTypeMap
import java.util.Locale

class MediaReviewActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        forwardIntent(intent)
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        forwardIntent(intent)
        finish()
    }

    private fun forwardIntent(intent: Intent?) {
        val viewIntent = normalizedViewIntent(intent) ?: return
        viewIntent.setClass(this, MainActivity::class.java)
        viewIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(viewIntent)
    }

    private fun normalizedViewIntent(intent: Intent?): Intent? {
        val reviewIntent = intent ?: return null
        if (reviewIntent.action !in reviewActions) {
            return Intent(reviewIntent)
        }
        val uri = reviewIntent.data ?: reviewIntent.streamUri ?: return null
        val type = reviewIntent.type ?: resolveMimeType(uri) ?: return null
        if (!type.isSupportedReviewMimeType()) {
            return null
        }

        return Intent(reviewIntent).apply {
            action = Intent.ACTION_VIEW
            setDataAndType(uri, type)
        }
    }

    private fun resolveMimeType(uri: Uri): String? {
        return typeFromContentResolver(uri) ?: typeFromExtension(uri)
    }

    private fun typeFromContentResolver(uri: Uri): String? {
        return try {
            contentResolver.getType(uri)
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: SecurityException) {
            null
        }
    }

    private fun typeFromExtension(uri: Uri): String? {
        val extension = uri.lastPathSegment
            ?.substringAfterLast('.', missingDelimiterValue = "")
            ?.lowercase(Locale.ROOT)
            ?.takeIf { it.isNotBlank() }
            ?: return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    }

    private fun String.isSupportedReviewMimeType(): Boolean {
        val normalizedType = lowercase(Locale.ROOT)
        return normalizedType.startsWith("image/") ||
            normalizedType.startsWith("video/")
    }

    private val Intent.streamUri: Uri?
        @Suppress("DEPRECATION")
        get() = getParcelableExtra(Intent.EXTRA_STREAM)

    private companion object {
        private const val ACTION_REVIEW = "android.provider.action.REVIEW"
        private const val ACTION_CAMERA_REVIEW = "com.android.camera.action.REVIEW"
        private val reviewActions = setOf(ACTION_REVIEW, ACTION_CAMERA_REVIEW)
    }
}
