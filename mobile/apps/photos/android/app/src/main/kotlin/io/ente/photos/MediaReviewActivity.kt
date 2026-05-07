package io.ente.photos

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.MimeTypeMap
import io.flutter.embedding.android.FlutterFragmentActivity
import java.util.Locale

class MediaReviewActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val shouldHandleIntent = normalizeReviewIntent(intent)
        super.onCreate(savedInstanceState)
        if (!shouldHandleIntent) {
            finish()
        }
    }

    override fun onNewIntent(intent: Intent) {
        val shouldHandleIntent = normalizeReviewIntent(intent)
        super.onNewIntent(intent)
        if (shouldHandleIntent) {
            setIntent(intent)
        } else {
            finish()
        }
    }

    private fun normalizeReviewIntent(intent: Intent?): Boolean {
        val reviewIntent = intent ?: return false
        if (reviewIntent.action !in reviewActions) {
            return true
        }
        val uri = reviewIntent.data ?: reviewIntent.streamUri ?: return false
        val type = reviewIntent.type ?: resolveMimeType(uri) ?: return false
        if (!type.isSupportedReviewMimeType()) {
            return false
        }

        reviewIntent.action = Intent.ACTION_VIEW
        reviewIntent.setDataAndType(uri, type)
        return true
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
